use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json as value};
use std::path::PathBuf;

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show configuration and activation status. Secret values are never returned.
    Get,
    /// Export editable settings with secret references.
    Export,
    /// Validate a JSON configuration and report whether app sign-in must restart.
    Plan {
        #[arg(long)]
        file: PathBuf,
    },
    /// Apply the same JSON configuration accepted by the management API.
    Apply {
        #[arg(long)]
        file: PathBuf,
        /// Allow the temporary interruption reported by settings plan.
        #[arg(long)]
        acknowledge_restart: bool,
    },
    /// Set browser settings read-only while API and CLI changes remain available.
    ExternalManagement {
        #[arg(action = clap::ArgAction::Set)]
        enabled: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    restart_required: bool,
    message: String,
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    match options.command {
        Command::Get | Command::Export => {
            let view: Value = json(
                api.authenticated(Method::GET, "/settings", token)
                    .send()
                    .await?,
            )
            .await?;
            super::print_json(if matches!(options.command, Command::Export) {
                &view["settings"]
            } else {
                &view
            })
        }
        Command::Plan { file } => {
            let input: Value = serde_json::from_slice(&std::fs::read(file)?)?;
            let plan: Value = json(
                api.authenticated(Method::POST, "/settings/plan", token)
                    .json(&input)
                    .send()
                    .await?,
            )
            .await?;
            super::print_json(&plan)
        }
        Command::Apply {
            file,
            acknowledge_restart,
        } => {
            let mut input: Value = serde_json::from_slice(&std::fs::read(file)?)?;
            let plan: Plan = json(
                api.authenticated(Method::POST, "/settings/plan", token)
                    .json(&input)
                    .send()
                    .await?,
            )
            .await?;
            if plan.restart_required && !acknowledge_restart {
                return Err(Error::invalid(format!(
                    "{} Repeat with --acknowledge-restart to apply.",
                    plan.message
                )));
            }
            let object = input
                .as_object_mut()
                .ok_or_else(|| Error::invalid("Settings must be a JSON object".into()))?;
            object.insert("acknowledgeRestart".into(), value!(acknowledge_restart));
            let view: Value = json(
                api.authenticated(Method::PUT, "/settings", token)
                    .json(&input)
                    .send()
                    .await?,
            )
            .await?;
            super::print_json(&view)
        }
        Command::ExternalManagement { enabled } => {
            let view: Value = json(
                api.authenticated(Method::PUT, "/settings/external-management", token)
                    .json(&value!({ "enabled": enabled }))
                    .send()
                    .await?,
            )
            .await?;
            super::print_json(&view)
        }
    }
}
