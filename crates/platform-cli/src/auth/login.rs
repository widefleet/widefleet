use super::{CLIENT_ID, Credentials, DeviceCode, LoginOptions, login_scope, save_session};
use platform_core::{
    Error, Result,
    http::{Api, json},
};
use reqwest::{Method, Url};
use serde::Deserialize;
use std::time::Duration;
use tokio::time::Instant;

const CLOUD: &str = "https://app.widefleet.com";

#[derive(Deserialize)]
struct Routing {
    request_id: String,
    cli_token: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

impl Routing {
    async fn discover() -> Result<(Self, Api)> {
        let cloud = Api::new(CLOUD)?;
        let routing: Self = json(
            cloud
                .request(Method::POST, "/api/auth/cli-login/start")
                .send()
                .await?,
        )
        .await?;
        let url = Url::parse(&routing.verification_uri)
            .map_err(|error| Error::invalid(error.to_string()))?;
        if url.origin() != cloud.origin.origin()
            || url.path() != "/cli-login"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::invalid("Invalid Cloud discovery link".into()));
        }
        println!(
            "Open {} to find your Widefleet installation. Keep this login running until you approve it.",
            routing.verification_uri
        );
        let deadline = Instant::now() + Duration::from_secs(routing.expires_in.min(1800));
        loop {
            tokio::time::sleep(Duration::from_secs(routing.interval.clamp(1, 60))).await;
            if Instant::now() >= deadline {
                return Err(Error::invalid(
                    "Company discovery expired. Run widefleet login again".into(),
                ));
            }
            #[derive(Deserialize)]
            struct Selected {
                platform_url: Option<String>,
            }
            let selected: Selected = json(cloud.request(Method::POST, "/api/auth/cli-login/poll")
                .json(&serde_json::json!({ "request_id": routing.request_id, "cli_token": routing.cli_token }))
                .send().await?).await?;
            if let Some(origin) = selected.platform_url {
                let target = Api::new(&origin)?;
                if target.origin.scheme() != "https" {
                    return Err(Error::invalid("Company discovery requires HTTPS".into()));
                }
                return Ok((routing, target));
            }
        }
    }

    async fn ready(&self, user_code: &str) -> Result<()> {
        let cloud = Api::new(CLOUD)?;
        let _: serde_json::Value = json(cloud.request(Method::POST, "/api/auth/cli-login/ready")
            .json(&serde_json::json!({ "request_id": self.request_id, "cli_token": self.cli_token, "user_code": user_code }))
            .send().await?).await?;
        Ok(())
    }
}

pub async fn login(
    api: &Api,
    credentials: &Credentials,
    options: LoginOptions,
    automatic: bool,
) -> Result<String> {
    let scope = login_scope(&options)?;
    let (routing, target) = if automatic {
        let (routing, target) = Routing::discover().await?;
        (Some(routing), target)
    } else {
        (None, api.clone())
    };
    let credentials = credentials.for_login(&target.origin_text()).await?;
    let resource = format!("{}/api/v1", target.origin_text());
    let device: DeviceCode = json(
        target
            .request(Method::POST, "/api/auth/device/code")
            .form(&[
                ("client_id", CLIENT_ID),
                ("scope", &scope),
                ("resource", &resource),
            ])
            .send()
            .await?,
    )
    .await?;
    let mut verification =
        Url::parse(&device.verification_uri).map_err(|error| Error::invalid(error.to_string()))?;
    if verification.origin() != target.origin.origin()
        || verification.path() != "/device"
        || !verification.username().is_empty()
        || verification.password().is_some()
    {
        return Err(Error::invalid(
            "The device verification URL does not belong to this platform".into(),
        ));
    }
    verification.set_fragment(None);
    verification.set_query(None);
    verification
        .query_pairs_mut()
        .append_pair("user_code", &device.user_code);
    println!("Open {verification} and verify code: {}", device.user_code);
    println!("Approve only the request you started in your terminal or coding assistant.");
    if let Some(routing) = routing {
        routing.ready(&device.user_code).await?;
    }
    let deadline = Instant::now() + Duration::from_secs(device.expires_in.min(1800));
    let mut interval = device.interval.max(1);
    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if Instant::now() >= deadline {
            return Err(Error::invalid(
                "Device login expired. Run widefleet login again".into(),
            ));
        }
        let response = target
            .request(Method::POST, "/api/auth/oauth2/token")
            .form(&[
                ("client_id", CLIENT_ID),
                ("device_code", &device.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?;
        if response.status().is_success() {
            let tokens = json(response).await?;
            let _lock = credentials.lock(target.origin_text()).await?;
            save_session(target.origin_text(), tokens, &credentials).await?;
            println!("Connected to {}.", target.origin_text());
            if let Some(file) = credentials.stored_file(&target.origin_text())? {
                println!(
                    "Credentials are stored unencrypted in {} (owner-only access).",
                    file.0.display()
                );
            } else {
                println!("Credentials are stored in the operating system's credential store.");
            }
            return Ok(target.origin_text());
        }
        #[derive(Deserialize)]
        struct Failure {
            error: String,
        }
        let failure: Failure = response.json().await?;
        match failure.error.as_str() {
            "authorization_pending" => {}
            "slow_down" => interval = interval.saturating_add(5),
            "access_denied" => return Err(Error::invalid("Device login was denied".into())),
            "expired_token" => return Err(Error::invalid("Device login expired".into())),
            _ => {
                return Err(Error::invalid(format!(
                    "Device login failed: {}",
                    failure.error
                )));
            }
        }
    }
}
