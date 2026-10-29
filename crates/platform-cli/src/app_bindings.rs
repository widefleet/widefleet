use crate::{apps, auth};
use clap::Args;
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::CapabilityGrant,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::{
    io::{IsTerminal, Read},
    path::PathBuf,
    time::Duration,
};
#[derive(Args)]
pub(crate) struct Target {
    #[arg(long)]
    app: Option<String>,
    #[arg(long, default_value = "wrangler.jsonc")]
    config: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bindings {
    revision: u64,
    grants: std::collections::BTreeMap<String, CapabilityGrant>,
    applied_revision: Option<u64>,
    state: String,
    error: Option<String>,
}

pub(crate) fn segment(value: &str) -> Result<&str> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(Error::invalid(
            "Use a binding or secret name, without a URL or path".into(),
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

pub(crate) fn show_bindings(state: &Bindings, json_output: bool) -> Result<()> {
    if json_output {
        return crate::print_json(state);
    }
    println!("App connections: {}", state.state);
    for (name, grant) in &state.grants {
        println!("  {name} → {} ({})", grant.app, grant.entrypoint);
    }
    if state.grants.is_empty() {
        println!("  No app connections");
    }
    if let Some(error) = &state.error {
        eprintln!("{error}");
    }
    Ok(())
}

pub(crate) async fn change_binding(
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
                return Err(Error::invalid(
                    "A newer binding change was saved; use widefleet connections to inspect it"
                        .into(),
                ));
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

pub(crate) fn secret_value(file: Option<PathBuf>) -> Result<String> {
    const LIMIT: u64 = 5000;
    let mut value = Vec::new();
    match file {
        Some(path) => {
            std::fs::File::open(path)?
                .take(LIMIT + 1)
                .read_to_end(&mut value)?;
        }
        None => {
            let stdin = std::io::stdin();
            if stdin.is_terminal() {
                return Err(Error::invalid(
                    "Provide the secret through redirected stdin or --file PATH".into(),
                ));
            }
            stdin.lock().take(LIMIT + 1).read_to_end(&mut value)?;
        }
    }
    if value.is_empty() || value.len() > LIMIT as usize {
        return Err(Error::invalid(
            "Secret value must contain 1–5000 UTF-8 bytes".into(),
        ));
    }
    String::from_utf8(value).map_err(|_| Error::invalid("Secret value must be valid UTF-8".into()))
}
