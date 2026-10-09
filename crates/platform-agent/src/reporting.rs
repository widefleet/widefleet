use crate::config::Configuration;
use platform_core::reporting::{self, Preferences, Report};
use std::time::Duration;
use tokio::sync::mpsc;

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
