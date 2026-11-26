use clap::{Args, Subcommand};
use platform_core::{
    Error, FailureReason, Result,
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
    /// Request the DNS TXT record needed to activate company SSO.
    DomainVerification,
    /// Verify the published TXT record without changing the organization's sign-in policy.
    VerifyDomain,
    /// Require company SSO for this organization after domain verification.
    ActivateSso,
    /// Require company SSO for every sign-in with an address on the verified domains.
    DomainSso {
        #[arg(action = clap::ArgAction::Set)]
        enabled: bool,
    },
    /// Export editable settings without saved secrets.
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
    /// Allow hosted apps to register same-origin browser workers.
    BrowserWorkers {
        #[arg(action = clap::ArgAction::Set)]
        enabled: bool,
    },
    /// Set browser settings read-only while API and CLI changes remain available.
    ExternalManagement {
        #[arg(action = clap::ArgAction::Set)]
        enabled: bool,
    },
    /// Show which email domains can join without an invitation and whether new organizations
    /// on the verified company domains are reserved for administrators.
    DomainAccess,
    /// Let verified addresses on a domain join as members. Your own Google Workspace or
    /// Microsoft work sign-in must prove the domain.
    AddJoinDomain { domain: String },
    /// Stop letting a domain join. Members who already joined stay.
    RemoveJoinDomain { domain: String },
    /// Reserve new organizations on the verified company domains for this organization's
    /// owners and admins.
    RestrictOrganizationCreation {
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
            if matches!(options.command, Command::Export) {
                let mut settings = view["settings"].clone();
                let mut provider = view["sso"].clone();
                if let Some(provider) = provider.as_object_mut() {
                    provider.remove("domainVerified");
                }
                settings["sso"] = provider;
                super::print_json(&settings)
            } else {
                super::print_json(&view)
            }
        }
        Command::DomainVerification | Command::VerifyDomain | Command::ActivateSso => {
            let path = match options.command {
                Command::DomainVerification => "/settings/domain-verification",
                Command::VerifyDomain => "/settings/verify-domain",
                _ => "/settings/activate-sso",
            };
            let result: Value =
                json(api.authenticated(Method::POST, path, token).send().await?).await?;
            super::print_json(&result)
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
                ))
                .with_reason(FailureReason::SettingsRestartUnacknowledged));
            }
            let object = input.as_object_mut().ok_or_else(|| {
                Error::invalid("Settings must be a JSON object".into())
                    .with_reason(FailureReason::SettingsNotObject)
            })?;
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
        Command::DomainAccess => {
            let view: Value = json(
                api.authenticated(Method::GET, "/settings/domain-access", token)
                    .send()
                    .await?,
            )
            .await?;
            super::print_json(&view)
        }
        Command::AddJoinDomain { domain } => {
            let view: Value = json(
                api.authenticated(Method::POST, "/settings/join-domains", token)
                    .json(&value!({ "domain": domain }))
                    .send()
                    .await?,
            )
            .await?;
            super::print_json(&view)
        }
        Command::RemoveJoinDomain { domain } => {
            let view: Value = json(
                api.authenticated(
                    Method::DELETE,
                    &format!("/settings/join-domains/{}", domain.trim().to_lowercase()),
                    token,
                )
                .send()
                .await?,
            )
            .await?;
            super::print_json(&view)
        }
        Command::RestrictOrganizationCreation { enabled } => {
            let view: Value = json(
                api.authenticated(Method::PUT, "/settings/organization-creation", token)
                    .json(&value!({ "restricted": enabled }))
                    .send()
                    .await?,
            )
            .await?;
            super::print_json(&view)
        }
        Command::BrowserWorkers { enabled }
        | Command::ExternalManagement { enabled }
        | Command::DomainSso { enabled } => {
            let path = match options.command {
                Command::BrowserWorkers { .. } => "/settings/browser-workers",
                Command::DomainSso { .. } => "/settings/domain-sso",
                _ => "/settings/external-management",
            };
            let view: Value = json(
                api.authenticated(Method::PUT, path, token)
                    .json(&value!({ "enabled": enabled }))
                    .send()
                    .await?,
            )
            .await?;
            super::print_json(&view)
        }
    }
}
