use crate::{apps, auth, deploy};
use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::{CapabilityGrant, ConnectorPackage, ReleaseModule},
    sha256,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    io::{IsTerminal, Read},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Bundle and deploy the connector in the current project.
    Deploy {
        #[arg(long, default_value = "wrangler.jsonc")]
        config: PathBuf,
        #[arg(long)]
        no_wait: bool,
    },
    /// Manage secrets for an installed connector.
    Secret {
        #[command(subcommand)]
        command: SecretCommand,
    },
    /// List deployed connectors and their activation status.
    List,
    /// Inspect one connector by name.
    Show { name: String },
    /// Grant an app a native RPC binding to an installed connector.
    Bind {
        connector: String,
        #[arg(long = "as")]
        binding: String,
        #[arg(long, default_value = "default")]
        entrypoint: String,
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        no_wait: bool,
    },
    /// Remove a connector binding from an app.
    Unbind {
        binding: String,
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        no_wait: bool,
    },
    /// Show the current project's connector bindings, or select --app NAME.
    Bindings(Target),
}

#[derive(Subcommand)]
enum SecretCommand {
    /// Read a secret value from stdin or --file and activate it.
    Put {
        connector: String,
        name: String,
        #[arg(long)]
        file: Option<PathBuf>,
        #[arg(long)]
        no_wait: bool,
    },
    /// List secret names and their activation status. Values are never returned.
    List { connector: String },
    /// Remove a secret and activate the new configuration.
    Delete {
        connector: String,
        name: String,
        #[arg(long)]
        no_wait: bool,
    },
}

#[derive(Args)]
struct Target {
    #[arg(long)]
    app: Option<String>,
    #[arg(long, default_value = "wrangler.jsonc")]
    config: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    name: String,
    checksum: String,
    applied_checksum: Option<String>,
    job_id: Uuid,
    state: String,
    message: Option<String>,
    entrypoints: Vec<String>,
    #[serde(default)]
    secrets: Vec<String>,
    #[serde(default)]
    secret_revision: u64,
    #[serde(default)]
    applied_secret_revision: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bindings {
    revision: u64,
    grants: std::collections::BTreeMap<String, CapabilityGrant>,
    applied_revision: Option<u64>,
    state: String,
    error: Option<String>,
}

fn segment(value: &str) -> Result<&str> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(Error::invalid(
            "Use a connector or binding name, without a URL or path".into(),
        ));
    }
    Ok(value)
}

async fn get<T: serde::de::DeserializeOwned>(
    api: &Api,
    credentials: &auth::Credentials,
    path: &str,
) -> Result<T> {
    let token = auth::access_token(api, credentials).await?;
    json(api.authenticated(Method::GET, path, &token).send().await?).await
}

fn show(status: &Status, json_output: bool) -> Result<()> {
    if json_output {
        return crate::print_json(status);
    }
    println!("{}: {}", status.name, status.state);
    println!("Entrypoints: {}", status.entrypoints.join(", "));
    println!("Secrets: {}", status.secrets.join(", "));
    println!(
        "Secret revision: {} (active: {})",
        status.secret_revision,
        status
            .applied_secret_revision
            .map_or_else(|| "none".into(), |revision| revision.to_string())
    );
    if let Some(message) = &status.message {
        eprintln!("{message}");
    }
    Ok(())
}

fn show_bindings(state: &Bindings, json_output: bool) -> Result<()> {
    if json_output {
        return crate::print_json(state);
    }
    println!("Connector bindings: {}", state.state);
    for (name, grant) in &state.grants {
        println!("  {name} → {} ({})", grant.connector, grant.entrypoint);
    }
    if state.grants.is_empty() {
        println!("  No connector bindings");
    }
    if let Some(error) = &state.error {
        eprintln!("{error}");
    }
    Ok(())
}

async fn package(config: &Path) -> Result<ConnectorPackage> {
    let config = config.canonicalize()?;
    let project = config
        .parent()
        .ok_or_else(|| Error::invalid("Connector configuration has no directory".into()))?;
    let mut configuration: Value = jsonc_parser::parse_to_serde_value(
        &std::fs::read_to_string(&config)?,
        &jsonc_parser::ParseOptions::default(),
    )
    .map_err(|error| Error::invalid(format!("Invalid Wrangler configuration: {error}")))?;
    let name = configuration
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::invalid("Set name in the connector's Wrangler configuration".into()))?
        .to_owned();
    segment(&name)?;
    let main = configuration
        .get("main")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Error::invalid("Set main in the connector's Wrangler configuration".into())
        })?;
    let entry = project.join(main).canonicalize()?;
    if !entry.starts_with(project) {
        return Err(Error::invalid(
            "Connector entry must be inside its project".into(),
        ));
    }
    let temporary = tempfile::tempdir_in(project)?;
    let node_compat = configuration
        .get("compatibility_flags")
        .and_then(Value::as_array)
        .is_some_and(|flags| flags.iter().any(|flag| flag == "nodejs_compat"));
    let bundler = crate::installation::bundler().await?;
    let bundled = deploy::bundle(&bundler, project, &entry, temporary.path(), node_compat).await?;
    if !bundled.exports.iter().any(|name| name == "default") {
        return Err(Error::invalid("celld requires a default Worker export; export your WorkerEntrypoint class as default, or provide a default fetch handler alongside named entrypoints".into()));
    }
    let source =
        String::from_utf8(bundled.source).map_err(|error| Error::invalid(error.to_string()))?;
    let classes: BTreeSet<_> = configuration
        .pointer("/durable_objects/bindings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|binding| binding.get("class_name").and_then(Value::as_str))
        .collect();
    let entrypoints = bundled
        .exports
        .into_iter()
        .filter(|name| !classes.contains(name.as_str()))
        .collect();
    let object = configuration
        .as_object_mut()
        .ok_or_else(|| Error::invalid("Expected a Wrangler configuration object".into()))?;
    for key in ["name", "main", "$schema", "no_bundle"] {
        object.remove(key);
    }
    Ok(ConnectorPackage {
        protocol: 1,
        name,
        main: "worker.js".into(),
        entrypoints,
        modules: vec![ReleaseModule {
            name: "worker.js".into(),
            sha256: sha256(source.as_bytes()),
            source,
        }],
        configuration,
    })
}

async fn change_binding(
    api: &Api,
    credentials: &auth::Credentials,
    target: Target,
    binding: String,
    grant: Option<CapabilityGrant>,
    no_wait: bool,
    json_output: bool,
) -> Result<()> {
    segment(&binding)?;
    let app = apps::resolve(api, credentials, target.app.as_deref(), &target.config).await?;
    let token = auth::access_token(api, credentials).await?;
    let mut request = api.authenticated(
        if grant.is_some() {
            Method::PUT
        } else {
            Method::DELETE
        },
        &format!("/apps/{app}/bindings/{binding}"),
        &token,
    );
    if let Some(grant) = grant {
        request = request.json(&grant);
    }
    let mut current: Bindings = json(request.send().await?).await?;
    let revision = current.revision;
    if !no_wait {
        while current.state == "pending" {
            tokio::time::sleep(Duration::from_secs(1)).await;
            current = get(api, credentials, &format!("/apps/{app}/bindings")).await?;
            if current.revision != revision {
                return Err(Error::invalid("A newer binding change was saved; use widefleet connector bindings to inspect it".into()));
            }
        }
    }
    show_bindings(&current, json_output)?;
    if current.state == "failed" {
        return Err(Error::invalid(
            current
                .error
                .unwrap_or_else(|| "Binding activation failed".into()),
        ));
    }
    Ok(())
}

fn secret_value(file: Option<PathBuf>) -> Result<String> {
    const LIMIT: u64 = 65536;
    let mut value = String::new();
    match file {
        Some(path) => {
            std::fs::File::open(path)?
                .take(LIMIT + 1)
                .read_to_string(&mut value)?;
        }
        None => {
            let stdin = std::io::stdin();
            if stdin.is_terminal() {
                return Err(Error::invalid(
                    "Provide the secret through redirected stdin or --file PATH".into(),
                ));
            }
            stdin.lock().take(LIMIT + 1).read_to_string(&mut value)?;
        }
    }
    if value.is_empty() || value.len() > LIMIT as usize {
        return Err(Error::invalid(
            "Secret value must contain 1–65536 UTF-8 bytes".into(),
        ));
    }
    Ok(value)
}

async fn wait_for_connector(
    api: &Api,
    credentials: &auth::Credentials,
    mut current: Status,
    no_wait: bool,
    json_output: bool,
) -> Result<()> {
    let job = current.job_id;
    let path = format!("/connectors/{}", segment(&current.name)?);
    if !no_wait {
        while matches!(current.state.as_str(), "queued" | "running") {
            tokio::time::sleep(Duration::from_secs(1)).await;
            current = get(api, credentials, &path).await?;
            if current.job_id != job {
                return Err(Error::invalid("A newer connector change was submitted; use widefleet connector show to inspect it".into()));
            }
        }
    }
    show(&current, json_output)?;
    if current.state == "failed" {
        return Err(Error::invalid(
            current
                .message
                .unwrap_or_else(|| "Connector activation failed".into()),
        ));
    }
    Ok(())
}

async fn secret_command(
    api: &Api,
    credentials: &auth::Credentials,
    command: SecretCommand,
    json_output: bool,
) -> Result<()> {
    let (connector, name, value, no_wait) = match command {
        SecretCommand::List { connector } => {
            let current: Status = get(
                api,
                credentials,
                &format!("/connectors/{}/secrets", segment(&connector)?),
            )
            .await?;
            return show(&current, json_output);
        }
        SecretCommand::Put {
            connector,
            name,
            file,
            no_wait,
        } => (connector, name, Some(secret_value(file)?), no_wait),
        SecretCommand::Delete {
            connector,
            name,
            no_wait,
        } => (connector, name, None, no_wait),
    };
    let path = format!(
        "/connectors/{}/secrets/{}",
        segment(&connector)?,
        segment(&name)?
    );
    let token = auth::access_token(api, credentials).await?;
    let mut request = api.authenticated(
        if value.is_some() {
            Method::PUT
        } else {
            Method::DELETE
        },
        &path,
        &token,
    );
    if let Some(value) = value {
        request = request.json(&serde_json::json!({ "value": value }));
    }
    let current = json(request.send().await?).await?;
    wait_for_connector(api, credentials, current, no_wait, json_output).await
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let json_output = options.json || !std::io::stdout().is_terminal();
    match options.command {
        Command::Deploy { config, no_wait } => {
            let package = package(&config).await?;
            eprintln!(
                "Deploying connector {} on {}",
                package.name,
                api.origin_text()
            );
            let token = auth::access_token(api, credentials).await?;
            let path = format!("/connectors/{}", package.name);
            let current: Status = json(
                api.authenticated(Method::PUT, &path, &token)
                    .json(&package)
                    .send()
                    .await?,
            )
            .await?;
            wait_for_connector(api, credentials, current, no_wait, json_output).await
        }
        Command::Secret { command } => secret_command(api, credentials, command, json_output).await,

        Command::List => {
            let statuses: Vec<Status> = get(api, credentials, "/connectors").await?;
            if json_output {
                crate::print_json(&statuses)
            } else {
                for status in statuses {
                    show(&status, false)?;
                }
                Ok(())
            }
        }
        Command::Show { name } => show(
            &get(
                api,
                credentials,
                &format!("/connectors/{}", segment(&name)?),
            )
            .await?,
            json_output,
        ),
        Command::Bindings(target) => {
            let app =
                apps::resolve(api, credentials, target.app.as_deref(), &target.config).await?;
            show_bindings(
                &get(api, credentials, &format!("/apps/{app}/bindings")).await?,
                json_output,
            )
        }
        Command::Bind {
            connector,
            binding,
            entrypoint,
            target,
            no_wait,
        } => {
            change_binding(
                api,
                credentials,
                target,
                binding,
                Some(CapabilityGrant {
                    connector,
                    entrypoint,
                }),
                no_wait,
                json_output,
            )
            .await
        }
        Command::Unbind {
            binding,
            target,
            no_wait,
        } => {
            change_binding(
                api,
                credentials,
                target,
                binding,
                None,
                no_wait,
                json_output,
            )
            .await
        }
    }
}
