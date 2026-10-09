use crate::{Error, Result};
use reqwest::{Client, Method, RequestBuilder, Response, Url};
use serde::de::DeserializeOwned;
use std::time::Duration;

#[derive(Clone)]
pub struct Api {
    pub origin: Url,
    pub client: Client,
}

impl Api {
    pub fn new(value: &str) -> Result<Self> {
        let origin = Url::parse(value).map_err(|error| Error::invalid(error.to_string()))?;
        let loopback = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !(origin.scheme() == "https" || origin.scheme() == "http" && loopback)
        {
            return Err(Error::invalid(
                "Use an HTTPS platform origin, or HTTP on loopback for development".into(),
            ));
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("app-platform/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { origin, client })
    }

    pub fn origin_text(&self) -> String {
        self.origin.origin().ascii_serialization()
    }

    pub fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.origin_text()))
            .header("origin", self.origin_text())
    }

    pub fn authenticated(&self, method: Method, path: &str, token: &str) -> RequestBuilder {
        self.request(method, &format!("/api/v1{path}"))
            .bearer_auth(token)
    }
}

pub async fn json<T: DeserializeOwned>(response: Response) -> Result<T> {
    let status = response.status();
    let bytes = response.bytes().await?;
    if !status.is_success() {
        #[derive(serde::Deserialize)]
        struct Failure {
            message: Option<String>,
            error_description: Option<String>,
            error: Option<String>,
        }
        let message = serde_json::from_slice::<Failure>(&bytes)
            .ok()
            .and_then(|body| body.message.or(body.error_description).or(body.error))
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("Request failed").into());
        return Err(Error::api(status.as_u16(), message));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
