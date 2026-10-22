use clap::{Args, Subcommand, ValueEnum};
use platform_core::{
    Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::Serialize;
use serde_json::{Value, json as value};
use uuid::Uuid;

#[derive(Clone, Copy, ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    Member,
    Admin,
    Owner,
}

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List members of the selected organization.
    List {
        #[arg(long, default_value = "")]
        search: String,
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..=100_000))]
        page: u32,
    },
    /// Change a member's organization role.
    Role {
        #[arg(value_parser = member_id)]
        member: String,
        #[arg(value_enum)]
        role: Role,
    },
    /// Remove a member from the selected organization.
    Remove {
        #[arg(value_parser = member_id)]
        member: String,
    },
}

fn member_id(value: &str) -> std::result::Result<String, String> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Use a member ID from `widefleet members list`".into());
    }
    Ok(value.to_owned())
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    let request = match options.command {
        Command::List { search, page } => api
            .authenticated(Method::GET, "/members", token)
            .query(&[("search", search), ("page", page.to_string())]),
        Command::Role { member, role } => api
            .authenticated(Method::PATCH, &format!("/members/{}", member), token)
            .json(&value!({ "role": role })),
        Command::Remove { member } => {
            api.authenticated(Method::DELETE, &format!("/members/{}", member), token)
        }
    };
    super::print_json(&json::<Value>(request.send().await?).await?)
}

#[derive(Args)]
pub struct InvitationOptions {
    #[command(subcommand)]
    command: InvitationCommand,
}

#[derive(Subcommand)]
enum InvitationCommand {
    /// List invitations for the selected organization.
    List,
    /// Invite a person by email to the selected organization.
    Invite {
        email: String,
        #[arg(long, value_enum, default_value = "member")]
        role: Role,
        /// Resend an existing pending invitation and renew its expiry.
        #[arg(long)]
        resend: bool,
    },
    /// Revoke a pending invitation.
    Cancel { invitation: Uuid },
    /// Read an invitation sent to your verified email address.
    Show { invitation: Uuid },
    /// Accept an invitation sent to your verified email address.
    Accept { invitation: Uuid },
}

pub async fn invitations(api: &Api, token: &str, options: InvitationOptions) -> Result<()> {
    let request = match options.command {
        InvitationCommand::List => api.authenticated(Method::GET, "/invitations", token),
        InvitationCommand::Invite {
            email,
            role,
            resend,
        } => api
            .authenticated(Method::POST, "/invitations", token)
            .json(&value!({ "email": email, "role": role, "resend": resend })),
        InvitationCommand::Cancel { invitation } => {
            api.authenticated(Method::DELETE, &format!("/invitations/{invitation}"), token)
        }
        InvitationCommand::Show { invitation } => {
            api.authenticated(Method::GET, &format!("/invitations/{invitation}"), token)
        }
        InvitationCommand::Accept { invitation } => api
            .authenticated(
                Method::POST,
                &format!("/invitations/{invitation}/accept"),
                token,
            )
            .json(&value!({})),
    };
    super::print_json(&json::<Value>(request.send().await?).await?)
}
