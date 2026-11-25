use clap::{Args, Subcommand};
use platform_core::{
    Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show how many stored secrets each encryption key version protects.
    Status,
    /// Re-encrypt stored secrets of earlier key versions with the active version.
    Reencrypt,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyVersion {
    /// `null` names the key that earlier releases used.
    id: Option<String>,
    values: u64,
    active: bool,
    available: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    active_key_version: Option<String>,
    key_versions: Vec<KeyVersion>,
}

#[derive(Deserialize, Serialize)]
struct Reencryption {
    reencrypted: u64,
    changed: u64,
    failed: u64,
    status: Status,
}

pub async fn run(api: &Api, token: &str, options: Options) -> Result<()> {
    match options.command {
        Command::Status => super::print_json(
            &json::<Status>(
                api.authenticated(Method::GET, "/encryption", token)
                    .send()
                    .await?,
            )
            .await?,
        ),
        Command::Reencrypt => super::print_json(
            &json::<Reencryption>(
                api.authenticated(Method::POST, "/encryption/reencrypt", token)
                    .send()
                    .await?,
            )
            .await?,
        ),
    }
}
