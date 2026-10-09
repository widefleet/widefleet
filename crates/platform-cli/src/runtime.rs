use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::RuntimeRelease,
    sha256,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json as value;
use std::time::Duration;
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show the selected and active runtime versions and the latest update result.
    Status,
    /// Download and activate a published Widefleet runtime version.
    Update {
        version: String,
        #[arg(long)]
        no_wait: bool,
    },
    /// Activate a previously installed version without downloading it again.
    Rollback {
        version: String,
        #[arg(long)]
        no_wait: bool,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    desired_version: Option<String>,
    active_version: Option<String>,
    job_id: Option<Uuid>,
    state: String,
    message: Option<String>,
    versions: Vec<String>,
}

async fn status(api: &Api, token: &str) -> Result<Status> {
    json(
        api.authenticated(Method::GET, "/runtime", token)
            .send()
            .await?,
    )
    .await
}

#[derive(Deserialize)]
struct ReleaseAsset {
    id: u64,
    name: String,
}

#[derive(Deserialize)]
struct GitHubRelease {
    assets: Vec<ReleaseAsset>,
}

async fn download(version: &str) -> Result<RuntimeRelease> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(Error::invalid(
            "Use a published runtime version, such as 0.1.0".into(),
        ));
    }
    // GitHub credentials are attached only to API requests, never to the platform.
    // reqwest removes sensitive headers when an asset redirects to another origin.
    let client = reqwest::Client::builder()
        .https_only(true)
        .user_agent(concat!("widefleet/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()?;
    let token = std::env::var("GH_TOKEN")
        .or_else(|_| std::env::var("GITHUB_TOKEN"))
        .ok();
    download_release(
        &client,
        "https://api.github.com/repos/widefleet/widefleet",
        token.as_deref(),
        version,
    )
    .await
}

async fn download_release(
    client: &reqwest::Client,
    repository: &str,
    token: Option<&str>,
    version: &str,
) -> Result<RuntimeRelease> {
    let request = |path: &str, accept: &str| {
        let request = client
            .get(format!("{repository}{path}"))
            .header("accept", accept);
        match token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    };
    let response = request(
        &format!("/releases/tags/runtime-v{version}"),
        "application/vnd.github+json",
    )
    .send()
    .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(Error::invalid("Runtime release is unavailable. Check the version; if repository access is restricted, set GH_TOKEN or GITHUB_TOKEN with repository read access".into()));
    }
    let release: GitHubRelease = response.error_for_status()?.json().await?;
    let asset = |name: &str| -> Result<String> {
        release
            .assets
            .iter()
            .find(|asset| asset.name == name)
            .map(|asset| format!("/releases/assets/{}", asset.id))
            .ok_or_else(|| Error::invalid(format!("Runtime release is missing {name}")))
    };
    let bytes = request(&asset("release.json")?, "application/octet-stream")
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let checksum = request(&asset("release.json.sha256")?, "application/octet-stream")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    if checksum.split_whitespace().next() != Some(sha256(&bytes).as_str()) {
        return Err(Error::invalid(
            "Downloaded runtime checksum does not match the release".into(),
        ));
    }
    let release: RuntimeRelease = serde_json::from_slice(&bytes)?;
    if release.version != version {
        return Err(Error::invalid(
            "Downloaded runtime version does not match the requested version".into(),
        ));
    }
    Ok(release)
}

pub async fn run(
    api: &Api,
    credentials: &crate::auth::Credentials,
    token: &str,
    options: Options,
) -> Result<()> {
    let (mut current, no_wait) = match options.command {
        Command::Status => return super::print_json(&status(api, token).await?),
        Command::Update { version, no_wait } => {
            let release = download(&version).await?;
            let token = crate::auth::access_token(api, credentials).await?;
            (
                json::<Status>(
                    api.authenticated(Method::PUT, "/runtime", &token)
                        .json(&release)
                        .send()
                        .await?,
                )
                .await?,
                no_wait,
            )
        }
        Command::Rollback { version, no_wait } => (
            json::<Status>(
                api.authenticated(Method::POST, "/runtime/rollback", token)
                    .json(&value!({ "version": version }))
                    .send()
                    .await?,
            )
            .await?,
            no_wait,
        ),
    };
    let job = current.job_id;
    if !no_wait {
        eprintln!(
            "Waiting for runtime activation. Use widefleet runtime status to inspect progress."
        );
        while matches!(current.state.as_str(), "pending" | "queued" | "running") {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let token = crate::auth::access_token(api, credentials).await?;
            current = status(api, &token).await?;
            if current.job_id != job {
                return Err(Error::invalid(
                    "A newer runtime update was submitted; inspect widefleet runtime status".into(),
                ));
            }
        }
    }
    super::print_json(&current)?;
    if current.state == "failed" {
        return Err(Error::invalid(
            current
                .message
                .unwrap_or_else(|| "Runtime activation failed".into()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn request(stream: &mut std::net::TcpStream) -> std::io::Result<String> {
        let mut data = Vec::new();
        let mut chunk = [0; 2048];
        while !data.ends_with(b"\r\n\r\n") {
            let size = stream.read(&mut chunk)?;
            assert_ne!(size, 0);
            data.extend_from_slice(&chunk[..size]);
        }
        String::from_utf8(data)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }

    #[tokio::test]
    async fn private_release_download_checks_integrity_and_does_not_forward_credentials_to_assets()
    -> Result<()> {
        for valid in [true, false] {
            let release = value!({ "protocol": 1, "version": "0.1.0", "celld": "0.6.2", "main": "loader.js", "modules": [] }).to_string();
            let checksum = if valid {
                sha256(release.as_bytes())
            } else {
                "0".repeat(64)
            };
            let assets = TcpListener::bind("127.0.0.1:0")?;
            let redirect = format!("http://{}/release.json", assets.local_addr()?);
            let asset_server = std::thread::spawn(move || -> std::io::Result<()> {
                let (mut stream, _) = assets.accept()?;
                assert!(
                    !request(&mut stream)?
                        .to_ascii_lowercase()
                        .contains("authorization:")
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    release.len(),
                    release
                )?;
                Ok(())
            });
            let github = TcpListener::bind("127.0.0.1:0")?;
            let origin = format!("http://{}", github.local_addr()?);
            let api_server = std::thread::spawn(move || -> std::io::Result<()> {
                for path in [
                    "/releases/tags/runtime-v0.1.0",
                    "/releases/assets/1",
                    "/releases/assets/2",
                ] {
                    let (mut stream, _) = github.accept()?;
                    let headers = request(&mut stream)?.to_ascii_lowercase();
                    assert!(headers.starts_with(&format!("get {path} ")));
                    assert!(headers.contains("authorization: bearer synthetic-release-token"));
                    if path == "/releases/assets/1" {
                        write!(
                            stream,
                            "HTTP/1.1 302 Found\r\nLocation: {redirect}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )?;
                    } else {
                        let body = if path == "/releases/assets/2" {
                            format!("{checksum}  release.json\n")
                        } else {
                            value!({ "assets": [{ "id": 1, "name": "release.json" }, { "id": 2, "name": "release.json.sha256" }] }).to_string()
                        };
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )?;
                    }
                }
                Ok(())
            });
            let result = download_release(
                &reqwest::Client::new(),
                &origin,
                Some("synthetic-release-token"),
                "0.1.0",
            )
            .await;
            if valid {
                assert_eq!(result?.version, "0.1.0");
            } else {
                assert!(
                    matches!(result, Err(error) if matches!(error.kind(), platform_core::ErrorKind::Invalid(message) if message.contains("checksum")))
                );
            }
            api_server
                .join()
                .map_err(|_| Error::invalid("API fixture panicked".into()))??;
            asset_server
                .join()
                .map_err(|_| Error::invalid("Asset fixture panicked".into()))??;
        }
        Ok(())
    }
}
