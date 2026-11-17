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
    /// List your personal connector accounts and their current status.
    List,
    /// Create a short-lived authorization URL. Open it in your browser.
    Connect { app: Uuid },
    /// Disconnect your own account from a connector.
    Disconnect { app: Uuid },
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    let request = match options.command {
        Command::List => api.authenticated(Method::GET, "/user-connections", token),
        Command::Connect { app } => api
            .authenticated(
                Method::POST,
                &format!("/user-connections/{app}/connect"),
                token,
            )
            .json(&value!({})),
        Command::Disconnect { app } => {
            api.authenticated(Method::DELETE, &format!("/user-connections/{app}"), token)
        }
    };
    super::print_json(&json::<Value>(request.send().await?).await?)
}
