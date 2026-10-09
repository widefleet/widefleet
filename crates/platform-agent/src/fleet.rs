use crate::config::Configuration;
use futures_util::TryStreamExt;
use object_store::{ObjectStore, ObjectStoreExt, path::Path as ObjectPath};
use platform_core::{
    Error, Result,
    model::{
        Artifact, Binding, ConnectorPackage, Job, JobKind, PublishedApp, ReleaseModule,
        RuntimePackages,
    },
    sha256,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path},
    sync::Arc,
};
use tokio::process::Command;

fn storage_error(error: object_store::Error) -> Error {
    Error::invalid(format!("Fleet storage operation failed: {error}"))
}
fn prefix(job: &Job) -> String {
    format!("fleets/{}", job.fleet_id)
}
fn package_key(job: &Job, key: &str) -> String {
    format!("{}/r2/widefleet-packages/{key}", prefix(job))
}
fn resource(owner: &str, kind: &str, name: &str) -> String {
    format!(
        "r{}",
        &sha256(format!("{owner}/{kind}/{name}").as_bytes())[..40]
    )
}

fn capability(connector: &str, entrypoint: &str) -> String {
    format!(
        "C_{}",
        &sha256(format!("{connector}/{entrypoint}").as_bytes())[..40]
    )
}

fn native_crons(crons: &BTreeMap<String, BTreeSet<String>>) -> Vec<&str> {
    if crons.is_empty() {
        // celld 0.6.1 drops its reserved cron class for an empty schedule even
        // while its old alarm can still wake. A valid expression with no calendar
        // occurrence keeps the class registered so celld deletes that alarm.
        // February never has a 31st; this does not invoke an app or schedule work.
        vec!["0 0 31 2 *"]
    } else {
        crons.keys().map(String::as_str).collect()
    }
}

fn validate_connector_classes(connectors: &[ConnectorPackage]) -> Result<()> {
    let mut owners = BTreeMap::new();
    for connector in connectors {
        for binding in connector
            .configuration
            .pointer("/durable_objects/bindings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let class = binding
                .get("class_name")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Error::invalid("Invalid connector Durable Object declaration".into())
                })?;
            if class == "WidefleetWorkflowCatalog" {
                return Err(Error::invalid(
                    "Durable Object class WidefleetWorkflowCatalog is reserved for the app runtime"
                        .into(),
                ));
            }
            if let Some(owner) = owners.insert(class, &connector.name)
                && owner != &connector.name
            {
                return Err(Error::invalid(format!(
                    "Durable Object class {class} is declared by both {owner} and {}; selected connector packages must use unique class names",
                    connector.name
                )));
            }
        }
    }
    Ok(())
}

async fn read(store: &Arc<dyn ObjectStore>, key: &str) -> Result<Option<Vec<u8>>> {
    match store.get(&ObjectPath::from(key)).await {
        Ok(object) => Ok(Some(object.bytes().await.map_err(storage_error)?.to_vec())),
        Err(object_store::Error::NotFound { .. }) => Ok(None),
        Err(error) => Err(storage_error(error)),
    }
}
async fn put(store: &Arc<dyn ObjectStore>, key: &str, bytes: Vec<u8>) -> Result<()> {
    store
        .put(&ObjectPath::from(key), bytes.into())
        .await
        .map_err(storage_error)?;
    Ok(())
}
async fn remove_key(store: &Arc<dyn ObjectStore>, key: &str) -> Result<()> {
    match store.delete(&ObjectPath::from(key)).await {
        Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
        Err(error) => Err(storage_error(error)),
    }
}

pub struct Prepared {
    pub changed: bool,
    pub token: String,
    pub app: Option<PublishedApp>,
    pub probes: Vec<PublishedApp>,
    digest: String,
    packages: RuntimePackages,
}

pub async fn prepare(
    configuration: &Configuration,
    job: &Job,
    artifact: Option<Artifact>,
    packages: &RuntimePackages,
    directory: &Path,
    telemetry: Option<platform_core::model::TelemetryDestination>,
) -> Result<Prepared> {
    validate_connector_classes(&packages.connectors)?;
    if packages.runtime.protocol != 1 || packages.runtime.celld != crate::native::VERSION {
        return Err(Error::invalid(
            "Unsupported runtime installation protocol or celld version".into(),
        ));
    }
    let store = configuration.storage.resolve()?.object_store()?;
    let token_key = format!("{}/control-token", prefix(job));
    let token = match read(&store, &token_key).await? {
        Some(bytes) => {
            String::from_utf8(bytes).map_err(|error| Error::invalid(error.to_string()))?
        }
        None => {
            let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
            put(&store, &token_key, token.as_bytes().to_vec()).await?;
            token
        }
    };
    let mut current = Vec::new();
    let hosts = ObjectPath::from(package_key(job, "hosts/"));
    let objects = store
        .list(Some(&hosts))
        .try_collect::<Vec<_>>()
        .await
        .map_err(storage_error)?;
    for object in objects {
        if let Some(bytes) = read(&store, object.location.as_ref()).await? {
            current.push(serde_json::from_slice::<PublishedApp>(&bytes)?);
        }
    }
    let capabilities: BTreeSet<_> = packages
        .connectors
        .iter()
        .flat_map(|connector| {
            connector
                .entrypoints
                .iter()
                .map(|entrypoint| capability(&connector.name, entrypoint))
        })
        .collect();
    for app in &current {
        if app
            .capabilities
            .values()
            .any(|binding| !capabilities.contains(binding))
        {
            return Err(Error::invalid(format!(
                "Activate binding revocations for {} before removing connector entrypoints",
                app.hostname
            )));
        }
    }
    // Each activation attempt gets an immutable snapshot and a fresh worker key.
    let mut candidate = match artifact {
        Some(artifact) => Some(PublishedApp {
            artifact,
            version: uuid::Uuid::new_v4(),
            deployment_id: job.deployment_id.unwrap_or(job.id),
            hostname: job.hostname()?.to_owned(),
            native_bindings: BTreeMap::new(),
            capabilities: BTreeMap::new(),
            capability_revision: job
                .capabilities
                .as_ref()
                .map_or(0, |snapshot| snapshot.revision),
            network: job.network.clone().ok_or_else(|| {
                Error::invalid("An app deployment requires a network snapshot".into())
            })?,
            telemetry,
        }),
        None => None,
    };
    if let Some(app) = &mut candidate {
        if let Some(snapshot) = &job.capabilities {
            for (name, grant) in &snapshot.grants {
                let native = capability(&grant.connector, &grant.entrypoint);
                if !capabilities.contains(&native)
                    || name.starts_with("WIDEFLEET_")
                    || name == &app.artifact.metadata.assets.binding
                    || app
                        .artifact
                        .metadata
                        .bindings
                        .iter()
                        .any(|binding| binding.name() == name)
                {
                    return Err(Error::invalid(format!(
                        "Connector binding {name} is unavailable or collides with another binding"
                    )));
                }
                app.capabilities.insert(name.clone(), native);
            }
        }
        for module in &app.artifact.modules {
            if matches!(module.kind, platform_core::model::ModuleType::Sourcemap) {
                continue;
            }
            put(
                &store,
                &package_key(
                    job,
                    &format!("apps/{}/modules/{}", job.app_id()?, module.sha256),
                ),
                tokio::fs::read(directory.join(&module.name)).await?,
            )
            .await?;
        }
        for (path, entry) in &app.artifact.manifest {
            put(
                &store,
                &package_key(
                    job,
                    &format!("apps/{}/assets/{}", job.app_id()?, entry.hash),
                ),
                tokio::fs::read(directory.join("public").join(path.trim_start_matches('/')))
                    .await?,
            )
            .await?;
        }
    }
    // Retain the previous app's native bindings while its candidate is checked.
    // No user request is switched to the candidate until evaluation succeeds.
    if let Some(app) = &candidate {
        current.push(app.clone());
    }
    // Workflow code is pinned to immutable versions. Retain their resource
    // bindings until the owning app is deleted, without reviving subscriptions.
    let mut retained = Vec::new();
    for app_id in current
        .iter()
        .map(|app| app.artifact.app_id)
        .collect::<BTreeSet<_>>()
    {
        let versions = ObjectPath::from(package_key(job, &format!("workflow-versions/{app_id}/")));
        for object in store
            .list(Some(&versions))
            .try_collect::<Vec<_>>()
            .await
            .map_err(storage_error)?
        {
            if let Some(bytes) = read(&store, object.location.as_ref()).await? {
                let version: uuid::Uuid = serde_json::from_slice(&bytes)?;
                let snapshot = read(
                    &store,
                    &package_key(job, &format!("versions/{app_id}/{version}.json")),
                )
                .await?
                .ok_or_else(|| Error::invalid("Retained Workflow version is missing".into()))?;
                let app: PublishedApp = serde_json::from_slice(&snapshot)?;
                if app.artifact.app_id != app_id || app.version != version {
                    return Err(Error::invalid(
                        "Retained Workflow version does not match its app".into(),
                    ));
                }
                retained.push(app);
            }
        }
    }
    if packages.runtime.workflows != Some(1)
        && current.iter().chain(retained.iter()).any(|app| {
            app.artifact
                .metadata
                .bindings
                .iter()
                .any(|binding| matches!(binding, Binding::Workflow { .. }))
        })
    {
        return Err(Error::invalid(
            "This fleet requires an app runtime with Workflow protocol 1".into(),
        ));
    }
    let mut databases = BTreeMap::new();
    let mut buckets = BTreeMap::new();
    let mut namespaces = BTreeMap::new();
    let mut producers = BTreeMap::new();
    let mut consumers = BTreeMap::new();
    let mut previous_consumers = BTreeMap::new();
    let mut previous_queues = BTreeMap::new();
    let mut crons: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut previous_crons: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut queues = BTreeMap::new();
    let active_versions: BTreeSet<_> = current.iter().map(|app| app.version).collect();
    for app in current.iter_mut().chain(retained.iter_mut()) {
        let owner = app.artifact.app_id.to_string();
        for binding in &app.artifact.metadata.bindings {
            let (name, kind, id) = match binding {
                Binding::PlainText { .. } | Binding::Workflow { .. } => continue,
                Binding::D1 {
                    name,
                    database_name,
                    database_id,
                } => (name, "d1", database_id.as_ref().unwrap_or(database_name)),
                Binding::R2Bucket { name, bucket_name } => (name, "r2", bucket_name),
                Binding::KvNamespace { name, id } => (name, "kv", id),
                Binding::Queue { name, queue } => (name, "queue", queue),
            };
            let id = resource(&owner, kind, id);
            let native = format!("B_{id}");
            app.native_bindings.insert(name.clone(), native.clone());
            match kind {
                "d1" => {
                    databases.insert(
                        native.clone(),
                        json!({ "binding": native, "database_name": id, "database_id": id }),
                    );
                }
                "r2" => {
                    buckets.insert(
                        native.clone(),
                        json!({ "binding": native, "bucket_name": id }),
                    );
                }
                "kv" => {
                    namespaces.insert(native.clone(), json!({ "binding": native, "id": id }));
                }
                "queue" => {
                    producers.insert(native.clone(), json!({ "binding": native, "queue": id }));
                }
                _ => unreachable!(),
            }
        }
        if !active_versions.contains(&app.version) {
            continue;
        }
        // Keep old native bindings available during candidate evaluation, but
        // build final event subscriptions from the candidate's declaration.
        // The validation deployment below retains the old subscriptions.
        let superseded = candidate.as_ref().is_some_and(|next| {
            app.artifact.app_id == next.artifact.app_id && app.version != next.version
        });
        let is_candidate = candidate
            .as_ref()
            .is_some_and(|next| next.version == app.version);
        for cron in &app.artifact.metadata.crons {
            if !is_candidate {
                previous_crons
                    .entry(cron.clone())
                    .or_default()
                    .insert(app.hostname.clone());
            }
            if !superseded {
                crons
                    .entry(cron.clone())
                    .or_default()
                    .insert(app.hostname.clone());
            }
        }
        for consumer in &app.artifact.metadata.queue_consumers {
            let id = resource(&owner, "queue", &consumer.queue);
            let mut declaration = serde_json::to_value(consumer)?;
            declaration["queue"] = json!(id);
            if let Some(dead) = &consumer.dead_letter_queue {
                declaration["dead_letter_queue"] = json!(resource(&owner, "queue", dead));
            }
            let target = json!({ "hostname": app.hostname, "queue": consumer.queue });
            if !is_candidate {
                previous_consumers.insert(id.clone(), declaration.clone());
                previous_queues.insert(id.clone(), target.clone());
            }
            if !superseded {
                consumers.insert(id.clone(), declaration);
                queues.insert(id, target);
            }
        }
        if candidate
            .as_ref()
            .is_some_and(|next| next.version == app.version)
        {
            candidate = Some(app.clone());
        }
    }
    buckets.insert(
        "WIDEFLEET_PACKAGES".into(),
        json!({ "binding": "WIDEFLEET_PACKAGES", "bucket_name": "widefleet-packages" }),
    );
    let mut services = Vec::new();
    let mut connector_configurations = Vec::new();
    for connector in &packages.connectors {
        if connector.protocol != 1 {
            return Err(Error::invalid(
                "Unsupported connector package protocol".into(),
            ));
        }
        let project = directory.join(format!("connector-{}", connector.name));
        tokio::fs::create_dir_all(&project).await?;
        write_modules(&project, &connector.modules).await?;
        let mut config = connector.configuration.clone();
        config["name"] = json!(format!("cap-{}", connector.name));
        config["main"] = json!(connector.main);
        config["no_bundle"] = json!(true);
        config["services"] = json!([{
            "binding": "WIDEFLEET_SECRETS",
            "service": format!("secrets-{}", connector.name),
        }]);

        // Keep platform code and credentials in their own Worker. Connector
        // bundles remain byte-for-byte intact, including private JS bindings.
        let secret_project = directory.join(format!("secrets-{}", connector.name));
        let secret_source = include_str!("connector-secrets.js");
        let secret_config = json!({
            "name": format!("secrets-{}", connector.name),
            "main": "worker.js",
            "no_bundle": true,
            "compatibility_date": "2026-10-01",
            "vars": packages.connector_secrets.get(&connector.name).cloned().unwrap_or_default(),
        });
        tokio::fs::create_dir_all(&secret_project).await?;
        tokio::fs::write(secret_project.join("worker.js"), secret_source).await?;
        tokio::fs::write(
            secret_project.join("wrangler.json"),
            serde_json::to_vec_pretty(&secret_config)?,
        )
        .await?;
        for (field, identity) in [
            ("d1_databases", "database_name"),
            ("r2_buckets", "bucket_name"),
            ("kv_namespaces", "id"),
        ] {
            if let Some(bindings) = config.get_mut(field).and_then(Value::as_array_mut) {
                for binding in bindings {
                    let name = binding
                        .get(identity)
                        .and_then(Value::as_str)
                        .ok_or_else(|| Error::invalid("Invalid connector resource".into()))?;
                    let id = resource(&format!("connector:{}", connector.name), field, name);
                    binding[identity] = json!(id);
                    if field == "d1_databases" {
                        binding["database_id"] = json!(id);
                    }
                }
            }
        }
        tokio::fs::write(
            project.join("wrangler.json"),
            serde_json::to_vec_pretty(&config)?,
        )
        .await?;
        // Include generated configuration and platform code in activation
        // identity, so an agent update cannot reuse an obsolete secret Worker.
        connector_configurations.push(json!([config, secret_config, secret_source]));
        for entrypoint in &connector.entrypoints {
            services.push(json!({ "binding": capability(&connector.name, entrypoint), "service": format!("cap-{}", connector.name), "entrypoint": entrypoint }));
        }
    }
    let project = directory.join("runtime");
    tokio::fs::create_dir_all(&project).await?;
    write_modules(&project, &packages.runtime.modules).await?;
    let mut config = json!({
        "name": "widefleet", "main": packages.runtime.main, "no_bundle": true,
        "compatibility_date": "2026-10-01", "compatibility_flags": ["nodejs_compat"],
        "worker_loaders": [{ "binding": "WIDEFLEET_LOADER" }],
        "vars": { "WIDEFLEET_CONTROL_TOKEN": token, "WIDEFLEET_CONFIGURATION": serde_json::to_string(&json!({ "crons": crons, "queues": queues }))? },
        "d1_databases": databases.values().collect::<Vec<_>>(), "r2_buckets": buckets.values().collect::<Vec<_>>(),
        "kv_namespaces": namespaces.values().collect::<Vec<_>>(), "services": services,
        "triggers": { "crons": native_crons(&crons) },
        "queues": { "producers": producers.values().collect::<Vec<_>>(), "consumers": consumers.values().collect::<Vec<_>>() },
    });
    if packages.runtime.workflows == Some(1) {
        config["services"].as_array_mut().ok_or_else(|| Error::invalid("Invalid service configuration".into()))?.push(json!({ "binding": "WIDEFLEET_WORKFLOW_SESSIONS", "service": "widefleet", "entrypoint": "WorkflowSessions" }));
        config["workflows"] = json!([{ "binding": "WIDEFLEET_WORKFLOWS", "name": "widefleet-apps", "class_name": "AppWorkflow" }]);
        config["durable_objects"] = json!({ "bindings": [{ "name": "WIDEFLEET_WORKFLOW_CATALOG", "class_name": "WidefleetWorkflowCatalog" }] });
    }
    tokio::fs::write(
        project.join("wrangler.json"),
        serde_json::to_vec_pretty(&config)?,
    )
    .await?;
    if consumers != previous_consumers || crons != previous_crons {
        // celld requires attachments to match the loaded manifest. Validate new
        // resources/code while retaining the published apps' subscriptions.
        let mut validation = config.clone();
        validation["queues"]["consumers"] = json!(previous_consumers.values().collect::<Vec<_>>());
        validation["triggers"]["crons"] = json!(native_crons(&previous_crons));
        validation["vars"]["WIDEFLEET_CONFIGURATION"] = json!(serde_json::to_string(
            &json!({ "crons": previous_crons, "queues": previous_queues })
        )?);
        tokio::fs::write(
            project.join("validation.json"),
            serde_json::to_vec_pretty(&validation)?,
        )
        .await?;
    }
    let digest = sha256(&serde_json::to_vec(&json!([
        config,
        packages,
        connector_configurations
    ]))?);
    let changed = read(&store, &format!("{}/installed", prefix(job)))
        .await?
        .as_deref()
        != Some(digest.as_bytes());
    if let Some(app) = &candidate {
        put(
            &store,
            &package_key(
                job,
                &format!("versions/{}/{}.json", job.app_id()?, app.version),
            ),
            serde_json::to_vec(app)?,
        )
        .await?;
    }
    // Runtime changes affect every published snapshot, including serving hosts
    // whose management acknowledgment has not arrived yet.
    let probes = match job.kind {
        JobKind::Runtime | JobKind::Connector => current,
        JobKind::Delete | JobKind::Migrations | JobKind::Workflows => Vec::new(),
        JobKind::Deploy | JobKind::Configure => candidate.iter().cloned().collect(),
    };
    Ok(Prepared {
        changed,
        probes,
        token,
        app: candidate,
        digest,
        packages: packages.clone(),
    })
}

async fn write_modules(directory: &Path, modules: &[ReleaseModule]) -> Result<()> {
    let mut names = BTreeSet::new();
    for module in modules {
        if Path::new(&module.name).components().count() != 1
            || !Path::new(&module.name)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || !names.insert(&module.name)
            || sha256(module.source.as_bytes()) != module.sha256
        {
            return Err(Error::invalid(
                "Unsafe module name or invalid release checksum".into(),
            ));
        }
        tokio::fs::write(directory.join(&module.name), &module.source).await?;
    }
    Ok(())
}

pub async fn publish(
    configuration: &Configuration,
    job: &Job,
    packages: &RuntimePackages,
    directory: &Path,
) -> Result<()> {
    let storage = configuration.storage.resolve()?;
    let staging = format!("{}/staging/{}", prefix(job), job.id);
    let store = storage.object_store()?;
    // celld computes queue detachments from the previous named deployment.
    // Seed its metadata in staging so removing a consumer publishes a tombstone.
    let deployed = format!("{}/deploy/", prefix(job));
    let existing = store
        .list(Some(&ObjectPath::from(deployed.clone())))
        .try_collect::<Vec<_>>()
        .await
        .map_err(storage_error)?;
    for object in existing {
        let key = object.location.as_ref();
        if key.ends_with("/current.json")
            || key.ends_with("/manifest.json")
            || key.ends_with("/consumer.json")
        {
            let relative = key
                .strip_prefix(&format!("{}/", prefix(job)))
                .ok_or_else(|| Error::invalid("Invalid deployment metadata key".into()))?;
            if let Some(bytes) = read(&store, key).await? {
                put(&store, &format!("{staging}/{relative}"), bytes).await?;
            }
        }
    }
    let mut projects: Vec<_> = packages
        .connectors
        .iter()
        .flat_map(|connector| {
            [
                directory.join(format!("secrets-{}", connector.name)),
                directory.join(format!("connector-{}", connector.name)),
            ]
        })
        .collect();
    projects.push(directory.join("runtime"));
    let mut pointers = stage(configuration, job, projects).await?;
    let runtime = directory.join("runtime");
    let next = if runtime.join("validation.json").try_exists()? {
        tokio::fs::copy(
            runtime.join("validation.json"),
            runtime.join("wrangler.json"),
        )
        .await?;
        let final_pointers = pointers;
        pointers = stage(configuration, job, vec![runtime]).await?;
        final_pointers
    } else {
        BTreeMap::new()
    };
    let mut previous = BTreeMap::new();
    for key in pointers.keys().chain(next.keys()) {
        previous.insert(key.clone(), read(&store, key).await?);
    }
    let mut wake = Vec::new();
    for (key, bytes) in if next.is_empty() { &pointers } else { &next } {
        let Some(queue) = key
            .strip_prefix(&format!("{}/deploy/queues/", prefix(job)))
            .and_then(|key| key.strip_suffix("/consumer.json"))
        else {
            continue;
        };
        if serde_json::from_slice::<Value>(bytes)?
            .get("consumer")
            .is_some()
        {
            let was_attached = previous
                .get(key)
                .and_then(Option::as_ref)
                .map(|bytes| serde_json::from_slice::<Value>(bytes))
                .transpose()?
                .is_some_and(|value| value.get("consumer").is_some());
            if !was_attached {
                wake.push(queue.to_string());
            }
        }
    }
    put(
        &store,
        &format!("{}/pending.json", prefix(job)),
        serde_json::to_vec(
            &json!({ "previous": previous, "next": next, "wake": wake, "validated": false }),
        )?,
    )
    .await?;
    let primary = format!("{}/deploy/current.json", prefix(job));
    let primary_bytes = pointers
        .remove(&primary)
        .ok_or_else(|| Error::invalid("Staged runtime has no primary pointer".into()))?;
    for (key, bytes) in pointers {
        put(&store, &key, bytes).await?;
    }
    put(&store, &primary, primary_bytes).await
}

async fn stage(
    configuration: &Configuration,
    job: &Job,
    projects: Vec<std::path::PathBuf>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let storage = configuration.storage.resolve()?;
    let store = storage.object_store()?;
    let staging = format!("{}/staging/{}", prefix(job), job.id);
    for project in projects {
        let mut command = Command::new(&configuration.celld);
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy();
            if name.starts_with("AWS_")
                || name.starts_with("AZURE_")
                || name.starts_with("GOOGLE_")
                || name == "S3_ENDPOINT"
                || name == "SERVICE_ACCOUNT"
            {
                command.env_remove(key);
            }
        }
        let mut arguments = storage.arguments(job.fleet_id, false);
        arguments[1] = format!("{}/staging/{}", arguments[1], job.id);
        let output = command
            .arg("deploy")
            .arg(project)
            .args(arguments)
            .envs(storage.environment(false))
            .kill_on_drop(true)
            .output()
            .await?;
        if !output.status.success() {
            return Err(Error::invalid(format!(
                "celld publish failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
    }
    let objects = store
        .list(Some(&ObjectPath::from(format!("{staging}/"))))
        .try_collect::<Vec<_>>()
        .await
        .map_err(storage_error)?;
    let mut pointers = BTreeMap::new();
    for object in objects {
        let relative = object
            .location
            .as_ref()
            .strip_prefix(&format!("{staging}/"))
            .ok_or_else(|| Error::invalid("Invalid staging object".into()))?;
        let key = format!("{}/{relative}", prefix(job));
        let bytes = read(&store, object.location.as_ref())
            .await?
            .ok_or_else(|| Error::invalid("Staged object disappeared".into()))?;
        if relative.ends_with("current.json") || relative.starts_with("deploy/queues/") {
            pointers.insert(key, bytes);
        } else {
            put(&store, &key, bytes).await?;
        }
    }
    Ok(pointers)
}

#[derive(serde::Deserialize)]
struct Pending {
    previous: BTreeMap<String, Option<Vec<u8>>>,
    #[serde(default)]
    next: BTreeMap<String, Vec<u8>>,
    #[serde(default)]
    wake: Vec<String>,
    validated: bool,
    app: Option<PublishedApp>,
    digest: Option<String>,
    packages: Option<RuntimePackages>,
}

pub struct Recovery {
    pub reload: bool,
    pub wake: Vec<String>,
}

// Leave the journal durable until the caller has reloaded the running node.
// A failure or process exit at any point must repeat this recovery next time.
pub async fn recover(configuration: &Configuration, job: &Job) -> Result<Option<Recovery>> {
    let store = configuration.storage.resolve()?.object_store()?;
    let Some(bytes) = read(&store, &format!("{}/pending.json", prefix(job))).await? else {
        return Ok(None);
    };
    let pending: Pending = serde_json::from_slice(&bytes)?;
    let reload = !pending.validated || !pending.next.is_empty();
    if pending.validated {
        // Detach removed consumers before selecting code that no longer handles
        // them. New/updated attachments follow the selected app snapshot.
        let mut attachments = Vec::new();
        let primary = format!("{}/deploy/current.json", prefix(job));
        let mut primary_bytes = None;
        for (key, bytes) in pending.next {
            if key == primary {
                primary_bytes = Some(bytes);
            } else if key.starts_with(&format!("{}/deploy/queues/", prefix(job)))
                && serde_json::from_slice::<Value>(&bytes)?
                    .get("consumer")
                    .is_none()
            {
                put(&store, &key, bytes).await?;
            } else {
                attachments.push((key, bytes));
            }
        }
        if let Some(app) = pending.app {
            if app
                .artifact
                .metadata
                .bindings
                .iter()
                .any(|binding| matches!(binding, Binding::Workflow { .. }))
            {
                put(
                    &store,
                    &package_key(
                        job,
                        &format!(
                            "workflow-versions/{}/{}.json",
                            app.artifact.app_id, app.version
                        ),
                    ),
                    serde_json::to_vec(&app.version)?,
                )
                .await?;
            }
            put(
                &store,
                &package_key(job, &format!("hosts/{}.json", app.hostname)),
                serde_json::to_vec(&app)?,
            )
            .await?;
        }
        for (key, bytes) in attachments {
            put(&store, &key, bytes).await?;
        }
        if let Some(bytes) = primary_bytes {
            put(&store, &primary, bytes).await?;
        }
        if let Some(digest) = pending.digest {
            put(
                &store,
                &format!("{}/installed", prefix(job)),
                digest.into_bytes(),
            )
            .await?;
        }
        if let Some(packages) = pending.packages {
            put(
                &store,
                &format!("{}/installed-packages.json", prefix(job)),
                serde_json::to_vec(&packages)?,
            )
            .await?;
        }
    } else {
        for (key, bytes) in pending.previous {
            if let Some(bytes) = bytes {
                put(&store, &key, bytes).await?;
            } else {
                remove_key(&store, &key).await?;
            }
        }
    }
    // An interrupted first installation has no earlier deployment to load.
    Ok(Some(Recovery {
        reload: reload
            && read(&store, &format!("{}/deploy/current.json", prefix(job)))
                .await?
                .is_some(),
        wake: if pending.validated {
            pending.wake
        } else {
            Vec::new()
        },
    }))
}

pub async fn finish_recovery(configuration: &Configuration, job: &Job) -> Result<()> {
    remove_key(
        &configuration.storage.resolve()?.object_store()?,
        &format!("{}/pending.json", prefix(job)),
    )
    .await
}

pub async fn migration_database(
    configuration: &Configuration,
    job: &Job,
    request: &platform_core::migrations::Request,
) -> Result<String> {
    let store = configuration.storage.resolve()?.object_store()?;
    let bytes = read(
        &store,
        &package_key(job, &format!("hosts/{}.json", job.hostname()?)),
    )
    .await?
    .ok_or_else(|| Error::invalid("The app has no active runtime deployment".into()))?;
    let app: PublishedApp = serde_json::from_slice(&bytes)?;
    if app.artifact.app_id != job.app_id()? {
        return Err(Error::invalid(
            "The active runtime belongs to another app".into(),
        ));
    }
    let identity = app
        .artifact
        .metadata
        .bindings
        .iter()
        .find_map(|binding| match binding {
            Binding::D1 {
                name,
                database_name,
                database_id,
            } if name == &request.database => Some(database_id.as_ref().unwrap_or(database_name)),
            _ => None,
        });
    if identity != Some(&request.database_id) {
        return Err(Error::invalid(
            "The D1 binding changed before the migration ran; check the deployed configuration"
                .into(),
        ));
    }
    Ok(resource(
        &job.app_id()?.to_string(),
        "d1",
        &request.database_id,
    ))
}

pub async fn commit(configuration: &Configuration, job: &Job, prepared: &Prepared) -> Result<()> {
    let store = configuration.storage.resolve()?.object_store()?;
    let (next, wake) = match read(&store, &format!("{}/pending.json", prefix(job))).await? {
        Some(bytes) => {
            let pending: Pending = serde_json::from_slice(&bytes)?;
            (pending.next, pending.wake)
        }
        None => (BTreeMap::new(), Vec::new()),
    };
    put(&store, &format!("{}/pending.json", prefix(job)), serde_json::to_vec(&json!({ "previous": {}, "next": next, "wake": wake, "validated": true, "app": prepared.app, "digest": prepared.digest, "packages": prepared.packages }))?).await
}

pub async fn detach(configuration: &Configuration, job: &Job) -> Result<Option<RuntimePackages>> {
    let store = configuration.storage.resolve()?.object_store()?;
    remove_key(
        &store,
        &package_key(job, &format!("hosts/{}.json", job.hostname()?)),
    )
    .await?;
    // Delete using the installed release, even if a newer requested release failed.
    read(&store, &format!("{}/installed-packages.json", prefix(job)))
        .await?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(Error::from))
        .transpose()
}

pub async fn remove(configuration: &Configuration, job: &Job) -> Result<()> {
    let store = configuration.storage.resolve()?.object_store()?;
    let versions = store
        .list(Some(&ObjectPath::from(package_key(
            job,
            &format!("versions/{}/", job.app_id()?),
        ))))
        .try_collect::<Vec<_>>()
        .await
        .map_err(storage_error)?;
    let mut owned_versions = Vec::new();
    let mut prefixes = BTreeSet::from([
        package_key(job, &format!("apps/{}/", job.app_id()?)),
        package_key(job, &format!("workflow-versions/{}/", job.app_id()?)),
    ]);
    for object in versions {
        let Some(bytes) = read(&store, object.location.as_ref()).await? else {
            continue;
        };
        let app: PublishedApp = serde_json::from_slice(&bytes)?;
        if app.artifact.app_id != job.app_id()? {
            continue;
        }
        for binding in app.artifact.metadata.bindings {
            if let Binding::R2Bucket { bucket_name, .. } = binding {
                let id = resource(&job.app_id()?.to_string(), "r2", &bucket_name);
                prefixes.insert(format!("{}/r2/{id}/", prefix(job)));
            }
        }
        owned_versions.push(object.location);
    }
    for prefix in prefixes {
        let objects = store
            .list(Some(&ObjectPath::from(prefix)))
            .try_collect::<Vec<_>>()
            .await
            .map_err(storage_error)?;
        for object in objects {
            remove_key(&store, object.location.as_ref()).await?;
        }
    }
    // Keep the resource inventory until cleanup succeeds, so retries can finish it.
    for version in owned_versions {
        remove_key(&store, version.as_ref()).await?;
    }
    // Native cell storage and shared deployment history have no supported per-app
    // purge in celld 0.6.1. Their live bindings were removed by the fleet reload.
    Ok(())
}

pub async fn workflow_control(configuration: &Configuration, job: &Job) -> Result<Option<String>> {
    let store = configuration.storage.resolve()?.object_store()?;
    let Some(bytes) = read(&store, &format!("{}/installed-packages.json", prefix(job))).await?
    else {
        return Ok(None);
    };
    let installed: RuntimePackages = serde_json::from_slice(&bytes)?;
    if installed.runtime.workflows != Some(1) {
        return Ok(None);
    }
    let token = read(&store, &format!("{}/control-token", prefix(job)))
        .await?
        .ok_or_else(|| Error::invalid("Runtime control token is missing".into()))?;
    Ok(Some(
        String::from_utf8(token).map_err(|error| Error::invalid(error.to_string()))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_class_reuse_across_selected_connectors_but_allows_local_aliases() {
        let connector = |name: &str, class: &str| ConnectorPackage {
            protocol: 1,
            name: name.into(),
            main: "worker.js".into(),
            modules: Vec::new(),
            entrypoints: vec!["default".into()],
            configuration: json!({ "durable_objects": { "bindings": [
                { "name": "STATE", "class_name": class },
                { "name": "ALIAS", "class_name": class }
            ] } }),
        };
        assert!(
            validate_connector_classes(&[
                connector("erp", "ErpState"),
                connector("crm", "CrmState")
            ])
            .is_ok()
        );
        let result = validate_connector_classes(&[
            connector("erp", "SharedState"),
            connector("crm", "SharedState"),
        ]);
        assert!(
            matches!(result, Err(error) if error.to_string().contains("SharedState is declared by both erp and crm"))
        );
    }
}
