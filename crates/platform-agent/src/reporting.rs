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
) -> Option<RuntimeReporting> {
    if !Preferences::default().effective().usage {
        return None;
    }
    let mut settings = runtime_credentials(api, &configuration.token).await?;
    settings.url = crate::telemetry::destination_url(
        api,
        configuration,
        &format!("/api/v1/reporting/runtime/{}", settings.organization_id),
    )
    .ok()?;
    Some(settings)
}

async fn runtime_credentials(
    api: &platform_core::http::Api,
    token: &str,
) -> Option<RuntimeReporting> {
    // Optional reporting cannot fail a deployment or hold its job lease while
    // the endpoint is unavailable. Older control planes also return 404 here.
    api.authenticated(reqwest::Method::GET, "/agent/reporting/runtime", token)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()
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

#[cfg(test)]
mod tests {
    use super::runtime_credentials;
    use platform_core::{Error, Result, http::Api};
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn endpoint(
        status: u16,
        body: &str,
        stall_body: bool,
    ) -> Result<(Api, tokio::task::JoinHandle<std::io::Result<()>>)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let api = Api::new(&format!("http://{}", listener.local_addr()?))?;
        let body = body.to_string();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let length = stream.read(&mut buffer).await?;
                if length == 0 {
                    return Err(std::io::ErrorKind::UnexpectedEof.into());
                }
                request.extend_from_slice(&buffer[..length]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("GET /api/v1/agent/reporting/runtime "));
            assert!(request.contains("authorization: Bearer fixture"));
            stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await?;
            if stall_body {
                std::future::pending::<()>().await;
            }
            stream.write_all(body.as_bytes()).await
        });
        Ok((api, task))
    }

    #[tokio::test]
    async fn runtime_settings_are_optional_for_unavailable_or_invalid_endpoints() -> Result<()> {
        for (status, body) in [(404, "{}"), (503, "{}"), (200, "not json"), (200, "{}")] {
            let (api, server) = endpoint(status, body, false).await?;
            assert!(runtime_credentials(&api, "fixture").await.is_none());
            server
                .await
                .map_err(|error| Error::invalid(error.to_string()))??;
        }
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let api = Api::new(&format!("http://{}", listener.local_addr()?))?;
        drop(listener);
        assert!(runtime_credentials(&api, "fixture").await.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn runtime_settings_bound_stalled_response_bodies() -> Result<()> {
        let (api, server) = endpoint(200, "{}", true).await?;
        let result =
            tokio::time::timeout(Duration::from_secs(5), runtime_credentials(&api, "fixture"))
                .await;
        server.abort();
        assert!(
            result
                .map_err(|error| Error::invalid(error.to_string()))?
                .is_none()
        );
        Ok(())
    }

    #[tokio::test]
    async fn runtime_settings_accept_valid_credentials() -> Result<()> {
        let (api, server) = endpoint(
            200,
            r#"{"organizationId":"widefleet","token":"usage_fixture","enabled":true,"revision":2}"#,
            false,
        )
        .await?;
        let settings = runtime_credentials(&api, "fixture")
            .await
            .ok_or_else(|| Error::invalid("Expected runtime reporting credentials".into()))?;
        assert_eq!(settings.organization_id, "widefleet");
        assert_eq!(settings.token, "usage_fixture");
        assert!(settings.enabled);
        assert_eq!(settings.revision, 2);
        server
            .await
            .map_err(|error| Error::invalid(error.to_string()))??;
        Ok(())
    }
}
