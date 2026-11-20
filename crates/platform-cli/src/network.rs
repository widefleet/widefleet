use crate::{apps, auth};
use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::NetworkPolicy,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json as value;
use std::{io::IsTerminal, path::PathBuf, time::Duration};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    /// App name; otherwise use the current project's name.
    #[arg(long, global = true)]
    app: Option<String>,
    #[arg(long, global = true, default_value = "wrangler.jsonc")]
    config: PathBuf,
    /// Print the complete state as JSON (also the default for redirected output).
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Show allowed destinations and activation status.
    Show,
    /// Allow one or more exact HTTPS origins.
    Allow(Change),
    /// Remove one or more allowed origins.
    Deny(Change),
}

#[derive(Args)]
struct Change {
    #[arg(required = true, num_args = 1..)]
    origins: Vec<String>,
    /// Change browser access instead of backend access.
    #[arg(long)]
    browser: bool,
    /// Return after saving, without waiting for activation.
    #[arg(long)]
    no_wait: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    policy: NetworkPolicy,
    revision: u64,
    applied_revision: Option<u64>,
    state: String,
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    requested: Option<NetworkPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    undeclared: Option<NetworkPolicy>,
}

/// The declared origins the app is not allowed to reach yet, when any. A
/// deployment token without read access only skips this report.
pub(crate) async fn requested(
    api: &Api,
    credentials: &auth::Credentials,
    app: Uuid,
) -> Option<NetworkPolicy> {
    let requested = status(api, credentials, app).await.ok()?.requested?;
    (!requested.backend.is_empty() || !requested.browser.is_empty()).then_some(requested)
}

// Origins come from the app, so the printed commands quote every argument for
// POSIX shells.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Prints the commands that allow the requested origins for this exact app on
/// the same platform and organization, so a preview's request never changes
/// its parent app.
pub(crate) fn print_requested(api: &Api, app: Uuid, requested: &NetworkPolicy) {
    eprintln!("This version requests network access that is not allowed yet.");
    eprintln!("The app's owner or an administrator can allow it:");
    let mut prefix = format!("widefleet --url {}", quote(&api.origin_text()));
    if let Some(organization) = api.organization_text() {
        prefix.push_str(&format!(" --organization {}", quote(&organization)));
    }
    for (flag, origins) in [("", &requested.backend), (" --browser", &requested.browser)] {
        if !origins.is_empty() {
            let origins: Vec<String> = origins.iter().map(|origin| quote(origin)).collect();
            eprintln!(
                "  {prefix} network allow --app {app}{flag} {}",
                origins.join(" ")
            );
        }
    }
}

async fn status(api: &Api, credentials: &auth::Credentials, app: Uuid) -> Result<State> {
    let token = auth::access_token(api, credentials).await?;
    json(
        api.authenticated(Method::GET, &format!("/apps/{app}/network"), &token)
            .send()
            .await?,
    )
    .await
}

fn output(api: &Api, app: Uuid, state: &State, json_output: bool) -> Result<()> {
    if json_output {
        return super::print_json(state);
    }
    println!("Network permissions: {}", state.state);
    for (name, origins) in [
        ("Backend", &state.policy.backend),
        ("Browser", &state.policy.browser),
    ] {
        println!("{name}:");
        if origins.is_empty() {
            println!("  No external origins allowed");
        }
        for origin in origins {
            println!("  {origin}");
        }
    }
    if let Some(undeclared) = &state.undeclared {
        for (name, origins) in [
            ("backend", &undeclared.backend),
            ("browser", &undeclared.browser),
        ] {
            for origin in origins {
                println!("Allowed {name} origin {origin} is not requested by the current version");
            }
        }
    }
    if let Some(requested) = &state.requested
        && (!requested.backend.is_empty() || !requested.browser.is_empty())
    {
        print_requested(api, app, requested);
    }
    if state.state == "saved" {
        println!("Saved for the app's first deployment.");
    }
    if let Some(error) = &state.error {
        eprintln!("{error}");
    }
    Ok(())
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    let json_output = options.json || !std::io::stdout().is_terminal();
    let (action, change) = match options.command {
        Some(Command::Allow(change)) => ("allow", change),
        Some(Command::Deny(change)) => ("deny", change),
        Some(Command::Show) | None => {
            return output(api, app, &status(api, credentials, app).await?, json_output);
        }
    };
    let token = auth::access_token(api, credentials).await?;
    let mut current: State = json(api.authenticated(Method::PATCH, &format!("/apps/{app}/network"), &token)
        .json(&value!({ "target": if change.browser { "browser" } else { "backend" }, "action": action, "origins": change.origins }))
        .send().await?).await?;
    let revision = current.revision;
    if !change.no_wait {
        while current.state == "pending" {
            tokio::time::sleep(Duration::from_secs(1)).await;
            current = status(api, credentials, app).await?;
            if current.revision != revision {
                return Err(Error::invalid(
                    "A newer network change was saved; use widefleet network to inspect its status"
                        .into(),
                ));
            }
        }
    }
    output(api, app, &current, json_output)?;
    if current.state == "failed" {
        return Err(Error::invalid(
            current
                .error
                .unwrap_or_else(|| "Network activation failed".into()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn printed_origins_never_reach_the_shell_unquoted() {
        assert_eq!(
            quote("https://api.example.test$(id)"),
            "'https://api.example.test$(id)'"
        );
        assert_eq!(quote("it's"), r"'it'\''s'");
    }
}
