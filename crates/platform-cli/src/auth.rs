use platform_core::{
    Error, Result,
    http::{Api, json},
    sha256,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::Instant;

mod file;

#[derive(Clone)]
pub struct Credentials {
    session_file: Option<file::SessionFile>,
}

impl Credentials {
    pub fn new(session_file: Option<PathBuf>) -> Self {
        Self {
            session_file: session_file.map(file::SessionFile),
        }
    }

    async fn lock(&self, origin: String) -> Result<File> {
        if let Some(file) = self.session_file.clone() {
            return tokio::task::spawn_blocking(move || file.lock())
                .await
                .map_err(|error| Error::credentials(error.to_string()))?;
        }
        lock(origin).await
    }

    async fn prepare(&self, origin: String) -> Result<()> {
        let file = self.session_file.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(file) = file {
                let _lock = file.lock()?;
                read_file_session(&file, &origin)?;
            } else {
                credential_entry(&origin)?;
            }
            Ok(())
        })
        .await
        .map_err(|error| Error::credentials(error.to_string()))?
    }
}

#[derive(clap::Args)]
pub struct LoginOptions {
    /// API scopes to request, separated by spaces or commas. Replaces the defaults.
    #[arg(long = "scope", value_delimiter = ',', num_args = 1.., default_values = ["platform:read", "platform:write"])]
    scopes: Vec<String>,
}

const CLIENT_ID: &str = "platform-cli";

#[derive(Deserialize)]
struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize, Serialize)]
struct Tokens {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    expires_in: u64,
    token_type: String,
}

#[derive(Deserialize, Serialize)]
struct Session {
    tokens: Tokens,
    expires_at: u64,
}

#[derive(Deserialize, Serialize)]
struct FileSession {
    origin: String,
    #[serde(flatten)]
    session: Session,
}

fn read_file_session(file: &file::SessionFile, origin: &str) -> Result<Option<Session>> {
    let Some(bytes) = file.read()? else {
        return Ok(None);
    };
    let stored: FileSession = serde_json::from_slice(&bytes).map_err(|_| {
        Error::credentials("Invalid session file; choose a new file and run widefleet login".into())
    })?;
    if stored.origin != origin {
        return Err(Error::credentials(
            "The session file belongs to a different platform; use a separate file for each platform origin".into(),
        ));
    }
    Ok(Some(stored.session))
}

fn epoch() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| Error::invalid(error.to_string()))
}

fn credential_entry(origin: &str) -> Result<keyring::Entry> {
    keyring::Entry::store_status().as_ref().map_err(|error| {
        let guidance = if cfg!(windows) {
            "Check that Windows Credential Manager is available. For noninteractive use, set PLATFORM_ACCESS_TOKEN"
        } else if cfg!(target_os = "macos") {
            "Check that your login Keychain is available and unlocked. For headless login, choose --session-file PATH (unencrypted, owner-only file). For noninteractive use, set PLATFORM_ACCESS_TOKEN"
        } else {
            "On Linux, an available, unlocked Secret Service and a session D-Bus are required. For headless login, choose --session-file PATH (unencrypted, owner-only file). For noninteractive use, set PLATFORM_ACCESS_TOKEN"
        };
        Error::credentials(format!(
            "Could not initialize the operating system credential store: {error}. {guidance}"
        ))
    })?;
    keyring::Entry::new("app-platform", origin)
        .map_err(|error| Error::credentials(error.to_string()))
}

async fn read_session(origin: String, credentials: &Credentials) -> Result<Session> {
    let file = credentials.session_file.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(file) = file {
            return read_file_session(&file, &origin)?.ok_or_else(|| Error::credentials(
                "No session is stored in this file. Run widefleet login with the same --session-file or PLATFORM_SESSION_FILE".into(),
            ));
        }
        let entry = credential_entry(&origin)?;
        let value = entry
            .get_password()
            .map_err(|error| Error::credentials(format!("{error}. Run widefleet login first")))?;
        Ok(serde_json::from_str(&value)?)
    })
    .await
    .map_err(|error| Error::credentials(error.to_string()))?
}

async fn save_session(
    origin: String,
    tokens: Tokens,
    credentials: &Credentials,
) -> Result<Session> {
    if tokens.refresh_token.is_empty() {
        return Err(Error::invalid(
            "The OAuth server did not issue a refresh token. Login requires offline_access; run widefleet login again".into(),
        ));
    }
    if !tokens.token_type.eq_ignore_ascii_case("bearer")
        || tokens.expires_in == 0
        || tokens.access_token.is_empty()
    {
        return Err(Error::invalid(
            "The OAuth server returned incomplete credentials".into(),
        ));
    }
    let session = Session {
        expires_at: epoch()?.saturating_add(tokens.expires_in),
        tokens,
    };
    let file = credentials.session_file.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(file) = file {
            // Recheck the origin under the same lock used by refresh and logout.
            read_file_session(&file, &origin)?;
            let stored = FileSession { origin, session };
            file.write(&serde_json::to_vec(&stored)?)?;
            return Ok(stored.session);
        }
        let entry = credential_entry(&origin)?;
        entry
            .set_password(&serde_json::to_string(&session)?)
            .map_err(|error| Error::credentials(error.to_string()))?;
        Ok(session)
    })
    .await
    .map_err(|error| Error::credentials(error.to_string()))?
}

async fn lock(origin: String) -> Result<File> {
    tokio::task::spawn_blocking(move || {
        let base = std::env::var_os("XDG_STATE_HOME")
            .or_else(|| std::env::var_os("LOCALAPPDATA"))
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
            })
            .ok_or_else(|| Error::invalid("No user state directory is configured".into()))?;
        let directory = base.join("app-platform");
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join(format!("{}.lock", sha256(origin.as_bytes()))))?;
        file.lock()?;
        Ok(file)
    })
    .await
    .map_err(|error| Error::credentials(error.to_string()))?
}

pub async fn login(api: &Api, credentials: &Credentials, options: LoginOptions) -> Result<()> {
    let mut scopes = vec![
        "openid".to_owned(),
        "profile".to_owned(),
        "offline_access".to_owned(),
    ];
    for scope in options.scopes {
        if scope.is_empty() || scope.chars().any(char::is_whitespace) {
            return Err(Error::invalid(
                "Pass each scope as a separate argument or comma-separated value".into(),
            ));
        }
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    let scope = scopes.join(" ");
    credentials.prepare(api.origin_text()).await?;
    let resource = format!("{}/api/v1", api.origin_text());
    let device: DeviceCode = json(
        api.request(Method::POST, "/api/auth/device/code")
            .form(&[
                ("client_id", CLIENT_ID),
                ("scope", &scope),
                ("resource", &resource),
            ])
            .send()
            .await?,
    )
    .await?;
    let verification = reqwest::Url::parse(&device.verification_uri)
        .map_err(|error| Error::invalid(error.to_string()))?;
    if verification.origin() != api.origin.origin() || verification.path() != "/device" {
        return Err(Error::invalid(
            "The device verification URL does not belong to this platform".into(),
        ));
    }
    println!("Open {} and enter code: {}", verification, device.user_code);
    println!("Approve only the code shown by this command.");
    let deadline = Instant::now() + Duration::from_secs(device.expires_in.min(1800));
    let mut interval = device.interval.max(1);
    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if Instant::now() >= deadline {
            return Err(Error::invalid(
                "Device login expired. Run login again".into(),
            ));
        }
        let response = api
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
            let _lock = credentials.lock(api.origin_text()).await?;
            save_session(api.origin_text(), tokens, credentials).await?;
            if let Some(file) = &credentials.session_file {
                println!(
                    "Connected. Credentials are stored unencrypted in {} (owner-only access).",
                    file.0.display()
                );
            } else {
                println!(
                    "Connected. Credentials are stored in the operating system's credential store."
                );
            }
            return Ok(());
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

pub async fn access_token(api: &Api, credentials: &Credentials) -> Result<String> {
    if let Ok(token) = std::env::var("PLATFORM_ACCESS_TOKEN") {
        if token.is_empty() {
            return Err(Error::invalid("PLATFORM_ACCESS_TOKEN is empty".into()));
        }
        return Ok(token);
    }
    let _lock = credentials.lock(api.origin_text()).await?;
    let session = read_session(api.origin_text(), credentials).await?;
    if session.expires_at > epoch()?.saturating_add(45) {
        return Ok(session.tokens.access_token);
    }
    let resource = format!("{}/api/v1", api.origin_text());
    let tokens: Tokens = json(
        api.request(Method::POST, "/api/auth/oauth2/token")
            .form(&[
                ("client_id", CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", &session.tokens.refresh_token),
                ("resource", &resource),
            ])
            .send()
            .await?,
    )
    .await?;
    Ok(save_session(api.origin_text(), tokens, credentials)
        .await?
        .tokens
        .access_token)
}

pub async fn logout(api: &Api, credentials: &Credentials) -> Result<()> {
    let _lock = credentials.lock(api.origin_text()).await?;
    let session = read_session(api.origin_text(), credentials).await?;
    let response = api
        .request(Method::POST, "/api/auth/oauth2/revoke")
        .form(&[
            ("client_id", CLIENT_ID),
            ("token", &session.tokens.refresh_token),
            ("token_type_hint", "refresh_token"),
        ])
        .send()
        .await?;
    response.error_for_status()?;
    let origin = api.origin_text();
    let file = credentials.session_file.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(file) = file {
            return file.delete();
        }
        let entry = credential_entry(&origin)?;
        entry
            .delete_credential()
            .map_err(|error| Error::credentials(error.to_string()))
    })
    .await
    .map_err(|error| Error::credentials(error.to_string()))??;
    println!(
        "Refresh token revoked; local credentials removed. Previously issued access tokens expire within five minutes."
    );
    Ok(())
}
