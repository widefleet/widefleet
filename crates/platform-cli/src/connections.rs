use crate::{apps, auth, connector};
use clap::Args;
use platform_core::{
    Result,
    http::{Api, json},
    model::CapabilityGrant,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::IsTerminal, path::PathBuf};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[arg(long)]
    app: Option<String>,
    #[arg(long, default_value = "wrangler.jsonc")]
    config: PathBuf,
    #[arg(long)]
    json: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Resource {
    binding: String,
    r#type: String,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    database_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Connections {
    deployment_id: Option<Uuid>,
    resources: Vec<Resource>,
    connectors: connector::Bindings,
    active_connectors: Option<BTreeMap<String, CapabilityGrant>>,
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    let token = auth::access_token(api, credentials).await?;
    let connections: Connections = json(
        api.authenticated(Method::GET, &format!("/apps/{app}/connections"), &token)
            .send()
            .await?,
    )
    .await?;
    if options.json || !std::io::stdout().is_terminal() {
        return crate::print_json(&connections);
    }
    connector::show_bindings(&connections.connectors, false)?;
    println!("Active connector bindings:");
    match &connections.active_connectors {
        Some(grants) => {
            for (binding, grant) in grants {
                println!("  {binding} → {} ({})", grant.connector, grant.entrypoint);
            }
            if grants.is_empty() {
                println!("  None");
            }
        }
        None => println!("  Could not confirm active bindings"),
    }
    println!("Resources in the active deployment:");
    for resource in &connections.resources {
        println!(
            "  {} → {} ({})",
            resource.binding, resource.target, resource.r#type
        );
        if let Some(database_id) = &resource.database_id {
            println!("    Database ID: {database_id}");
        }
    }
    if connections.deployment_id.is_none() {
        println!("  No active deployment");
    } else if connections.resources.is_empty() {
        println!("  None");
    }
    Ok(())
}
