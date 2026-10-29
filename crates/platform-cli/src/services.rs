use crate::{app_bindings, apps, auth, deploy};
use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::{CapabilityGrant, Deployment},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::{io::IsTerminal, path::PathBuf};
use uuid::Uuid;

#[derive(Args)]
pub struct Connect {
    target: String,
    #[arg(long = "as")]
    binding: String,
    #[arg(long, default_value = "default")]
    entrypoint: String,
    #[command(flatten)]
    source: app_bindings::Target,
    #[arg(long)]
    no_wait: bool,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
pub struct Disconnect {
    binding: String,
    #[command(flatten)]
    source: app_bindings::Target,
    #[arg(long)]
    no_wait: bool,
    #[arg(long)]
    json: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Service {
    app_id: Uuid,
    slug: String,
    display_name: String,
    entrypoints: Vec<String>,
}

pub async fn catalog(api: &Api, credentials: &auth::Credentials) -> Result<()> {
    let token = auth::access_token(api, credentials).await?;
    let entries: Vec<Service> = json(
        api.authenticated(Method::GET, "/app-services", &token)
            .send()
            .await?,
    )
    .await?;
    crate::print_json(&entries)
}

pub async fn connect(api: &Api, credentials: &auth::Credentials, options: Connect) -> Result<()> {
    let token = auth::access_token(api, credentials).await?;
    let entries: Vec<Service> = json(
        api.authenticated(Method::GET, "/app-services", &token)
            .send()
            .await?,
    )
    .await?;
    let target = entries
        .iter()
        .find(|app| app.slug == options.target || app.app_id.to_string() == options.target)
        .ok_or_else(|| Error::invalid("Target app has no available service API".into()))?;
    app_bindings::change_binding(
        api,
        credentials,
        options.source,
        options.binding,
        Some(CapabilityGrant {
            app: target.app_id,
            entrypoint: options.entrypoint,
        }),
        options.no_wait,
        options.json,
    )
    .await
}

pub async fn disconnect(
    api: &Api,
    credentials: &auth::Credentials,
    options: Disconnect,
) -> Result<()> {
    app_bindings::change_binding(
        api,
        credentials,
        options.source,
        options.binding,
        None,
        options.no_wait,
        options.json,
    )
    .await
}

#[derive(Args)]
pub struct Secrets {
    #[arg(long, global = true)]
    app: Option<String>,
    #[arg(long, global = true, default_value = "wrangler.jsonc")]
    config: PathBuf,
    #[arg(long, global = true)]
    json: bool,
    #[arg(long, global = true)]
    no_wait: bool,
    #[command(subcommand)]
    command: SecretCommand,
}

#[derive(Subcommand)]
enum SecretCommand {
    List,
    Put {
        name: String,
        #[arg(long)]
        file: Option<PathBuf>,
    },
    Delete {
        name: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretStatus {
    names: Vec<String>,
    revision: u64,
    applied_revision: Option<u64>,
    deployment: Option<Deployment>,
}

pub async fn secrets(api: &Api, credentials: &auth::Credentials, options: Secrets) -> Result<()> {
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    let token = auth::access_token(api, credentials).await?;
    let path = format!("/apps/{app}/secrets");
    let request = match options.command {
        SecretCommand::List => api.authenticated(Method::GET, &path, &token),
        SecretCommand::Put { name, file } => {
            let name = app_bindings::segment(&name)?;
            api.authenticated(Method::PUT, &format!("{path}/{name}"), &token)
                .json(&serde_json::json!({ "value": app_bindings::secret_value(file)? }))
        }
        SecretCommand::Delete { name } => api.authenticated(
            Method::DELETE,
            &format!("{path}/{}", app_bindings::segment(&name)?),
            &token,
        ),
    };
    let mut status: SecretStatus = json(request.send().await?).await?;
    if !options.no_wait
        && let Some(deployment) = &status.deployment
        && (deployment.status == "queued" || deployment.status == "running")
    {
        deploy::wait(api, credentials, app, deployment.id).await?;
        let token = auth::access_token(api, credentials).await?;
        status = json(api.authenticated(Method::GET, &path, &token).send().await?).await?;
    }
    if options.json || !std::io::stdout().is_terminal() {
        return crate::print_json(&status);
    }
    println!("Secrets: {}", status.names.join(", "));
    println!(
        "Revision: {} (active: {:?})",
        status.revision, status.applied_revision
    );
    Ok(())
}
