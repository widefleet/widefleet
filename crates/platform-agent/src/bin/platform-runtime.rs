use clap::Parser;
use object_store::{ObjectStore, ObjectStoreExt, path::Path as ObjectPath};
use platform_agent::{runtime, storage::StorageOptions};
use platform_core::{Error, Result, model::RuntimeRelease};
use serde::Deserialize;
use serde_json::json;
use std::{net::ToSocketAddrs, os::unix::process::CommandExt, path::PathBuf, process::Command};

#[derive(Parser)]
struct Options {
    #[arg(
        long,
        env = "PLATFORM_RUNTIME_CONFIGURATION",
        default_value = "/runtime-config/installation.json"
    )]
    configuration: PathBuf,
    #[arg(
        long,
        env = "PLATFORM_RUNTIME_RELEASE",
        default_value = "/opt/widefleet-runtime/release.json"
    )]
    release: PathBuf,
    #[arg(long, env = "CELLD_BINARY", default_value = "/usr/local/bin/celld")]
    celld: PathBuf,
    #[arg(long, env = "CELLD_ADVERTISE")]
    advertise: Option<String>,
    #[command(flatten)]
    storage: StorageOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation {
    organization_id: String,
    control_token: String,
}

async fn read(store: &dyn ObjectStore, path: String) -> Result<Option<Vec<u8>>> {
    match store.get(&ObjectPath::from(path)).await {
        Ok(value) => Ok(Some(value.bytes().await.map_err(storage_error)?.to_vec())),
        Err(object_store::Error::NotFound { .. }) => Ok(None),
        Err(error) => Err(storage_error(error)),
    }
}

fn storage_error(error: object_store::Error) -> Error {
    Error::invalid(format!("Runtime storage operation failed: {error}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut options = Options::parse();
    let installation: Installation =
        serde_json::from_slice(&tokio::fs::read(&options.configuration).await?)?;
    if installation.control_token.len() < 32 {
        return Err(Error::invalid("Invalid runtime control token".into()));
    }
    // Credentials are already mounted in this container; only the agent needs
    // a second, Docker-host path when mounting files in other containers.
    options.storage.credential_host_file = options
        .storage
        .azure_token_file
        .clone()
        .or(options.storage.google_credentials.clone());
    let storage = options.storage.resolve()?;
    let store = storage.object_store()?;
    let prefix = format!("organizations/{}", installation.organization_id);
    let key = format!("{prefix}/control-token");
    match read(store.as_ref(), key.clone()).await? {
        Some(value) if value != installation.control_token.as_bytes() => {
            return Err(Error::invalid(
                "Runtime control token does not match installed storage".into(),
            ));
        }
        Some(_) => {}
        None => {
            store
                .put(
                    &ObjectPath::from(key),
                    installation.control_token.clone().into(),
                )
                .await
                .map_err(storage_error)?;
        }
    }

    // A container restart must preserve runtime updates and installed bindings.
    if read(store.as_ref(), format!("{prefix}/deploy/current.json"))
        .await?
        .is_none()
    {
        let release: RuntimeRelease =
            serde_json::from_slice(&tokio::fs::read(&options.release).await?)?;
        let connector_key =
            runtime::connector_key(store.as_ref(), &installation.organization_id).await?;
        let config = runtime::configuration(&release, &installation.control_token, &connector_key)?;
        let directory = tempfile::tempdir()?;
        for module in &release.modules {
            if module.name != "loader.js"
                || platform_core::sha256(module.source.as_bytes()) != module.sha256
            {
                return Err(Error::invalid("Invalid bundled runtime module".into()));
            }
            tokio::fs::write(directory.path().join(&module.name), &module.source).await?;
        }
        tokio::fs::write(
            directory.path().join("wrangler.json"),
            serde_json::to_vec(&config)?,
        )
        .await?;
        let status = tokio::process::Command::new(&options.celld)
            .arg("deploy")
            .arg(directory.path())
            .args(storage.arguments(&installation.organization_id, false))
            .envs(storage.environment(false))
            .status()
            .await?;
        if !status.success() {
            return Err(Error::invalid("Initial runtime deployment failed".into()));
        }
    }

    let arguments = storage.arguments(&installation.organization_id, false);
    tokio::fs::write(
        "/state/runtime.json",
        serde_json::to_vec(&json!({
            "organizationId": installation.organization_id, "arguments": arguments,
            "azureAccount": std::env::var("AZURE_STORAGE_ACCOUNT_NAME").ok(),
        }))?,
    )
    .await?;
    let advertise = match options.advertise {
        Some(value) => value,
        None => {
            let hostname = std::env::var("HOSTNAME")
                .map_err(|_| Error::invalid("Set CELLD_ADVERTISE outside Docker".into()))?;
            (hostname.as_str(), 8081)
                .to_socket_addrs()?
                .find(|address| address.is_ipv4())
                .ok_or_else(|| Error::invalid("Runtime hostname has no IPv4 address".into()))?
                .to_string()
        }
    };
    let error = Command::new(options.celld)
        .args(arguments)
        .envs(storage.environment(false))
        .args([
            "--listen",
            "0.0.0.0:8080",
            "--internal-listen",
            "0.0.0.0:8081",
            "--advertise",
            &advertise,
            "--trust-forwarded-headers",
        ])
        .exec();
    Err(error.into())
}
