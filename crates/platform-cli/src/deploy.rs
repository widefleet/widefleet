use crate::migrations::Database;
use crate::{auth, installation, preview};
use clap::Args;
use platform_core::{
    Error, Result, asset_hash,
    http::{Api, json},
    model::{
        App, Asset, AssetManifest, Binding, DebugMetadata, Deployment, QueueConsumer,
        UploadSession, WorkerAssets, WorkerMetadata,
    },
};
use reqwest::{
    Method,
    multipart::{Form, Part},
};
use serde::Deserialize;
use serde_json::json as value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    #[serde(rename = "$schema")]
    _schema: Option<String>,
    name: Option<String>,
    main: PathBuf,
    compatibility_date: String,
    #[serde(default)]
    compatibility_flags: Vec<String>,
    assets: Assets,
    #[serde(default)]
    vars: BTreeMap<String, String>,
    #[serde(default)]
    d1_databases: Vec<Database>,
    #[serde(default)]
    r2_buckets: Vec<Bucket>,
    #[serde(default)]
    kv_namespaces: Vec<Namespace>,
    #[serde(default)]
    triggers: Triggers,
    #[serde(default)]
    queues: Queues,
    #[serde(default)]
    workflows: Vec<Workflow>,
    #[serde(rename = "no_bundle")]
    _no_bundle: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assets {
    directory: PathBuf,
    binding: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bucket {
    binding: String,
    bucket_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Workflow {
    binding: String,
    name: String,
    class_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Namespace {
    binding: String,
    id: String,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Triggers {
    #[serde(default)]
    crons: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Producer {
    binding: String,
    queue: String,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Queues {
    #[serde(default)]
    producers: Vec<Producer>,
    #[serde(default)]
    consumers: Vec<QueueConsumer>,
}

struct AssetFiles {
    source_maps: BTreeMap<String, PathBuf>,
    manifest: AssetManifest,
    files: BTreeMap<String, PathBuf>,
}

#[derive(Args)]
#[group(id = "deployment")]
pub struct Options {
    #[arg(long, default_value = "wrangler.jsonc")]
    pub config: PathBuf,
    #[arg(long)]
    skip_build: bool,
    #[arg(long)]
    no_wait: bool,
    /// Print the deployment result as JSON, with build and progress logs on stderr.
    #[arg(long)]
    json: bool,
}

pub enum Target {
    App(Option<Uuid>),
    Preview(preview::Target),
}

pub async fn run(
    api: &Api,
    credentials: &auth::Credentials,
    target: Target,
    options: Options,
) -> Result<()> {
    let mut result = publish(
        api,
        credentials,
        target,
        &options.config,
        options.skip_build,
    )
    .await?;
    eprintln!("Deployment ID: {}", result.deployment.id);
    if !options.no_wait {
        result.deployment = wait(
            api,
            credentials,
            result.deployment.app_id,
            result.deployment.id,
        )
        .await?;
    }
    if options.json {
        crate::print_json(&result)?;
    } else {
        println!("Deployment {}", result.deployment.status);
        if result.deployment.status == "succeeded" {
            println!("{}", result.url);
        }
    }
    Ok(())
}

fn collect_assets(root: &Path) -> Result<AssetFiles> {
    let mut pending = vec![root.to_owned()];
    let mut manifest = AssetManifest::new();
    let mut source_maps = BTreeMap::new();
    let mut files = BTreeMap::new();
    let mut total = 0;
    while let Some(directory) = pending.pop() {
        for item in std::fs::read_dir(directory)? {
            let item = item?;
            let kind = item.file_type()?;
            let path = item.path();
            if kind.is_symlink() {
                return Err(Error::invalid(format!(
                    "Asset symlinks are not supported: {}",
                    path.display()
                )));
            }
            if kind.is_dir() {
                pending.push(path);
                continue;
            }
            if !kind.is_file() {
                return Err(Error::invalid(format!(
                    "Asset is not a regular file: {}",
                    path.display()
                )));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|error| Error::invalid(error.to_string()))?;
            let name = relative
                .to_str()
                .ok_or_else(|| Error::invalid("Asset paths must be UTF-8".into()))?
                .replace('\\', "/");
            if name == ".assetsignore" {
                return Err(Error::invalid("Remove the adapter's build/public/.assetsignore after building; custom asset ignore rules are not supported by this MVP".into()));
            }
            let name = format!("/{name}");
            if let Some(generated) = name.strip_suffix(".map") {
                if item.metadata()?.len() > 20 * 1024 * 1024 || source_maps.len() >= 499 {
                    return Err(Error::invalid(
                        "Source maps exceed the deployment limit".into(),
                    ));
                }
                source_maps.insert(generated.to_owned(), path);
                continue;
            }
            if item.metadata()?.len() > 25 * 1024 * 1024 {
                return Err(Error::invalid(format!("Asset exceeds 25 MiB: {name}")));
            }
            let bytes = std::fs::read(&path)?;
            let hash = asset_hash(&name, &bytes);
            if files.insert(hash.clone(), path).is_none() {
                total += bytes.len();
            }
            manifest.insert(
                name,
                Asset {
                    hash,
                    size: bytes.len() as u64,
                },
            );
            if manifest.len() > 10_000 || total > 250 * 1024 * 1024 {
                return Err(Error::invalid(
                    "Asset manifest exceeds the platform limit".into(),
                ));
            }
        }
    }
    Ok(AssetFiles {
        manifest,
        files,
        source_maps,
    })
}

async fn local_command(project: &Path, arguments: &[&str]) -> Result<()> {
    let status = Command::new(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" })
        .args(arguments)
        .current_dir(project)
        .stdout(Stdio::from(std::io::stderr()))
        .status()
        .await?;
    if !status.success() {
        return Err(Error::invalid(format!(
            "Local command failed: pnpm {}",
            arguments.join(" ")
        )));
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct DeploymentResult {
    #[serde(flatten)]
    pub deployment: Deployment,
    pub url: String,
}

async fn publish(
    api: &Api,
    credentials: &auth::Credentials,
    target: Target,
    config: &Path,
    skip_build: bool,
) -> Result<DeploymentResult> {
    let config_path = config.canonicalize()?;
    let project = config_path
        .parent()
        .ok_or_else(|| Error::invalid("Configuration has no parent directory".into()))?;
    let configuration: Configuration = jsonc_parser::parse_to_serde_value(
        &std::fs::read_to_string(&config_path)?,
        &jsonc_parser::ParseOptions {
            allow_comments: true,
            allow_trailing_commas: true,
            allow_loose_object_property_names: false,
            allow_missing_commas: false,
            allow_single_quoted_strings: false,
            allow_hexadecimal_numbers: false,
            allow_unary_plus_numbers: false,
            allow_bare_decimal_point_numbers: false,
            allow_non_finite_numbers: false,
            allow_extended_string_escapes: false,
        },
    )
    .map_err(|error| {
        Error::invalid(format!(
            "Invalid or unsupported Wrangler configuration: {error}"
        ))
    })?;
    if configuration
        .compatibility_flags
        .iter()
        .any(|flag| !matches!(flag.as_str(), "nodejs_als" | "nodejs_compat"))
    {
        return Err(Error::invalid(
            "Supported compatibility flags are nodejs_als and nodejs_compat".into(),
        ));
    }
    if configuration
        .compatibility_flags
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        != configuration.compatibility_flags.len()
    {
        return Err(Error::invalid("Compatibility flags must be unique".into()));
    }
    if matches!(target, Target::App(None)) {
        let name = configuration.name.as_deref().unwrap_or_default();
        if name.is_empty()
            || name.len() > 48
            || name == "auth"
            || !name.starts_with(|character: char| character.is_ascii_lowercase())
            || !name.ends_with(|character: char| character.is_ascii_alphanumeric())
            || !name.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            })
        {
            return Err(Error::invalid("Set a valid name in the Wrangler configuration: 1-48 lowercase letters, digits or hyphens, starting with a letter and ending with a letter or digit; auth is reserved".into()));
        }
        eprintln!("Target: {} on {}", name, api.origin_text());
    }
    let bundler = installation::bundler().await?;
    if !skip_build {
        local_command(project, &["run", "build"]).await?;
    }
    let temporary = tempfile::tempdir_in(project)?;
    let entry = project.join(&configuration.main).canonicalize()?;
    if !entry.starts_with(project) {
        return Err(Error::invalid(
            "Worker entry must be inside the app project".into(),
        ));
    }
    let node_compat = configuration
        .compatibility_flags
        .iter()
        .any(|flag| flag == "nodejs_compat");
    let worker = bundle(&bundler, project, &entry, temporary.path(), node_compat)
        .await?
        .source;
    if worker.len() > 20 * 1024 * 1024 {
        return Err(Error::invalid("Worker exceeds 20 MiB".into()));
    }
    let assets_root = project
        .join(&configuration.assets.directory)
        .canonicalize()?;
    if !assets_root.starts_with(project) {
        return Err(Error::invalid(
            "Assets must be inside the app project".into(),
        ));
    }
    let assets = collect_assets(&assets_root)?;
    let mut map_files = assets.source_maps.clone();
    map_files.insert("worker.js".into(), temporary.path().join("worker.js.map"));
    let mut source_maps = BTreeMap::new();
    let mut map_uploads = BTreeMap::new();
    let mut upload_size = worker.len();
    for (generated, path) in map_files {
        let bytes = std::fs::read(path)?;
        upload_size += bytes.len();
        if bytes.len() > 20 * 1024 * 1024 || upload_size > 95 * 1024 * 1024 {
            return Err(Error::invalid(
                "Worker and source maps exceed the deployment limit".into(),
            ));
        }
        let name = format!("map-{}.map", platform_core::sha256(&bytes));
        source_maps.insert(generated, name.clone());
        map_uploads.insert(name, bytes);
    }
    // SvelteKit embeds this exact version in both its browser and server bundles.
    let version_path = assets_root.join("_app/version.json");
    let build_id = if version_path.exists() {
        #[derive(Deserialize)]
        struct Version {
            version: String,
        }
        serde_json::from_slice::<Version>(&std::fs::read(version_path)?)?.version
    } else {
        Uuid::new_v4().to_string()
    };
    let app = match target {
        Target::Preview(preview) => preview.resolve(api, credentials).await?,
        Target::App(Some(app)) => app,
        Target::App(None) => {
            let name = configuration.name.as_deref().ok_or_else(|| {
                Error::invalid("Set name in the Wrangler configuration before deploying".into())
            })?;
            let token = auth::access_token(api, credentials).await?;
            let mut url = api.origin.clone();
            url.path_segments_mut()
                .map_err(|()| Error::invalid("Invalid platform origin".into()))?
                .extend(["api", "v1", "apps", "by-name", name]);
            let response = api
                .client
                .put(url)
                .header("origin", api.origin_text())
                .bearer_auth(&token)
                .json(&value!({}))
                .send()
                .await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(Error::invalid("The app is not accessible, or the management server does not support deployment by name. Check your app permissions and update the server to 0.1.5 or newer".into()));
            }
            let resolved: App = json(response).await?;
            eprintln!(
                "Deploying {} ({}) on {}",
                resolved.slug,
                resolved.id,
                api.origin_text()
            );
            resolved.id
        }
    };
    let token = auth::access_token(api, credentials).await?;
    let session: UploadSession = json(
        api.authenticated(
            Method::POST,
            &format!("/apps/{app}/assets-upload-session"),
            &token,
        )
        .json(&value!({ "manifest": assets.manifest }))
        .send()
        .await?,
    )
    .await?;
    let app_url = session.url.ok_or_else(|| {
        Error::invalid("The management server does not provide app URLs in upload sessions. Upgrade the server before deploying with this CLI".into())
    })?;
    for hash in &session.missing {
        let path = assets.files.get(hash).ok_or_else(|| {
            Error::invalid("Server requested an asset outside the manifest".into())
        })?;
        let bytes = std::fs::read(path)?;
        let token = auth::access_token(api, credentials).await?;
        let _: serde_json::Value = json(
            api.authenticated(
                Method::PUT,
                &format!("/apps/{app}/assets/{}/{hash}", session.id),
                &token,
            )
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await?,
        )
        .await?;
    }
    let mut bindings = Vec::new();
    bindings.extend(
        configuration
            .vars
            .into_iter()
            .map(|(name, text)| Binding::PlainText { name, text }),
    );
    bindings.extend(
        configuration
            .d1_databases
            .into_iter()
            .map(|database| Binding::D1 {
                name: database.binding,
                database_name: database.database_name,
                database_id: database.database_id,
            }),
    );
    bindings.extend(
        configuration
            .r2_buckets
            .into_iter()
            .map(|bucket| Binding::R2Bucket {
                name: bucket.binding,
                bucket_name: bucket.bucket_name,
            }),
    );
    bindings.extend(configuration.kv_namespaces.into_iter().map(|namespace| {
        Binding::KvNamespace {
            name: namespace.binding,
            id: namespace.id,
        }
    }));
    bindings.extend(
        configuration
            .queues
            .producers
            .into_iter()
            .map(|producer| Binding::Queue {
                name: producer.binding,
                queue: producer.queue,
            }),
    );
    bindings.extend(
        configuration
            .workflows
            .into_iter()
            .map(|workflow| Binding::Workflow {
                name: workflow.binding,
                workflow_name: workflow.name,
                class_name: workflow.class_name,
            }),
    );
    let metadata = WorkerMetadata {
        crons: configuration.triggers.crons,
        queue_consumers: configuration.queues.consumers,
        debug: Some(DebugMetadata {
            build_id,
            source_maps,
        }),
        main_module: "worker.js".into(),
        compatibility_date: configuration.compatibility_date,
        compatibility_flags: configuration.compatibility_flags,
        bindings,
        assets: WorkerAssets {
            upload_session: session.id,
            binding: configuration.assets.binding,
        },
    };
    let request_id = Uuid::new_v4();
    // Retry only this immutable publish, always with the same request ID and content.
    for attempt in 0..3 {
        let mut form = Form::new()
            .text("metadata", serde_json::to_string(&metadata)?)
            .part(
                "worker.js",
                Part::bytes(worker.clone())
                    .file_name("worker.js")
                    .mime_str("application/javascript+module")?,
            );
        for (name, bytes) in &map_uploads {
            form = form.part(
                name.clone(),
                Part::bytes(bytes.clone())
                    .file_name(name.clone())
                    .mime_str("application/source-map+json")?,
            );
        }
        let token = auth::access_token(api, credentials).await?;
        let sent = api
            .authenticated(Method::PUT, &format!("/apps/{app}/worker"), &token)
            .header("idempotency-key", request_id.to_string())
            .multipart(form)
            .send()
            .await;
        match sent {
            Ok(response) if response.status().is_server_error() && attempt < 2 => {}
            Ok(response) => {
                let deployment = json(response).await?;
                return Ok(DeploymentResult {
                    deployment,
                    url: app_url,
                });
            }
            Err(_) if attempt < 2 => {}
            Err(error) => return Err(error.into()),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err(Error::invalid("Deployment upload failed".into()))
}

pub(crate) struct Bundle {
    pub source: Vec<u8>,
    pub exports: Vec<String>,
}

pub(crate) async fn bundle(
    executable: &Path,
    project: &Path,
    entry: &Path,
    output: &Path,
    node_compat: bool,
) -> Result<Bundle> {
    let mut command = Command::new(executable);
    command
        .arg(entry)
        .args([
            "--bundle",
            "--format=esm",
            "--platform=browser",
            "--target=es2022",
            "--external:cloudflare:workers",
            "--external:cloudflare:workflows",
            "--external:cloudflare:sockets",
            "--external:node:async_hooks",
            "--legal-comments=eof",
            "--log-level=warning",
            "--sourcemap=external",
        ])
        .arg(format!("--outfile={}", output.join("worker.js").display()))
        .arg(format!(
            "--metafile={}",
            output.join("metadata.json").display()
        ))
        .current_dir(project)
        .kill_on_drop(true);
    if node_compat {
        // Match celld 0.6.1's builtin resolution, including package subpaths.
        // https://github.com/denoland/celld/blob/v0.6.1/crates/celld/engine_api.rs
        let builtins = [
            "assert",
            "async_hooks",
            "buffer",
            "child_process",
            "cluster",
            "constants",
            "crypto",
            "dgram",
            "diagnostics_channel",
            "dns",
            "events",
            "fs",
            "http",
            "http2",
            "https",
            "inspector",
            "module",
            "net",
            "os",
            "path",
            "perf_hooks",
            "process",
            "punycode",
            "querystring",
            "readline",
            "sqlite",
            "stream",
            "string_decoder",
            "timers",
            "tls",
            "tty",
            "url",
            "util",
            "v8",
            "vm",
            "worker_threads",
            "zlib",
        ];
        // The agent uses no_bundle, so supply the builtin-only CommonJS bridge
        // that celld's own bundler would normally provide. npm code stays bundled.
        let require_builtin = r#"var require = (specifier) => {
  const builtin = globalThis.process.getBuiltinModule(specifier);
  if (builtin !== undefined) return builtin;
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: "MODULE_NOT_FOUND" });
};"#;
        command
            .args(["--external:node:*", "--conditions=workerd,worker,browser"])
            .args(builtins.map(|name| format!("--external:{name}")))
            .arg(format!("--banner:js={require_builtin}"));
    }
    let status = command.status().await?;
    if !status.success() {
        return Err(Error::invalid(
            "Worker bundling failed; see esbuild diagnostics above".into(),
        ));
    }
    // The source map is uploaded privately, separate from runtime code and public assets.
    if std::fs::read_dir(output)?.count() != 3 || !output.join("worker.js.map").is_file() {
        return Err(Error::invalid(
            "Expected one bundled Worker module and its source map; additional output files are unsupported"
                .into(),
        ));
    }
    #[derive(Deserialize)]
    struct Output {
        exports: Option<Vec<String>>,
    }
    #[derive(Deserialize)]
    struct Metadata {
        outputs: BTreeMap<String, Output>,
    }
    let metadata: Metadata = serde_json::from_slice(&std::fs::read(output.join("metadata.json"))?)?;
    let exports = metadata
        .outputs
        .into_iter()
        .find(|(path, _)| path.ends_with("/worker.js") || path == "worker.js")
        .and_then(|(_, output)| output.exports)
        .ok_or_else(|| Error::invalid("Bundled Worker exports are missing".into()))?;
    Ok(Bundle {
        source: std::fs::read(output.join("worker.js"))?,
        exports,
    })
}

pub async fn wait(
    api: &Api,
    credentials: &auth::Credentials,
    app: Uuid,
    deployment: Uuid,
) -> Result<Deployment> {
    tokio::select! {
        // Register the handler before starting the first status request.
        biased;
        signal = tokio::signal::ctrl_c() => {
            signal?;
            Err(Error::invalid("Stopped waiting; the queued deployment continues on the agent".into()))
        }
        result = poll_deployment(api, credentials, app, deployment) => result,
    }
}

async fn poll_deployment(
    api: &Api,
    credentials: &auth::Credentials,
    app: Uuid,
    deployment: Uuid,
) -> Result<Deployment> {
    let mut displayed = BTreeSet::new();
    loop {
        let token = auth::access_token(api, credentials).await?;
        #[derive(Deserialize)]
        struct Event {
            id: u64,
            message: String,
        }
        let events: Vec<Event> = json(
            api.authenticated(
                Method::GET,
                &format!("/apps/{app}/deployments/{deployment}/events"),
                &token,
            )
            .send()
            .await?,
        )
        .await?;
        for event in events {
            if displayed.insert(event.id) {
                eprintln!("{}", event.message);
            }
        }
        let history: Vec<Deployment> = json(
            api.authenticated(Method::GET, &format!("/apps/{app}/deployments"), &token)
                .send()
                .await?,
        )
        .await?;
        let current = history
            .into_iter()
            .find(|item| item.id == deployment)
            .ok_or_else(|| Error::invalid("Deployment no longer appears in history".into()))?;
        match current.status.as_str() {
            "succeeded" => return Ok(current),
            "failed" => {
                return Err(Error::invalid(
                    current
                        .message
                        .unwrap_or_else(|| "Deployment failed".into()),
                ));
            }
            "queued" | "running" => {}
            status => {
                return Err(Error::invalid(format!(
                    "Unknown deployment status: {status}"
                )));
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_inventory_uses_url_paths_and_deduplicates_by_hash() -> Result<()> {
        let directory = tempfile::tempdir()?;
        std::fs::create_dir(directory.path().join("nested"))?;
        std::fs::write(directory.path().join("one.txt"), b"hello")?;
        std::fs::write(directory.path().join("nested/two.txt"), b"hello")?;
        let assets = collect_assets(directory.path())?;
        assert_eq!(assets.manifest.len(), 2);
        assert_eq!(assets.files.len(), 1);
        assert!(assets.manifest.contains_key("/nested/two.txt"));
        Ok(())
    }

    #[test]
    fn source_maps_never_enter_the_public_asset_manifest() -> Result<()> {
        let directory = tempfile::tempdir()?;
        std::fs::create_dir(directory.path().join("chunks"))?;
        std::fs::write(
            directory.path().join("chunks/app.js"),
            b"throw new Error('fixture');",
        )?;
        std::fs::write(
            directory.path().join("chunks/app.js.map"),
            b"private source content",
        )?;
        let assets = collect_assets(directory.path())?;
        assert_eq!(assets.manifest.len(), 1);
        assert_eq!(assets.files.len(), 1);
        assert!(assets.manifest.contains_key("/chunks/app.js"));
        assert_eq!(assets.source_maps.len(), 1);
        assert!(assets.source_maps.contains_key("/chunks/app.js"));
        Ok(())
    }

    #[test]
    #[cfg(unix)]
    fn asset_inventory_rejects_symlinks() -> Result<()> {
        let directory = tempfile::tempdir()?;
        std::os::unix::fs::symlink("/etc/hosts", directory.path().join("file.txt"))?;
        assert!(collect_assets(directory.path()).is_err());
        Ok(())
    }
}
