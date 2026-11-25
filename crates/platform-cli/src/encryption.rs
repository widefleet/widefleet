use crate::auth::{self, Credentials};
use clap::{Args, Subcommand};
use platform_core::{
    Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json as value;

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
    /// Secrets of this version in deployments that have not saved them yet.
    pending: u64,
    active: bool,
    available: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    active_key_version: Option<String>,
    pending_deployments: u64,
    key_versions: Vec<KeyVersion>,
}

/// One bounded batch; `cursor` continues with the next one until it is `null`.
/// The last batch carries the final status, so a write-only token suffices.
#[derive(Deserialize)]
struct Batch {
    reencrypted: u64,
    changed: u64,
    failed: u64,
    cursor: Option<String>,
    status: Option<Status>,
}

#[derive(Serialize)]
struct Reencryption {
    reencrypted: u64,
    changed: u64,
    failed: u64,
    status: Option<Status>,
}

async fn status(api: &Api, credentials: &Credentials) -> Result<Status> {
    let token = auth::access_token(api, credentials).await?;
    json(
        api.authenticated(Method::GET, "/encryption", &token)
            .send()
            .await?,
    )
    .await
}

pub async fn run(api: &Api, credentials: &Credentials, options: Options) -> Result<()> {
    match options.command {
        Command::Status => super::print_json(&status(api, credentials).await?),
        Command::Reencrypt => {
            let (mut reencrypted, mut changed, mut failed) = (0, 0, 0);
            let mut cursor: Option<String> = None;
            loop {
                let body = cursor
                    .as_ref()
                    .map_or_else(|| value!({}), |cursor| value!({ "cursor": cursor }));
                // A long run can outlast one access token; refresh it before each batch.
                let token = auth::access_token(api, credentials).await?;
                let batch: Batch = json(
                    api.authenticated(Method::POST, "/encryption/reencrypt", &token)
                        .json(&body)
                        .send()
                        .await?,
                )
                .await?;
                reencrypted += batch.reencrypted;
                changed += batch.changed;
                failed += batch.failed;
                eprintln!("Re-encrypted {reencrypted} secrets so far");
                match batch.cursor {
                    Some(next) => cursor = Some(next),
                    None => {
                        return super::print_json(&Reencryption {
                            reencrypted,
                            changed,
                            failed,
                            status: batch.status,
                        });
                    }
                }
            }
        }
    }
}
