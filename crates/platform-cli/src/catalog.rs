use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
};
use reqwest::Method;
use serde_json::{Value, json as value};
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
}

#[derive(Subcommand)]
enum TemplateCommand {
    /// List available templates as JSON.
    List {
        #[arg(long)]
        search: Option<String>,
    },
    /// Show a template's source, setup instructions and examples as JSON.
    Show { template: String },
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    let listed = matches!(&options.command, Command::Publish { .. });
    let request = match options.command {
        Command::List => api.authenticated(Method::GET, "/catalog", token),
        Command::Templates { command } => match command {
            TemplateCommand::List { search } => api
                .authenticated(Method::GET, "/catalog/templates", token)
                .query(&[("search", search.as_deref().unwrap_or_default())]),
            TemplateCommand::Show { template } => {
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
                api.authenticated(
                    Method::GET,
                    &format!("/catalog/templates/{template}"),
                    token,
                )
            }
        },
        Command::Publish { app } | Command::Unpublish { app } => api
            .authenticated(Method::PUT, &format!("/apps/{app}/catalog"), token)
            .json(&value!({ "listed": listed })),
    };
    super::print_json(&json::<Value>(request.send().await?).await?)
}
