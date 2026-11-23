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
        /// Let everyone with an address on your company email domain join. Requires a Google
        /// Workspace or Microsoft work account sign-in on that domain.
        #[arg(long)]
        allow_domain_join: bool,
    },
    /// List organizations open to your verified company email domain.
    Joinable,
    /// Join an organization open to your verified company email domain.
    Join {
        /// The organization ID shown by `organizations joinable`.
        organization_id: String,
    },
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    let request = match options.command.unwrap_or(Command::List) {
        Command::List => api.authenticated(Method::GET, "/organizations", token),
        Command::Create {
            name,
            slug,
            allow_domain_join,
        } => api
            .authenticated(Method::POST, "/organizations", token)
            .json(&value!({ "name": name, "slug": slug, "allowDomainJoin": allow_domain_join })),
        Command::Joinable => api.authenticated(Method::GET, "/organizations/joinable", token),
        Command::Join { organization_id } => api.authenticated(
            Method::POST,
            &format!("/organizations/{organization_id}/join"),
            token,
        ),
    };
    super::print_json(&json::<Value>(request.send().await?).await?)
}
