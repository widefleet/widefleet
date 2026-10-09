use crate::{apps, auth};
use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::AppAccessSnapshot,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::{io::IsTerminal, path::PathBuf, time::Duration};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    /// App name or ID; otherwise use the current project's name.
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
    /// Show access groups, inheritance and activation for the app and its previews.
    Show,
    /// Replace the app's group list. All previews inherit it automatically.
    Set(Change),
}

#[derive(Args)]
struct Change {
    /// An allowed group ID. Repeat for additional groups; membership in any one suffices.
    #[arg(
        long = "group",
        value_name = "GROUP_ID",
        required_unless_present = "all_authenticated",
        conflicts_with = "all_authenticated"
    )]
    groups: Vec<String>,
    /// Allow every company SSO user. Anonymous access remains disabled.
    #[arg(long)]
    all_authenticated: bool,
    /// Return after saving, without waiting for the app and published previews.
    #[arg(long)]
    no_wait: bool,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Activation {
    Saved,
    Pending,
    Active,
    Failed,
}

impl Activation {
    fn label(&self) -> &str {
        match self {
            Self::Saved => "saved for first deployment",
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Failed => "failed",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    #[serde(flatten)]
    policy: AppAccessSnapshot,
    applied_revision: Option<u64>,
    state: Activation,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    #[serde(flatten)]
    status: Status,
    app_id: Uuid,
    hostname: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    #[serde(flatten)]
    status: Status,
    inherited_from: Option<Uuid>,
    can_manage: bool,
    previews: Vec<Preview>,
}

impl State {
    fn failure(&self) -> Option<String> {
        if self.status.state == Activation::Failed {
            return Some(
                self.status
                    .error
                    .clone()
                    .unwrap_or_else(|| "App access activation failed".into()),
            );
        }
        self.previews
            .iter()
            .find(|preview| preview.status.state == Activation::Failed)
            .map(|preview| {
                format!(
                    "Preview {}: {}",
                    preview.hostname,
                    preview
                        .status
                        .error
                        .as_deref()
                        .unwrap_or("Access activation failed")
                )
            })
    }

    fn pending(&self) -> bool {
        self.status.state == Activation::Pending
            || self
                .previews
                .iter()
                .any(|preview| preview.status.state == Activation::Pending)
    }
}

async fn status(api: &Api, credentials: &auth::Credentials, app: Uuid) -> Result<State> {
    let token = auth::access_token(api, credentials).await?;
    json(
        api.authenticated(Method::GET, &format!("/apps/{app}/access"), &token)
            .send()
            .await?,
    )
    .await
}

fn output(state: &State, json_output: bool) -> Result<()> {
    if json_output {
        return super::print_json(state);
    }
    println!("App access: {}", state.status.state.label());
    if let Some(parent) = state.inherited_from {
        println!("Inherited automatically from app {parent}; change rules on the original app.");
    } else {
        println!("All existing and new previews inherit these rules automatically.");
    }
    if state.status.policy.groups.is_empty() {
        println!("All authenticated company SSO users may access the app.");
    } else {
        println!("Membership in any one of these groups is required:");
        for group in &state.status.policy.groups {
            println!("  {group}");
        }
    }
    for preview in &state.previews {
        println!("{}: {}", preview.hostname, preview.status.state.label());
        if let Some(error) = &preview.status.error {
            eprintln!("{}: {error}", preview.hostname);
        }
    }
    if let Some(error) = &state.status.error {
        eprintln!("{error}");
    }
    Ok(())
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    let json_output = options.json || !std::io::stdout().is_terminal();
    let current = status(api, credentials, app).await?;
    let change = match options.command {
        Some(Command::Set(change)) => change,
        Some(Command::Show) | None => return output(&current, json_output),
    };
    if let Some(parent) = current.inherited_from {
        return Err(Error::invalid(format!(
            "Previews inherit access rules automatically. Change the original app with --app {parent}."
        )));
    }
    if !current.can_manage {
        return Err(Error::invalid(
            "Only the app owner or an administrator can change access rules".into(),
        ));
    }
    let policy = AppAccessSnapshot {
        revision: current.status.policy.revision,
        groups: if change.all_authenticated {
            Vec::new()
        } else {
            change.groups
        },
    };
    let token = auth::access_token(api, credentials).await?;
    let mut current: State = json(
        api.authenticated(Method::PATCH, &format!("/apps/{app}/access"), &token)
            .json(&policy)
            .send()
            .await?,
    )
    .await?;
    let revision = current.status.policy.revision;
    if !change.no_wait {
        while current.pending() && current.failure().is_none() {
            tokio::time::sleep(Duration::from_secs(1)).await;
            current = status(api, credentials, app).await?;
            if current.status.policy.revision != revision {
                return Err(Error::invalid(
                    "A newer access change was saved; use widefleet access to inspect its status"
                        .into(),
                ));
            }
        }
    }
    output(&current, json_output)?;
    if let Some(error) = current.failure() {
        return Err(Error::invalid(error));
    }
    Ok(())
}
