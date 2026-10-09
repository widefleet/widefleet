use clap::{Args, Subcommand};
use platform_core::{
    Result,
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
    /// Publish an active app in the catalog (owner or administrator only).
    Publish { app: Uuid },
    /// Withdraw an app's catalog listing (owner or administrator only).
    Unpublish { app: Uuid },
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    let listed = matches!(&options.command, Command::Publish { .. });
    let request = match options.command {
        Command::List => api.authenticated(Method::GET, "/catalog", token),
        Command::Publish { app } | Command::Unpublish { app } => api
            .authenticated(Method::PUT, &format!("/apps/{app}/catalog"), token)
            .json(&value!({ "listed": listed })),
    };
    super::print_json(&json::<Value>(request.send().await?).await?)
}
