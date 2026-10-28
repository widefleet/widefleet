use clap::{Args, Subcommand};
use platform_core::{
    Result,
    http::{Api, json},
};
use reqwest::Method;
use serde_json::{Value, json as value};

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// List organizations available to your account.
    List,
    /// Create your organization, or resume an interrupted setup.
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        slug: String,
    },
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    let request = match options.command.unwrap_or(Command::List) {
        Command::List => api.authenticated(Method::GET, "/organizations", token),
        Command::Create { name, slug } => api
            .authenticated(Method::POST, "/organizations", token)
            .json(&value!({ "name": name, "slug": slug })),
    };
    super::print_json(&json::<Value>(request.send().await?).await?)
}
