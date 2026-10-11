use crate::{apps, auth};
use clap::{Args, Subcommand, ValueEnum};
use platform_core::{
    Error, Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json as value};
use std::{io::IsTerminal, path::PathBuf};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[arg(long, global = true)]
    app: Option<String>,
    #[arg(long, global = true, default_value = "wrangler.jsonc")]
    config: PathBuf,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Show assignments, effective actions and preview inheritance.
    Show,
    /// Find an existing company member by name or email.
    Search { query: String },
    /// Add a role; existing roles remain effective.
    Grant {
        #[command(flatten)]
        target: Target,
        #[arg(long, value_enum)]
        role: Role,
    },
    /// Remove an assignment; at least one app admin must remain.
    Revoke { assignment: Uuid },
}

#[derive(Args)]
#[group(required = true, multiple = false)]
struct Target {
    /// Stable person ID in the company's identity provider.
    #[arg(long, group = "recipient")]
    person: Option<String>,
    /// Stable SSO group ID.
    #[arg(long, group = "recipient")]
    group: Option<String>,
    /// Internal user ID. For a company subject from roles search, use --person.
    #[arg(long, group = "recipient")]
    member: Option<String>,
}

#[derive(Clone, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum Role {
    User,
    Developer,
    Admin,
}

#[derive(Deserialize, Serialize)]
struct Principal {
    r#type: String,
    provider: String,
    subject: String,
}

#[derive(Deserialize, Serialize)]
struct Assignment {
    id: Uuid,
    principal: Principal,
    role: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    app_id: Uuid,
    inherited_from: Option<Uuid>,
    revision: u64,
    assignments: Vec<Assignment>,
    actions: Vec<String>,
    provider: String,
}

fn principal(target: Target, provider: &str) -> Result<Principal> {
    if let Some(subject) = target.member {
        return Ok(Principal {
            r#type: "user".into(),
            provider: "widefleet".into(),
            subject,
        });
    }
    if provider.is_empty() {
        return Err(Error::invalid(
            "Configure company SSO before assigning an external identity".into(),
        ));
    }
    let (kind, subject) = match (target.person, target.group) {
        (Some(subject), None) => ("user", subject),
        (None, Some(subject)) => ("group", subject),
        _ => {
            return Err(Error::invalid(
                "Choose exactly one person, group or member".into(),
            ));
        }
    };
    Ok(Principal {
        r#type: kind.into(),
        provider: provider.into(),
        subject,
    })
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    let token = auth::access_token(api, credentials).await?;
    let path = format!("/apps/{app}/roles");
    let current: State = json(api.authenticated(Method::GET, &path, &token).send().await?).await?;
    let (method, path, body) = match options.command {
        Some(Command::Search { query }) => {
            let result: Value = json(
                api.authenticated(Method::GET, &format!("{path}/candidates"), &token)
                    .query(&[("search", query)])
                    .send()
                    .await?,
            )
            .await?;
            return super::print_json(&result);
        }
        Some(Command::Grant { target, role }) => (
            Method::POST,
            path,
            value!({ "principal": principal(target, &current.provider)?, "role": role, "revision": current.revision }),
        ),
        Some(Command::Revoke { assignment }) => (
            Method::DELETE,
            format!("{path}/{assignment}"),
            value!({ "revision": current.revision }),
        ),
        Some(Command::Show) | None => return output(&current, options.json),
    };
    if let Some(parent) = current.inherited_from {
        return Err(Error::invalid(format!(
            "Previews inherit roles. Change the original app with --app {parent}."
        )));
    }
    let state: State = json(
        api.authenticated(method, &path, &token)
            .json(&body)
            .send()
            .await?,
    )
    .await?;
    if !options.json && std::io::stdout().is_terminal() {
        eprintln!(
            "Roles saved. App access changes take effect after gateway activation; inspect widefleet access for status."
        );
    }
    output(&state, options.json)
}

fn output(state: &State, json_output: bool) -> Result<()> {
    if json_output || !std::io::stdout().is_terminal() {
        return super::print_json(state);
    }
    if let Some(parent) = state.inherited_from {
        println!("Inherited from app {parent}");
    }
    for assignment in &state.assignments {
        println!(
            "{}  {}  {} {} ({})",
            assignment.id,
            assignment.role,
            assignment.principal.r#type,
            assignment.principal.subject,
            assignment.principal.provider
        );
    }
    println!("Effective actions: {}", state.actions.join(", "));
    Ok(())
}
