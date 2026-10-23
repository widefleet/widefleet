use super::{
    CLIENT_ID, Credentials, DeviceCode, LoginOptions, credential_entry, epoch, file, login_scope,
    save_session,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use platform_core::{
    Error, Result,
    http::{Api, json},
    sha256,
};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, path::PathBuf, time::Duration};

const CLOUD: &str = "https://app.widefleet.com";
const CALLBACK: &str = "https://app.widefleet.com/cli-login/callback";

fn random_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[derive(Deserialize, Serialize)]
struct BrowserLogin {
    request_id: String,
    verification_uri: String,
    user_code: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Phase {
    Cloud {
        verifier: String,
        poll_token: String,
        browser: Option<BrowserLogin>,
        platform_url: Option<String>,
    },
    Device {
        device: DeviceCode,
    },
    Finalizing {
        platform_url: String,
        context_request: Option<String>,
    },
    Connected {
        platform_url: String,
        credentials_file: Option<PathBuf>,
        organization: Option<Organization>,
    },
    Finished {
        status: String,
    },
}

#[derive(Deserialize, Serialize)]
struct Pending {
    id: String,
    origin: String,
    scope: String,
    expires_at: u64,
    next_poll_at: u64,
    interval: u64,
    phase: Phase,
}

#[derive(Serialize)]
struct LoginState<'a> {
    status: &'a str,
    platform_url: Option<&'a str>,
    organization: Option<&'a Organization>,
    verification_uri: Option<&'a str>,
    user_code: Option<&'a str>,
    expires_at: Option<u64>,
    credentials_file: Option<&'a PathBuf>,
    next_action: Option<&'a str>,
}

#[derive(Deserialize, Serialize, Clone)]
struct Organization {
    organization_id: String,
    organization_name: String,
}

pub struct LoginConnection {
    pub platform_url: String,
    pub organization_id: Option<String>,
}

impl Pending {
    fn state(&self) -> LoginState<'_> {
        let mut state = LoginState {
            status: "awaiting_authorization",
            platform_url: Some(&self.origin),
            organization: None,
            verification_uri: None,
            user_code: None,
            expires_at: Some(self.expires_at),
            credentials_file: None,
            next_action: Some("widefleet login --status --json"),
        };
        match &self.phase {
            Phase::Cloud {
                browser,
                platform_url,
                ..
            } => {
                state.status = if platform_url.is_some() {
                    "awaiting_authorization"
                } else {
                    "awaiting_selection"
                };
                state.platform_url = platform_url.as_deref();
                state.verification_uri = browser
                    .as_ref()
                    .map(|value| value.verification_uri.as_str());
                state.user_code = browser.as_ref().map(|value| value.user_code.as_str());
            }
            Phase::Device { device } => {
                state.verification_uri = Some(&device.verification_uri);
                state.user_code = Some(&device.user_code);
            }
            Phase::Finalizing { platform_url, .. } => {
                state.status = "finishing";
                state.platform_url = Some(platform_url);
            }
            Phase::Connected {
                platform_url,
                credentials_file,
                organization,
            } => {
                state.status = "connected";
                state.platform_url = Some(platform_url);
                state.credentials_file = credentials_file.as_ref();
                state.organization = organization.as_ref();
                state.expires_at = None;
                state.next_action = None;
            }
            Phase::Finished { status } => {
                state.status = status;
                state.next_action = Some("widefleet login --restart");
            }
        }
        state
    }

    fn finished(&self) -> bool {
        matches!(self.phase, Phase::Connected { .. } | Phase::Finished { .. })
    }
}

// Pending authorization secrets need the same protection as refresh tokens.
// The profile is local: the browser link never identifies a machine or file.
struct Store {
    key: String,
    file: Option<file::SessionFile>,
}

impl Store {
    async fn open(profile: &str, credentials: &Credentials) -> Result<Self> {
        let key = format!("cli-login:{}", sha256(profile.as_bytes()));
        if let Some(file) = &credentials.session_file {
            let mut path = file.0.as_os_str().to_owned();
            path.push(".login");
            return Ok(Self {
                key,
                file: Some(file::SessionFile(PathBuf::from(path))),
            });
        }
        #[cfg(unix)]
        if let Ok(file) = super::private_file(&key)
            && file.0.try_exists()?
        {
            return Ok(Self {
                key,
                file: Some(file),
            });
        }
        let account = key.clone();
        let available = tokio::task::spawn_blocking(move || {
            let entry = credential_entry(&account)?;
            match entry.get_password() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(Error::credentials(error.to_string())),
            }
        })
        .await
        .map_err(|error| Error::credentials(error.to_string()))?;
        #[cfg(unix)]
        if available.is_err() {
            let file = super::private_file(&key)?;
            return Ok(Self {
                key,
                file: Some(file),
            });
        }
        available?;
        Ok(Self { key, file: None })
    }

    async fn lock(&self) -> Result<File> {
        if let Some(file) = self.file.clone() {
            return tokio::task::spawn_blocking(move || file.lock())
                .await
                .map_err(|error| Error::credentials(error.to_string()))?;
        }
        super::lock(self.key.clone()).await
    }

    fn read(&self) -> Result<Option<Pending>> {
        let bytes = if let Some(file) = &self.file {
            file.read()?
        } else {
            match credential_entry(&self.key)?.get_password() {
                Ok(value) => Some(value.into_bytes()),
                Err(keyring::Error::NoEntry) => None,
                Err(error) => return Err(Error::credentials(error.to_string())),
            }
        };
        bytes
            .map(|value| {
                serde_json::from_slice(&value).map_err(|_| {
                    Error::credentials(
                        "The saved login is invalid. Run widefleet login --restart".into(),
                    )
                })
            })
            .transpose()
    }

    fn write(&self, pending: &Pending) -> Result<()> {
        let value = serde_json::to_string(pending)?;
        if let Some(file) = &self.file {
            return file.write(value.as_bytes());
        }
        credential_entry(&self.key)?
            .set_password(&value)
            .map_err(|error| Error::credentials(error.to_string()))
    }
}

fn display(pending: &Pending, as_json: bool) -> Result<()> {
    let state = pending.state();
    if as_json {
        return crate::print_json(&state);
    }
    if let Some(url) = state.verification_uri {
        println!(
            "Open {url} and verify code: {}",
            state.user_code.unwrap_or_default()
        );
        println!(
            "Approve only the request you started. Resume with widefleet login or check widefleet login --status."
        );
    } else if state.status == "connected" {
        println!("Connected to {}.", state.platform_url.unwrap_or_default());
        if let Some(organization) = state.organization {
            println!(
                "Organization: {} ({})",
                organization.organization_name, organization.organization_id
            );
        }
        if let Some(path) = state.credentials_file {
            println!(
                "Credentials are stored unencrypted in {} (owner-only access).",
                path.display()
            );
        } else {
            println!("Credentials are stored in the operating system's credential store.");
        }
    } else {
        println!(
            "Login {}. Run widefleet login --restart to start again.",
            state.status
        );
    }
    Ok(())
}

async fn start(api: &Api, scope: String, credentials: &Credentials) -> Result<Pending> {
    let now = epoch()?;
    if api.origin_text() == CLOUD {
        return Ok(Pending {
            id: random_secret(),
            origin: CLOUD.into(),
            scope,
            expires_at: now + 1800,
            next_poll_at: 0,
            interval: 3,
            phase: Phase::Cloud {
                verifier: random_secret(),
                poll_token: random_secret(),
                browser: None,
                platform_url: None,
            },
        });
    }
    credentials.for_login(&api.origin_text()).await?;
    let resource = format!("{}/api/v1", api.origin_text());
    let mut device: DeviceCode = json(
        api.request(Method::POST, "/api/auth/device/code")
            .form(&[
                ("client_id", CLIENT_ID),
                ("scope", scope.as_str()),
                ("resource", resource.as_str()),
            ])
            .send()
            .await?,
    )
    .await?;
    let mut url =
        Url::parse(&device.verification_uri).map_err(|error| Error::invalid(error.to_string()))?;
    if url.origin() != api.origin.origin()
        || url.path() != "/device"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::invalid(
            "The device verification URL does not belong to this platform".into(),
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut()
        .append_pair("user_code", &device.user_code);
    device.verification_uri = url.into();
    let interval = device.interval.clamp(1, 60);
    Ok(Pending {
        id: random_secret(),
        origin: api.origin_text(),
        scope,
        expires_at: now + device.expires_in.min(1800),
        next_poll_at: now + interval,
        interval,
        phase: Phase::Device { device },
    })
}

async fn advance(pending: &mut Pending, credentials: &Credentials, store: &Store) -> Result<()> {
    if pending.finished() {
        return Ok(());
    }
    let recovery_origin = match &pending.phase {
        Phase::Cloud { platform_url, .. } => platform_url.as_deref(),
        Phase::Device { .. } => Some(pending.origin.as_str()),
        _ => None,
    };
    if let Some(origin) = recovery_origin
        && let Ok(session) = super::read_session(origin.to_owned(), credentials).await
        && session.login_id.as_deref() == Some(&pending.id)
    {
        let context_request = match &pending.phase {
            Phase::Cloud { verifier, .. } => Some(challenge(verifier)),
            _ => None,
        };
        pending.phase = Phase::Finalizing {
            platform_url: origin.to_owned(),
            context_request,
        };
    }
    if matches!(pending.phase, Phase::Finalizing { .. }) {
        return finish(pending, credentials).await;
    }
    let now = epoch()?;
    if now >= pending.expires_at {
        pending.phase = Phase::Finished {
            status: "expired".into(),
        };
        return Ok(());
    }
    if now < pending.next_poll_at {
        return Ok(());
    }
    pending.next_poll_at = now + pending.interval;
    let api = Api::new(&pending.origin)?;
    let (target, response) = match &mut pending.phase {
        Phase::Cloud {
            verifier,
            poll_token,
            browser,
            platform_url,
        } => {
            if browser.is_none() {
                let request_id = challenge(verifier);
                let started: BrowserLogin = json(api.request(Method::POST, "/api/auth/cli-login/start")
                    .json(&serde_json::json!({ "code_challenge": request_id, "poll_hash": sha256(poll_token.as_bytes()), "scope": pending.scope }))
                    .send().await?).await?;
                let url = Url::parse(&started.verification_uri)
                    .map_err(|error| Error::invalid(error.to_string()))?;
                let expected_code =
                    format!("{}-{}", &request_id[..4], &request_id[4..8]).to_uppercase();
                if url.origin() != api.origin.origin()
                    || url.path() != "/cli-login"
                    || started.request_id != request_id
                    || started.user_code != expected_code
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
                    || !url
                        .query_pairs()
                        .any(|(name, value)| name == "request" && value == request_id)
                {
                    return Err(Error::invalid("Invalid Cloud login response".into()));
                }
                pending.expires_at = now + started.expires_in.min(1800);
                pending.interval = started.interval.clamp(1, 60);
                *browser = Some(started);
                return Ok(());
            }
            #[derive(Deserialize)]
            struct Poll {
                status: String,
                platform_url: Option<String>,
                code: Option<String>,
            }
            let response = api.request(Method::POST, "/api/auth/cli-login/poll")
                .json(&serde_json::json!({ "request_id": challenge(verifier), "poll_token": poll_token }))
                .send().await?;
            if response.status() == reqwest::StatusCode::GONE {
                pending.phase = Phase::Finished {
                    status: "expired".into(),
                };
                return Ok(());
            }
            let result: Poll = json(response).await?;
            if let Some(origin) = &result.platform_url {
                let selected = Api::new(origin)?.origin_text();
                if platform_url
                    .as_ref()
                    .is_some_and(|previous| previous != &selected)
                {
                    return Err(Error::invalid(
                        "The login destination changed. Run widefleet login --restart".into(),
                    ));
                }
                *platform_url = Some(selected);
            }
            match result.status.as_str() {
                "awaiting_selection" | "awaiting_authorization" => return Ok(()),
                "denied" => {
                    pending.phase = Phase::Finished {
                        status: "denied".into(),
                    };
                    return Ok(());
                }
                "authorized" => {}
                _ => return Err(Error::invalid("Invalid Cloud login state".into())),
            }
            let target = Api::new(
                platform_url
                    .as_deref()
                    .ok_or_else(|| Error::invalid("Login has no destination".into()))?,
            )?;
            if target.origin.scheme() != "https" {
                return Err(Error::invalid(
                    "Cloud login requires an HTTPS destination".into(),
                ));
            }
            let code = result
                .code
                .ok_or_else(|| Error::invalid("Login has no authorization code".into()))?;
            let verifier = verifier.clone();
            credentials.for_login(&target.origin_text()).await?;
            // Persist the selected issuer before consuming its one-use code.
            // Recovery can then find credentials saved just before a crash.
            store.write(pending)?;
            // The verifier is sent only to the selected authorization server.
            let response = target
                .request(Method::POST, "/api/auth/oauth2/token")
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", CLIENT_ID),
                    ("code", code.as_str()),
                    ("code_verifier", verifier.as_str()),
                    ("redirect_uri", CALLBACK),
                ])
                .send()
                .await?;
            (target, response)
        }
        Phase::Device { device } => {
            let response = api
                .request(Method::POST, "/api/auth/oauth2/token")
                .form(&[
                    ("client_id", CLIENT_ID),
                    ("device_code", device.device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await?;
            (api, response)
        }
        Phase::Connected { .. } | Phase::Finished { .. } | Phase::Finalizing { .. } => {
            return Ok(());
        }
    };
    if response.status().is_success() {
        let tokens = json(response).await?;
        let destination = target.origin_text();
        let selected = credentials.for_login(&destination).await?;
        let _lock = selected.lock(destination.clone()).await?;
        save_session(
            destination.clone(),
            tokens,
            &selected,
            Some(pending.id.clone()),
        )
        .await?;
        drop(_lock);
        let context_request = match &pending.phase {
            Phase::Cloud { verifier, .. } => Some(challenge(verifier)),
            _ => None,
        };
        pending.phase = Phase::Finalizing {
            platform_url: destination,
            context_request,
        };
        return finish(pending, &selected).await;
    }
    #[derive(Deserialize)]
    struct Failure {
        error: String,
    }
    let failure: Failure = response.json().await?;
    match failure.error.as_str() {
        "authorization_pending" => {}
        "slow_down" => {
            pending.interval = pending.interval.saturating_add(5).min(60);
            pending.next_poll_at = now + pending.interval;
        }
        "access_denied" => {
            pending.phase = Phase::Finished {
                status: "denied".into(),
            }
        }
        "expired_token" | "invalid_grant" => {
            pending.phase = Phase::Finished {
                status: "expired".into(),
            }
        }
        _ => {
            return Err(Error::invalid(format!(
                "Device login failed: {}",
                failure.error
            )));
        }
    }
    Ok(())
}

async fn finish(pending: &mut Pending, credentials: &Credentials) -> Result<()> {
    let Phase::Finalizing {
        platform_url,
        context_request,
    } = &pending.phase
    else {
        return Ok(());
    };
    let api = Api::new(platform_url)?;
    let organization = if let Some(request) = context_request {
        // An environment token can belong to the previous installation. Only
        // the credentials obtained by this login may cross this boundary.
        let token = super::stored_access_token(&api, credentials).await?;
        let response = api
            .request(Method::GET, "/api/cli-login/context")
            .query(&[("request", request)])
            .bearer_auth(token)
            .send()
            .await?;
        let terminal = match response.status() {
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::GONE => Some("expired"),
            reqwest::StatusCode::FORBIDDEN => Some("denied"),
            reqwest::StatusCode::UNAUTHORIZED => Some("not_signed_in"),
            _ => None,
        };
        if let Some(status) = terminal {
            pending.phase = Phase::Finished {
                status: status.into(),
            };
            return Ok(());
        }
        let context: Organization = json(response).await?;
        api.clone()
            .with_organization(Some(&context.organization_id))?;
        Some(context)
    } else {
        None
    };
    pending.phase = Phase::Connected {
        credentials_file: credentials.stored_file(platform_url)?.map(|file| file.0),
        platform_url: platform_url.clone(),
        organization,
    };
    Ok(())
}

pub async fn login(
    api: &Api,
    credentials: &Credentials,
    options: LoginOptions,
    profile: &str,
) -> Result<Option<LoginConnection>> {
    let scope = login_scope(&options)?;
    let store = Store::open(profile, credentials).await?;
    let mut restart = options.restart;
    let mut last_output = String::new();
    loop {
        let lock = store.lock().await?;
        let saved = if restart { None } else { store.read()? };
        restart = false;
        let mut pending = match saved {
            Some(pending) if options.status || !pending.finished() => {
                if !options.status
                    && (pending.origin != api.origin_text() || pending.scope != scope)
                {
                    return Err(Error::invalid(
                        "A different login is pending. Use widefleet login --status or --restart"
                            .into(),
                    ));
                }
                pending
            }
            _ if options.status => {
                if options.json {
                    crate::print_json(
                        &serde_json::json!({ "status": "not_started", "next_action": "widefleet login" }),
                    )?;
                } else {
                    println!("No login is pending. Run widefleet login.");
                }
                return Ok(None);
            }
            _ => start(api, scope.clone(), credentials).await?,
        };
        if options.status
            && let Phase::Connected { platform_url, .. } = &pending.phase
            && super::read_session(platform_url.clone(), credentials)
                .await
                .is_err()
        {
            pending.phase = Phase::Finished {
                status: "not_signed_in".into(),
            };
        }
        // Save the PKCE key before the idempotent Cloud start request. A killed
        // process can repeat that request and recover the same browser link.
        store.write(&pending)?;
        let result = advance(&mut pending, credentials, &store).await;
        store.write(&pending)?;
        drop(lock);
        if let Err(error) = result {
            if options.json {
                crate::print_json(
                    &serde_json::json!({ "status": "failed", "retryable": true, "next_action": "widefleet login --status --json" }),
                )?;
            }
            return Err(error);
        }
        let output = serde_json::to_string(&pending.state())?;
        if output != last_output {
            display(&pending, options.json)?;
            last_output = output;
        }
        if let Phase::Connected {
            platform_url,
            organization,
            ..
        } = &pending.phase
        {
            return Ok(Some(LoginConnection {
                platform_url: platform_url.clone(),
                organization_id: organization
                    .as_ref()
                    .map(|organization| organization.organization_id.clone()),
            }));
        }
        if options.no_wait || options.status {
            return Ok(None);
        }
        if let Phase::Finished { status } = &pending.phase {
            let description = if status == "denied" {
                "was denied"
            } else {
                status
            };
            return Err(Error::invalid(format!(
                "Device login {description}. Run widefleet login --restart"
            )));
        }
        tokio::time::sleep(Duration::from_secs(
            pending.next_poll_at.saturating_sub(epoch()?).clamp(1, 60),
        ))
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::challenge;

    #[test]
    fn pkce_matches_rfc7636() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
}
