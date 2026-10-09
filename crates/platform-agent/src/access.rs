use crate::{config::Configuration, docker};
use bollard::Docker;
use platform_core::{Error, Result, model::Job};
use reqwest::Url;
use serde_json::{Value, json};
use std::time::Duration;

pub fn middleware(configuration: &Configuration, job: &Job) -> Result<Value> {
    let access = job
        .access
        .as_ref()
        .ok_or_else(|| Error::invalid("App job has no access rules".into()))?;
    if access.groups.len() > 100
        || access.groups.iter().any(|group| {
            group.is_empty()
                || group.trim() != group
                || group.chars().count() > 256
                || group.contains(',')
                || group.chars().any(|character| character.is_ascii_control())
        })
    {
        return Err(Error::invalid("Invalid app access groups".into()));
    }
    let mut address = Url::parse(&configuration.app_auth_url)
        .map_err(|error| Error::invalid(error.to_string()))?;
    if !matches!(address.scheme(), "http" | "https")
        || !address.username().is_empty()
        || address.password().is_some()
        || address.query().is_some()
        || address.fragment().is_some()
        || address.path() != "/"
    {
        return Err(Error::invalid(
            "PLATFORM_APP_AUTH_URL must be the OAuth2 Proxy HTTP(S) origin".into(),
        ));
    }
    if !access.groups.is_empty() {
        address
            .query_pairs_mut()
            .append_pair("allowed_groups", &access.groups.join(","));
    }
    Ok(json!({ "forwardAuth": {
        "address": address.as_str(),
        "authRequestHeaders": ["Cookie", "User-Agent", "Accept"],
        "authResponseHeaders": ["X-Auth-Request-User", "X-Auth-Request-Email", "X-Auth-Request-Preferred-Username", "X-Auth-Request-Groups"]
    } }))
}

pub fn marker(job: &Job) -> Result<String> {
    let access = job
        .access
        .as_ref()
        .ok_or_else(|| Error::invalid("App job has no access rules".into()))?;
    Ok(format!("{}:{}", job.app_id()?, access.revision))
}

fn confirmed(headers: &str, expected: &str) -> bool {
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1));
    matches!(status, Some("302" | "401"))
        && headers.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("x-widefleet-access-revision") && value.trim() == expected
            })
        })
}

fn observation(headers: &str) -> String {
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .filter(|status| status.len() == 3 && status.bytes().all(|byte| byte.is_ascii_digit()))
        .unwrap_or("missing");
    let revision = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("x-widefleet-access-revision"))
        .map(|(_, value)| value.trim())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 96
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':'))
        })
        .unwrap_or("missing or invalid");
    format!("HTTP status {status}; observed access revision {revision}")
}

pub async fn verify(docker: &Docker, configuration: &Configuration, job: &Job) -> Result<()> {
    let expected = marker(job)?;
    if job
        .access
        .as_ref()
        .is_some_and(|access| access.revision == 0 && access.groups.is_empty())
    {
        // Revision zero preserves the existing installation-wide SSO rule.
        return Ok(());
    }
    let origin =
        Url::parse(&configuration.proxy_url).map_err(|error| Error::invalid(error.to_string()))?;
    if origin.scheme() != "https"
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err(Error::invalid(
            "PLATFORM_PROXY_URL must be a private HTTPS origin".into(),
        ));
    }
    let command = vec![
        "curl".into(),
        "--silent".into(),
        "--show-error".into(),
        "--max-time".into(),
        "2".into(),
        "--insecure".into(),
        "--write-out".into(),
        "HTTP %{http_code}\nX-Widefleet-Access-Revision: %header{x-widefleet-access-revision}\n"
            .into(),
        "--output".into(),
        "/dev/null".into(),
        "--header".into(),
        format!("Host: {}", job.hostname()?),
        origin.to_string(),
    ];
    // The private fleet network authenticates this hop. TLS verification is
    // disabled only for this credential-free probe: the proxy's public certificate
    // need not cover its private Docker name. Never follow the SSO redirect.
    // Output only the status and revision, so even a curl failure after receiving
    // response headers cannot include SSO cookies in the persisted error.
    let mut last_observation = String::from("no probe response");
    for _ in 0..30 {
        match docker::execute_output(docker, job, command.clone()).await {
            Ok(headers) => {
                let headers = String::from_utf8_lossy(&headers);
                if confirmed(&headers, &expected) {
                    return Ok(());
                }
                last_observation = observation(&headers);
            }
            Err(error) => last_observation = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(Error::invalid(format!(
        "Traefik has not confirmed the requested app access rules ({expected}): {last_observation}; retry after checking the private proxy connection"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[tokio::test]
    async fn publishes_an_isolated_auth_rule_and_rejects_ambiguous_groups() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let mut configuration = Configuration::try_parse_from([
            "platform-agent",
            "--url",
            "https://platform.example.test",
            "--token",
            "fixture-only",
            "--routing-directory",
            "/unused",
        ])
        .map_err(|error| Error::invalid(error.to_string()))?;
        configuration.routing_directory = directory.path().to_path_buf();
        let mut job: Job = serde_json::from_value(json!({
            "id": uuid::Uuid::new_v4(), "fleetId": uuid::Uuid::new_v4(), "appId": uuid::Uuid::new_v4(),
            "kind": "configure", "hostname": "review.notes.apps.example.test", "attempt": 1,
            "leaseToken": uuid::Uuid::new_v4(), "leaseUntil": "2099-01-01T00:00:00Z",
            "access": { "revision": 7, "groups": ["team&allowed_groups=other", "engineering"] }
        }))?;
        docker::route(&configuration, &job).await?;
        let name = format!("platform-app-{}", job.app_id()?);
        let path = directory.path().join(format!("{name}.yaml"));
        let bytes = tokio::fs::read(&path).await?;
        let route: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(
            route["http"]["routers"][&name]["middlewares"],
            json!([
                "clear-client-identity@file",
                format!("{name}-access-revision@file"),
                format!("{name}-auth@file"),
                "remove-app-credentials@file"
            ])
        );
        let auth = middleware(&configuration, &job)?;
        let address = Url::parse(
            auth["forwardAuth"]["address"]
                .as_str()
                .ok_or_else(|| Error::invalid("No auth address".into()))?,
        )
        .map_err(|error| Error::invalid(error.to_string()))?;
        assert_eq!(
            address.query_pairs().collect::<Vec<_>>(),
            vec![(
                "allowed_groups".into(),
                "team&allowed_groups=other,engineering".into()
            )]
        );
        assert_eq!(route["http"]["middlewares"][format!("{name}-auth")], auth);
        job.access
            .as_mut()
            .ok_or_else(|| Error::invalid("No access snapshot".into()))?
            .groups = vec!["engineering,other".into()];
        assert!(docker::route(&configuration, &job).await.is_err());
        assert_eq!(tokio::fs::read(&path).await?, bytes);
        job.access
            .as_mut()
            .ok_or_else(|| Error::invalid("No access snapshot".into()))?
            .groups
            .clear();
        assert_eq!(
            middleware(&configuration, &job)?["forwardAuth"]["address"],
            "http://oauth2-proxy:4180/"
        );
        job.access = None;
        assert!(docker::route(&configuration, &job).await.is_err());
        assert_eq!(tokio::fs::read(&path).await?, bytes);
        Ok(())
    }

    #[test]
    fn accepts_only_an_unauthenticated_response_from_the_expected_route() {
        assert!(confirmed(
            "HTTP/2 302 Found\r\nX-Widefleet-Access-Revision: app:2\r\n",
            "app:2"
        ));
        assert!(confirmed(
            "HTTP/1.1 401 Unauthorized\r\nx-widefleet-access-revision: app:2\r\n",
            "app:2"
        ));
        assert!(!confirmed(
            "HTTP/2 302 Found\r\nX-Widefleet-Access-Revision: app:1\r\n",
            "app:2"
        ));
        assert!(!confirmed(
            "HTTP/2 200 OK\r\nX-Widefleet-Access-Revision: app:2\r\n",
            "app:2"
        ));
        assert!(!confirmed(
            "HTTP/2 500 Error\r\nX-Widefleet-Access-Revision: app:2\r\n",
            "app:2"
        ));
    }

    #[test]
    fn reports_status_and_revision_without_unrelated_response_headers() {
        assert_eq!(
            observation(
                "HTTP/2 503\r\nX-Widefleet-Access-Revision: app:1\r\nSet-Cookie: secret=session\r\n"
            ),
            "HTTP status 503; observed access revision app:1"
        );
        assert_eq!(
            observation("HTTP/2 302\r\nSet-Cookie: secret=session\r\n"),
            "HTTP status 302; observed access revision missing or invalid"
        );
        assert_eq!(
            observation("HTTP 000\nX-Widefleet-Access-Revision: \n"),
            "HTTP status 000; observed access revision missing or invalid"
        );
    }
}
