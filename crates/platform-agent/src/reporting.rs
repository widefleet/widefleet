use crate::config::Configuration;
use platform_core::reporting::{self, Preferences, Report};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReporting {
    organization_id: String,
    token: String,
    enabled: bool,
    revision: u64,
    #[serde(default)]
    url: String,
}

pub async fn runtime(
    api: &platform_core::http::Api,
    configuration: &Configuration,
) -> platform_core::Result<Option<RuntimeReporting>> {
    if !Preferences::default().effective().usage {
        return Ok(None);
    }
    let response = api
        .authenticated(
            reqwest::Method::GET,
            "/agent/reporting/runtime",
            &configuration.token,
        )
        .send()
        .await?;
    // The independently released agent also works with older control planes.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let mut settings: RuntimeReporting = platform_core::http::json(response).await?;
    settings.url = crate::telemetry::destination_url(
        api,
        configuration,
        &format!("/api/v1/reporting/runtime/{}", settings.organization_id),
    )?;
    Ok(Some(settings))
}

pub fn start(
    configuration: &Configuration,
) -> Option<(mpsc::Sender<Report>, tokio::task::JoinHandle<()>)> {
    let local = Preferences::default().effective();
    if !local.usage && !local.crashes {
        return None;
    }
    let client = reporting::client().ok()?;
    let mut url = reqwest::Url::parse(&configuration.url).ok()?;
    let local_origin = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local_origin) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_path("/api/v1/agent/reporting");
    url.set_query(None);
    url.set_fragment(None);
    let token = configuration.token.clone();
    let (sender, mut receiver) = mpsc::channel::<Report>(16);
    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_error = std::time::Instant::now()
            .checked_sub(Duration::from_secs(60))
            .unwrap_or_else(std::time::Instant::now);
        loop {
            let report = tokio::select! {
                _ = interval.tick() => None,
                report = receiver.recv() => match report { Some(report) => Some(report), None => break },
            };
            if report.is_some() && last_error.elapsed() < Duration::from_secs(12) {
                continue;
            }
            let Ok(response) = client.get(url.clone()).bearer_auth(&token).send().await else {
                continue;
            };
            if !response.status().is_success() {
                continue;
            }
            let Ok(remote) = response.json::<Preferences>().await else {
                continue;
            };
            let allowed = if report.is_some() {
                local.crashes && remote.crashes
            } else {
                local.usage && remote.usage
            };
            if !allowed {
                continue;
            }
            let mut payload = reporting::metadata();
            if let Some(report) = report {
                last_error = std::time::Instant::now();
                let Ok(error) = serde_json::to_value(report) else {
                    continue;
                };
                payload["error"] = error;
            }
            let _ = client
                .post(url.clone())
                .bearer_auth(&token)
                .json(&payload)
                .send()
                .await;
        }
    });
    Some((sender, task))
}
