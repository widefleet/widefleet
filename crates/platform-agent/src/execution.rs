use crate::config::Configuration;
use futures_util::TryStreamExt;
use object_store::{ObjectStore, ObjectStoreExt, PutMode, PutOptions, path::Path as ObjectPath};
use platform_core::{
    Error, Result,
    model::{
        Artifact, Binding, Job, JobKind, Module, ModuleType, PublishedApp, PublishedCapability,
        ReleaseModule, RuntimePackages,
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
    format!("organizations/{}", job.organization_id)
}
fn package_key(job: &Job, key: &str) -> String {
    format!("{}/r2/widefleet-packages/{key}", prefix(job))
}

// One-time storage cutover: retired grants must not prevent reading another
// app's publication when preparing the first app-only runtime configuration.
async fn migrate_app_services(store: &Arc<dyn ObjectStore>, root: &str) -> Result<()> {
    let marker = format!("{root}/migrations/app-services-v3.json");
    if read(store, &marker).await?.is_some() {
        return Ok(());
    }
    for prefix in ["hosts/", "versions/"] {
        let objects = store
            .list(Some(&ObjectPath::from(format!("{root}/{prefix}"))))
            .try_collect::<Vec<_>>()
            .await
            .map_err(storage_error)?;
        for object in objects {
            let entry = store.get(&object.location).await.map_err(storage_error)?;
            let version = object_store::UpdateVersion {
                e_tag: entry.meta.e_tag.clone(),
                version: entry.meta.version.clone(),
            };
            let attributes = entry.attributes.clone();
            let mut snapshot: Value =
                serde_json::from_slice(&entry.bytes().await.map_err(storage_error)?)?;
            let legacy = snapshot
                .get("capabilities")
                .and_then(Value::as_object)
                .is_some_and(|grants| {
                    grants
                        .values()
                        .any(|grant| grant.get("connector").is_some())
                });
            if legacy {
                snapshot["capabilities"] = json!({});
                store
                    .put_opts(
                        &object.location,
                        serde_json::to_vec(&snapshot)?.into(),
                        PutOptions {
                            mode: PutMode::Update(version),
                            attributes,
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(storage_error)?;
            }
        }
    }
    put(store, &marker, b"{}".to_vec()).await
}
fn resource(owner: &str, kind: &str, name: &str) -> String {
    format!(
        "r{}",
        &sha256(format!("{owner}/{kind}/{name}").as_bytes())[..40]
    )
}

fn native_resource(
    owner: &str,
    binding: &Binding,
) -> Option<(String, &'static str, String, Value)> {
    let (name, kind, logical) = match binding {
        Binding::PlainText { .. } | Binding::Workflow { .. } => return None,
        Binding::D1 {
            name,
            database_name,
            database_id,
        } => (name, "d1", database_id.as_ref().unwrap_or(database_name)),
        Binding::R2Bucket { name, bucket_name } => (name, "r2", bucket_name),
        Binding::KvNamespace { name, id } => (name, "kv", id),
        Binding::Queue { name, queue } => (name, "queue", queue),
    };
    let id = resource(owner, kind, logical);
    let native = format!("B_{id}");
    let (field, config) = match kind {
        "d1" => (
            "d1_databases",
            json!({ "binding": native, "database_name": id, "database_id": id }),
        ),
        "r2" => (
            "r2_buckets",
            json!({ "binding": native, "bucket_name": id }),
        ),
        "kv" => ("kv_namespaces", json!({ "binding": native, "id": id })),
        "queue" => ("queues", json!({ "binding": native, "queue": id })),
        _ => unreachable!(),
    };
    Some((name.clone(), field, native, config))
}

async fn publish_modules(
    store: &Arc<dyn ObjectStore>,
    job: &Job,
    scope: &str,
    modules: &[Module],
    directory: &Path,
) -> Result<()> {
    for module in modules {
        if matches!(module.kind, ModuleType::Sourcemap) {
            continue;
        }
        let bytes = tokio::fs::read(directory.join(&module.name)).await?;
        if bytes.len() as u64 != module.size || sha256(&bytes) != module.sha256 {
            return Err(Error::invalid(
                "Worker module checksum or size mismatch".into(),
            ));
        }
        let key = ObjectPath::from(package_key(
            job,
            &format!("{scope}/modules/{}", module.sha256),
        ));
        match store
            .put_opts(
                &key,
                bytes.into(),
                PutOptions {
                    mode: PutMode::Create,
                    ..Default::default()
                },
            )
            .await
        {
            Ok(_) | Err(object_store::Error::AlreadyExists { .. }) => {}
            Err(error) => return Err(storage_error(error)),
        }
    }
    Ok(())
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
    if packages.runtime.protocol != 3
        || packages.runtime.auth != 1
        || packages.runtime.celld != crate::native::VERSION
    {
        return Err(Error::invalid(
            "Unsupported runtime installation protocol or celld version".into(),
        ));
    }
    let store = configuration.storage.resolve()?.object_store()?;
    let token_key = format!("{}/control-token", prefix(job));
    migrate_app_services(&store, package_key(job, "").trim_end_matches('/')).await?;
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
    // Each activation attempt gets an immutable snapshot and a fresh worker key.
    let mut candidate = match artifact {
        Some(artifact) => Some(PublishedApp {
            secret_revision: packages
                .app_secrets
                .as_ref()
                .and_then(|value| value["revision"].as_u64())
                .unwrap_or(0),
            organization_id: Some(job.organization_id.clone()),
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
        for consumer in &current {
            if consumer.capabilities.values().any(|binding| {
                binding.grant.app == app.artifact.app_id
                    && !app
                        .artifact
                        .metadata
                        .entrypoints
                        .contains(&binding.grant.entrypoint)
            }) {
                return Err(Error::invalid(
                    "Disconnect app services before removing their entrypoints".into(),
                ));
            }
        }
        if let Some(snapshot) = &job.capabilities {
            for (name, grant) in &snapshot.grants {
                let target = current
                    .iter()
                    .find(|target| {
                        target.artifact.app_id == grant.app
                            && target.organization_id.as_deref()
                                == Some(job.organization_id.as_str())
                            && target
                                .artifact
                                .metadata
                                .entrypoints
                                .contains(&grant.entrypoint)
                    })
                    .ok_or_else(|| {
                        Error::invalid(format!("App binding {name} target is unavailable"))
                    })?;
                if name.starts_with("WIDEFLEET_")
                    || name == &app.artifact.metadata.assets.binding
                    || app
                        .artifact
                        .metadata
                        .worker
                        .bindings
                        .iter()
                        .any(|binding| binding.name() == name)
                {
                    return Err(Error::invalid(format!(
                        "App binding {name} is unavailable or collides with another binding"
                    )));
                }
                app.capabilities.insert(
                    name.clone(),
                    PublishedCapability {
                        hostname: target.hostname.clone(),
                        organization_id: job.organization_id.clone(),
                        grant: grant.clone(),
                    },
                );
            }
        }
        publish_modules(
            &store,
            job,
            &format!("apps/{}", app.artifact.app_id),
            &app.artifact.modules,
            directory,
        )
        .await?;
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
                .worker
                .bindings
                .iter()
                .any(|binding| matches!(binding, Binding::Workflow { .. }))
        })
    {
        return Err(Error::invalid(
            "This organization requires an app runtime with Workflow protocol 1".into(),
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
        for binding in &app.artifact.metadata.worker.bindings {
            if let Some((name, field, native, config)) = native_resource(&owner, binding) {
                app.native_bindings.insert(name, native.clone());
                match field {
                    "d1_databases" => {
                        databases.insert(native, config);
                    }
                    "r2_buckets" => {
                        buckets.insert(native, config);
                    }
                    "kv_namespaces" => {
                        namespaces.insert(native, config);
                    }
                    "queues" => {
                        producers.insert(native, config);
                    }
                    _ => unreachable!(),
                }
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
    namespaces.insert(
        "AUTH_CONFIG".into(),
        json!({ "binding": "AUTH_CONFIG", "id": "widefleet-auth" }),
    );
    let project = directory.join("runtime");
    tokio::fs::create_dir_all(&project).await?;
    write_modules(&project, &packages.runtime.modules).await?;
    let secrets_key =
        platform_agent::runtime::secrets_key(store.as_ref(), &job.organization_id).await?;
    let mut config =
        platform_agent::runtime::configuration(&packages.runtime, &token, &secrets_key)?;
    config["vars"]["WIDEFLEET_CONFIGURATION"] = json!(serde_json::to_string(
        &json!({ "crons": crons, "queues": queues })
    )?);
    config["d1_databases"] = json!(databases.values().collect::<Vec<_>>());
    config["r2_buckets"] = json!(buckets.values().collect::<Vec<_>>());
    config["kv_namespaces"] = json!(namespaces.values().collect::<Vec<_>>());
    config["triggers"] = json!({ "crons": native_crons(&crons) });
    config["queues"] = json!({ "producers": producers.values().collect::<Vec<_>>(), "consumers": consumers.values().collect::<Vec<_>>() });
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
    let digest = sha256(&serde_json::to_vec(&json!([config, packages.runtime]))?);
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
        JobKind::Runtime => current,
        JobKind::Delete | JobKind::Migrations | JobKind::Workflows => Vec::new(),
        JobKind::Deploy | JobKind::Configure => candidate.iter().cloned().collect(),
    };
    Ok(Prepared {
        changed,
        probes,
        token,
        app: candidate,
        digest,
        packages: RuntimePackages {
            app_secrets: None,
            ..packages.clone()
        },
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

pub async fn publish(configuration: &Configuration, job: &Job, directory: &Path) -> Result<()> {
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
    let projects = vec![directory.join("runtime")];
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
        let mut arguments = storage.arguments(&job.organization_id, false);
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
                .worker
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
        .worker
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
        &app.artifact.app_id.to_string(),
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
        package_key(job, &format!("app-secrets/{}/", job.app_id()?)),
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
        for binding in app.artifact.metadata.worker.bindings {
            if let Binding::R2Bucket { bucket_name, .. } = binding {
                let owner = app.artifact.app_id.to_string();
                let id = resource(&owner, "r2", &bucket_name);
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

    #[tokio::test]
    async fn cuts_over_legacy_publications_once_without_changing_app_grants() -> Result<()> {
        let store: Arc<dyn ObjectStore> = Arc::new(object_store::memory::InMemory::new());
        let root = "organizations/fixture/r2/widefleet-packages";
        let legacy = json!({"version":"old", "capabilities":{"API":{"connector":"retired"}}});
        let current = json!({"version":"current", "capabilities":{"API":{"app":"current-app", "entrypoint":"Reader"}}});
        for suffix in ["hosts/legacy.json", "versions/legacy/old.json"] {
            put(
                &store,
                &format!("{root}/{suffix}"),
                serde_json::to_vec(&legacy)?,
            )
            .await?;
        }
        put(
            &store,
            &format!("{root}/hosts/current.json"),
            serde_json::to_vec(&current)?,
        )
        .await?;
        migrate_app_services(&store, root).await?;
        migrate_app_services(&store, root).await?;
        for suffix in ["hosts/legacy.json", "versions/legacy/old.json"] {
            let bytes = read(&store, &format!("{root}/{suffix}"))
                .await?
                .ok_or_else(|| Error::invalid("Missing published snapshot".into()))?;
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes)?,
                json!({"version":"old", "capabilities":{}})
            );
        }
        let bytes = read(&store, &format!("{root}/hosts/current.json"))
            .await?
            .ok_or_else(|| Error::invalid("Missing app snapshot".into()))?;
        assert_eq!(serde_json::from_slice::<Value>(&bytes)?, current);
        Ok(())
    }
}
