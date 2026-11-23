use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::NetworkPolicy,
};
use reqwest::Method;
use serde_json::{Value, json as value};
use std::time::Duration;
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List published apps and their launch URLs as JSON.
    List,
    /// Find app templates and their setup instructions.
    Templates {
        #[command(subcommand)]
        command: TemplateCommand,
    },
    /// Publish an active app in the catalog (owner or administrator only).
    Publish { app: Uuid },
    /// Withdraw an app's catalog listing (owner or administrator only).
    Unpublish { app: Uuid },
    /// Set the sentence that tells people what an app is for; an empty text removes it.
    Describe { app: Uuid, description: String },
}

#[derive(Subcommand)]
enum TemplateCommand {
    /// List available templates as JSON.
    List {
        #[arg(long)]
        search: Option<String>,
    },
    /// Show a template's source, Markdown instructions and setup prompt as JSON.
    Show { template: String },
    /// Build and deploy a template as an app, then print the app and deployment as JSON.
    Install {
        template: String,
        /// The new app's name; the template ID by default. An existing app is never replaced.
        #[arg(long)]
        name: Option<String>,
    },
}

fn template_id(template: &str) -> Result<&str> {
    if template.len() > 64
        || !template.starts_with(|c: char| c.is_ascii_lowercase())
        || !template
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(Error::invalid(
            "Use a template ID from catalog templates list".into(),
        ));
    }
    Ok(template)
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    let listed = matches!(&options.command, Command::Publish { .. });
    let installing = matches!(
        &options.command,
        Command::Templates {
            command: TemplateCommand::Install { .. }
        }
    );
    let request = match options.command {
        Command::List => api.authenticated(Method::GET, "/catalog", token),
        Command::Templates { command } => match command {
            TemplateCommand::List { search } => api
                .authenticated(Method::GET, "/catalog/templates", token)
                .query(&[("search", search.as_deref().unwrap_or_default())]),
            TemplateCommand::Show { template } => api.authenticated(
                Method::GET,
                &format!("/catalog/templates/{}", template_id(&template)?),
                token,
            ),
            TemplateCommand::Install { template, name } => api
                .authenticated(
                    Method::POST,
                    &format!("/catalog/templates/{}/install", template_id(&template)?),
                    token,
                )
                .json(&match name {
                    Some(name) => value!({ "name": name }),
                    None => value!({}),
                })
                // The installation builds the template before it answers.
                .timeout(Duration::from_secs(10 * 60)),
        },
        Command::Publish { app } | Command::Unpublish { app } => api
            .authenticated(Method::PUT, &format!("/apps/{app}/catalog"), token)
            .json(&value!({ "listed": listed })),
        Command::Describe { app, description } => api
            .authenticated(Method::PUT, &format!("/apps/{app}/description"), token)
            .json(&value!({ "description": description })),
    };
    let result = json::<Value>(request.send().await?).await?;
    super::print_json(&result)?;
    // Without the network:manage scope, the template's origins stay requested.
    if installing
        && let (Some(app), Some(requested)) = (
            result["app"]["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok()),
            result
                .get("requestedNetwork")
                .and_then(|value| serde_json::from_value::<NetworkPolicy>(value.clone()).ok()),
        )
    {
        crate::network::print_requested(api, app, &requested);
    }
    Ok(())
}
