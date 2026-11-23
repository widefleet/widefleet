use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::NetworkPolicy,
};
use reqwest::Method;
use serde_json::{Map, Value, json as value};
use std::{path::PathBuf, time::Duration};
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
    /// Show a published app's page as JSON: what it is for, its owner and the apps it calls.
    Show { app: Uuid },
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
    /// Set the longer text on an app's page, as Markdown; an empty text removes it.
    About {
        app: Uuid,
        /// A list may open the text, so a leading hyphen is no option.
        #[arg(allow_hyphen_values = true)]
        text: String,
    },
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
        /// Save a secret the template requires from a file before it deploys. Repeat for each
        /// secret that `catalog templates show` lists in requiredSecrets.
        #[arg(long = "secret-file", value_name = "NAME=PATH", value_parser = secret_file)]
        secret_files: Vec<(String, PathBuf)>,
    },
}

fn secret_file(value: &str) -> std::result::Result<(String, PathBuf), String> {
    let (name, path) = value
        .split_once('=')
        .filter(|(name, path)| !name.is_empty() && !path.is_empty())
        .ok_or("Use NAME=PATH, such as API_KEY=./api-key.txt")?;
    Ok((name.to_owned(), PathBuf::from(path)))
}

// Values come from files, as with `widefleet secret put --file`, never from
// the command line.
fn template_secrets(files: Vec<(String, PathBuf)>) -> Result<Map<String, Value>> {
    let mut secrets = Map::new();
    for (name, path) in files {
        let value = crate::app_bindings::secret_value(Some(path))?;
        if secrets.insert(name.clone(), Value::String(value)).is_some() {
            return Err(Error::invalid(format!("{name} is provided more than once")));
        }
    }
    Ok(secrets)
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
        Command::Show { app } => {
            api.authenticated(Method::GET, &format!("/catalog/apps/{app}"), token)
        }
        Command::Templates { command } => match command {
            TemplateCommand::List { search } => api
                .authenticated(Method::GET, "/catalog/templates", token)
                .query(&[("search", search.as_deref().unwrap_or_default())]),
            TemplateCommand::Show { template } => api.authenticated(
                Method::GET,
                &format!("/catalog/templates/{}", template_id(&template)?),
                token,
            ),
            TemplateCommand::Install {
                template,
                name,
                secret_files,
            } => {
                let mut body = Map::new();
                if let Some(name) = name {
                    body.insert("name".into(), Value::String(name));
                }
                // Servers without required secrets accept only the name.
                let secrets = template_secrets(secret_files)?;
                if !secrets.is_empty() {
                    body.insert("secrets".into(), Value::Object(secrets));
                }
                api.authenticated(
                    Method::POST,
                    &format!("/catalog/templates/{}/install", template_id(&template)?),
                    token,
                )
                .json(&body)
                // The installation builds the template before it answers.
                .timeout(Duration::from_secs(10 * 60))
            }
        },
        Command::Publish { app } | Command::Unpublish { app } => api
            .authenticated(Method::PUT, &format!("/apps/{app}/catalog"), token)
            .json(&value!({ "listed": listed })),
        Command::Describe { app, description } => api
            .authenticated(Method::PUT, &format!("/apps/{app}/description"), token)
            .json(&value!({ "description": description })),
        Command::About { app, text } => api
            .authenticated(Method::PUT, &format!("/apps/{app}/about"), token)
            .json(&value!({ "about": text })),
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
