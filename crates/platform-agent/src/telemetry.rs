use crate::config::Configuration;
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::{Job, TelemetryDestination},
};
use reqwest::{Method, Url};
use serde::Deserialize;

#[derive(Deserialize)]
struct Credentials {
    token: String,
}

pub async fn destination(
    api: &Api,
    configuration: &Configuration,
    job: &Job,
) -> Result<Option<TelemetryDestination>> {
    let credentials: Option<Credentials> = json(
        api.authenticated(
            Method::GET,
            &format!("/agent/jobs/{}/telemetry", job.id),
            &configuration.token,
        )
        .query(&[("leaseToken", job.lease_token)])
        .send()
        .await?,
    )
    .await?;
    let Some(credentials) = credentials else {
        return Ok(None);
    };
    let origin = configuration
        .runtime_platform_url
        .as_deref()
        .unwrap_or(&configuration.url);
    let mut url = Url::parse(origin).map_err(|error| Error::invalid(error.to_string()))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || url.scheme() == "http" && api.origin.scheme() == "http")
    {
        return Err(Error::invalid("Use an HTTPS runtime platform origin; HTTP is allowed only for a local HTTP installation".into()));
    }
    url.set_path(&format!("/api/v1/telemetry/{}", job.app_id()?));
    Ok(Some(TelemetryDestination {
        url: url.to_string(),
        token: credentials.token,
    }))
}
