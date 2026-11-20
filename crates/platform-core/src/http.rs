use crate::{Error, Result};
use reqwest::header::HeaderValue;
use reqwest::{Client, Method, RequestBuilder, Response, Url};
use serde::de::DeserializeOwned;
use std::time::Duration;

#[derive(Clone)]
pub struct Api {
    pub origin: Url,
    pub client: Client,
    organization: Option<HeaderValue>,
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
        Ok(Self {
            origin,
            client,
            organization: None,
        })
    }

    pub fn with_organization(mut self, organization: Option<&str>) -> Result<Self> {
        self.organization = organization
            .map(|id| {
                if id.is_empty() || id.len() > 128 || id.trim() != id {
                    return Err(Error::invalid(
                        "Use a non-empty organization ID of at most 128 characters".into(),
                    ));
                }
                HeaderValue::from_str(id)
                    .map_err(|_| Error::invalid("Invalid organization ID".into()))
            })
            .transpose()?;
        Ok(self)
    }

    pub fn origin_text(&self) -> String {
        self.origin.origin().ascii_serialization()
    }

    /// The organization this client selects, when one was chosen.
    pub fn organization_text(&self) -> Option<String> {
        self.organization
            .as_ref()
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }

    pub fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.origin_text()))
            .header("origin", self.origin_text())
    }

    pub fn authenticated(&self, method: Method, path: &str, token: &str) -> RequestBuilder {
        let request = self
            .request(method, &format!("/api/v1{path}"))
            .bearer_auth(token);
        match &self.organization {
            Some(organization) => request.header("x-widefleet-organization", organization),
            None => request,
        }
    }
}

pub async fn json<T: DeserializeOwned>(response: Response) -> Result<T> {
    let status = response.status();
    let bytes = response.bytes().await?;
    if !status.is_success() {
        return Err(failure(status, &bytes));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

// Read each field on its own: gateways may send other types for any of them,
// and one unexpected field must not hide the others.
#[track_caller]
fn failure(status: reqwest::StatusCode, bytes: &[u8]) -> Error {
    let body = serde_json::from_slice::<serde_json::Value>(bytes).ok();
    let field = |name| {
        body.as_ref()
            .and_then(|body| body.get(name))
            .and_then(serde_json::Value::as_str)
    };
    // Codes are reported in telemetry, so accept only constant identifiers.
    let code = field("code")
        .filter(|code| {
            code.len() <= 64
                && code.starts_with(|character: char| character.is_ascii_uppercase())
                && code.chars().all(|character| {
                    character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
                })
        })
        .map(str::to_owned);
    let message = field("message")
        .or_else(|| field("error_description"))
        .or_else(|| field("error"))
        .map(str::to_owned)
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("Request failed").into());
    Error::api(status.as_u16(), code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ErrorKind;

    fn parts(body: &str) -> (Option<String>, String) {
        match failure(reqwest::StatusCode::FORBIDDEN, body.as_bytes()).kind {
            ErrorKind::Api { code, message, .. } => (code, message),
            _ => unreachable!("failure always builds an API error"),
        }
    }

    #[test]
    fn error_responses_keep_messages_when_a_field_has_another_type() {
        assert_eq!(
            parts(r#"{"code":1234,"message":"Request blocked by gateway"}"#),
            (None, "Request blocked by gateway".into())
        );
        assert_eq!(
            parts(r#"{"code":{"id":1},"message":7,"error":"denied"}"#),
            (None, "denied".into())
        );
        assert_eq!(
            parts(r#"{"code":"FORBIDDEN","message":"No access"}"#),
            (Some("FORBIDDEN".into()), "No access".into())
        );
    }

    #[test]
    fn error_codes_accept_only_constant_identifiers() {
        for code in ["forbidden", "NOT FOUND", "", "1CODE", &"A".repeat(65)] {
            let body = serde_json::json!({ "code": code }).to_string();
            assert_eq!(parts(&body).0, None, "{code}");
        }
        assert_eq!(parts("<html>Forbidden</html>"), (None, "Forbidden".into()));
    }
}
