use platform_core::{Error, Result, http::Api};
use reqwest::{Client, Url};
use serde::Deserialize;
use std::{
    io::{BufRead, IsTerminal, Read, Write},
    time::Duration,
};

const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const HTTPS_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DOCUMENT_BYTES: usize = 8192;
const TXT: u16 = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Domain(String);

#[derive(clap::Args)]
pub struct Options {
    /// Find your installation using your work email's domain. The email is not sent.
    #[arg(long, conflicts_with_all = ["domain", "url"], value_parser = Domain::from_email)]
    email: Option<Domain>,
    /// Find your installation using your company domain.
    #[arg(long, conflicts_with_all = ["email", "url"], value_parser = Domain::parse)]
    domain: Option<Domain>,
}

impl Options {
    pub fn domain(&self) -> Option<&Domain> {
        self.domain.as_ref().or(self.email.as_ref())
    }
}

impl Domain {
    pub fn parse(input: &str) -> Result<Self> {
        let input = input.trim().strip_suffix('.').unwrap_or(input.trim());
        if input.is_empty()
            || input.chars().any(|character| {
                character.is_whitespace()
                    || character.is_control()
                    || "/\\:@?#%".contains(character)
            })
        {
            return Err(invalid_domain());
        }
        let url = Url::parse(&format!("https://{input}")).map_err(|_| invalid_domain())?;
        let domain = url.domain().ok_or_else(invalid_domain)?;
        // Leave room for the _widefleet label in a fully qualified DNS name.
        if domain.len() > 242
            || !domain.contains('.')
            || domain.split('.').any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err(invalid_domain());
        }
        Ok(Self(domain.to_owned()))
    }

    pub fn from_email(input: &str) -> Result<Self> {
        let input = input.trim();
        let (local, domain) = input.split_once('@').ok_or_else(invalid_email)?;
        if local.is_empty()
            || local.len() > 64
            || input
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(invalid_email());
        }
        Self::parse(domain).map_err(|_| invalid_email())
    }

    fn record_name(&self) -> String {
        format!("_widefleet.{}.", self.0)
    }

    fn endpoint(&self) -> String {
        format!("https://{}/.well-known/widefleet", self.0)
    }
}

fn invalid_domain() -> Error {
    Error::invalid("Enter a company domain such as example.com, without a URL, port or path".into())
}

fn invalid_email() -> Error {
    Error::invalid("Enter a work email such as employee@example.com".into())
}

pub fn prompt() -> Result<Domain> {
    if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
        return Err(Error::invalid(
            "No platform is configured. Run widefleet login --email employee@example.com or widefleet login --domain example.com; an agent can use the employee's known company domain".into(),
        ));
    }
    eprint!("Work email or company domain: ");
    std::io::stderr().flush()?;
    let mut input = String::new();
    std::io::stdin().lock().take(321).read_line(&mut input)?;
    if input.len() > 320 {
        return Err(invalid_domain());
    }
    if input.contains('@') {
        Domain::from_email(&input)
    } else {
        Domain::parse(&input)
    }
}

enum DnsLookup {
    Records(Vec<Vec<u8>>),
    Unavailable(String),
}

async fn lookup_txt(domain: &Domain) -> DnsLookup {
    let name = domain.record_name();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // Native resolver calls cannot be cancelled. A detached OS thread lets us
    // fall back on timeout without holding up Tokio's runtime shutdown.
    let started = std::thread::Builder::new()
        .name("widefleet-discovery".into())
        .spawn(move || {
            let answer = match system_resolver::lookup(&name, TXT) {
                Ok(records) => DnsLookup::Records(
                    records
                        .into_iter()
                        .filter(|record| {
                            record.rtype == TXT
                                && record.class == system_resolver::CLASS_IN
                                && record
                                    .name
                                    .trim_end_matches('.')
                                    .eq_ignore_ascii_case(name.trim_end_matches('.'))
                        })
                        .map(|record| record.rdata)
                        .collect(),
                ),
                Err(system_resolver::Error::NameDoesNotExist) => DnsLookup::Records(Vec::new()),
                Err(error) => DnsLookup::Unavailable(error.to_string()),
            };
            let _ = sender.send(answer);
        });
    if let Err(error) = started {
        return DnsLookup::Unavailable(error.to_string());
    }
    match tokio::time::timeout(DNS_TIMEOUT, receiver).await {
        Ok(Ok(answer)) => answer,
        Ok(Err(_)) => DnsLookup::Unavailable("system resolver stopped unexpectedly".into()),
        Err(_) => DnsLookup::Unavailable("system resolver timed out".into()),
    }
}

pub async fn resolve(domain: &Domain) -> Result<String> {
    eprintln!("Finding Widefleet for {}…", domain.0);
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(HTTPS_TIMEOUT)
        .timeout(HTTPS_TIMEOUT)
        .user_agent(concat!("widefleet/", env!("CARGO_PKG_VERSION")))
        .build()?;
    resolve_with(domain, lookup_txt(domain).await, &client).await
}

async fn resolve_with(domain: &Domain, dns: DnsLookup, client: &Client) -> Result<String> {
    let dns_reason = match dns {
        DnsLookup::Records(records) => match from_txt(&records)? {
            Some(origin) => return Ok(origin),
            None => format!("No TXT record at {}", domain.record_name()),
        },
        DnsLookup::Unavailable(reason) => format!("System DNS unavailable: {reason}"),
    };
    eprintln!("{dns_reason}. Checking {}", domain.endpoint());
    from_https(client, &domain.endpoint()).await.inspect_err(|_| {
        eprintln!(
            "Could not discover Widefleet for {}. Ask IT to publish a discovery record or configure the CLI in this environment",
            domain.0,
        );
    })
}

fn discovered_origin(value: &str) -> Result<String> {
    let invalid = || {
        Error::invalid("Discovery must specify one HTTPS platform origin without credentials, a path, query or fragment".into())
    };
    if value.len() > 2048
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(invalid());
    }
    let api = Api::new(value).map_err(|_| invalid())?;
    if api.origin.scheme() != "https" || api.origin.host_str().is_none() {
        return Err(invalid());
    }
    Ok(api.origin_text())
}

fn from_txt(records: &[Vec<u8>]) -> Result<Option<String>> {
    let mut selected = None;
    for data in records {
        let mut rest = data.as_slice();
        let mut text = Vec::new();
        // RFC 1035 TXT RDATA is one or more length-prefixed character strings.
        // Strings in the same record are concatenated, not treated as records.
        while let Some((&length, tail)) = rest.split_first() {
            let length = usize::from(length);
            let chunk = tail
                .get(..length)
                .ok_or_else(|| Error::invalid("Malformed Widefleet TXT record".into()))?;
            text.extend_from_slice(chunk);
            rest = &tail[length..];
        }
        let text = std::str::from_utf8(&text)
            .map_err(|_| Error::invalid("Widefleet TXT record must contain UTF-8 text".into()))?;
        let value = text.strip_prefix("url=").ok_or_else(|| {
            Error::invalid("Widefleet TXT record must use url=https://platform.example.com".into())
        })?;
        let origin = discovered_origin(value)?;
        if selected
            .as_ref()
            .is_some_and(|previous| previous != &origin)
        {
            return Err(Error::invalid(
                "Conflicting Widefleet TXT records; ask IT to publish a single platform URL".into(),
            ));
        }
        selected = Some(origin);
    }
    Ok(selected)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    platform_url: String,
}

async fn from_https(client: &Client, endpoint: &str) -> Result<String> {
    // No session, email, or platform access token is attached to discovery.
    let mut response = client
        .get(endpoint)
        .header("accept", "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(Error::invalid(format!(
            "HTTPS discovery returned {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOCUMENT_BYTES as u64)
    {
        return Err(Error::invalid(
            "HTTPS discovery document exceeds 8 KiB".into(),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_DOCUMENT_BYTES {
            return Err(Error::invalid(
                "HTTPS discovery document exceeds 8 KiB".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let document: Document = serde_json::from_slice(&bytes).map_err(|_| {
        Error::invalid("HTTPS discovery must contain JSON with a single platform_url field".into())
    })?;
    discovered_origin(&document.platform_url)
}

#[cfg(test)]
mod tests;
