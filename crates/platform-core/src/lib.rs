mod diagnostics;
pub use diagnostics::{FailureCategory, FailureReason};

pub mod http;
pub mod migrations;
pub mod model;
pub mod reporting;

use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{kind}")]
pub struct Error {
    #[source]
    kind: ErrorKind,
    location: &'static std::panic::Location<'static>,
    reason: Option<FailureReason>,
}

#[derive(Debug, Error)]
pub enum ErrorKind {
    #[error("{0}")]
    Invalid(String),
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API returned {status}: {message}")]
    Api {
        status: u16,
        // The server's machine-readable error code, if it sent a valid one.
        code: Option<String>,
        message: String,
    },
    #[error("I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Credential store failed: {0}")]
    Credentials(String),
}

impl Error {
    #[track_caller]
    fn new(kind: ErrorKind) -> Self {
        Self {
            kind,
            location: std::panic::Location::caller(),
            reason: None,
        }
    }

    #[track_caller]
    pub fn invalid(message: String) -> Self {
        Self::new(ErrorKind::Invalid(message))
    }

    #[track_caller]
    pub fn credentials(message: String) -> Self {
        Self::new(ErrorKind::Credentials(message))
    }

    #[track_caller]
    pub fn api(status: u16, code: Option<String>, message: String) -> Self {
        Self::new(ErrorKind::Api {
            status,
            code,
            message,
        })
    }

    // Outer operations may add context, but must preserve a more specific cause.
    pub fn with_reason(mut self, reason: FailureReason) -> Self {
        self.reason.get_or_insert(reason);
        self
    }

    pub fn reason(&self) -> Option<FailureReason> {
        self.reason
    }

    pub fn kind(&self) -> &ErrorKind {
        &self.kind
    }

    pub fn into_kind(self) -> ErrorKind {
        self.kind
    }
}

impl From<reqwest::Error> for Error {
    #[track_caller]
    fn from(error: reqwest::Error) -> Self {
        Self::new(ErrorKind::Http(error))
    }
}

impl From<std::io::Error> for Error {
    #[track_caller]
    fn from(error: std::io::Error) -> Self {
        Self::new(ErrorKind::Io(error))
    }
}

impl From<serde_json::Error> for Error {
    #[track_caller]
    fn from(error: serde_json::Error) -> Self {
        Self::new(ErrorKind::Json(error))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn asset_hash(path: &str, bytes: &[u8]) -> String {
    // Match path.posix.extname: a leading dot alone is not an extension.
    let basename = path.rsplit('/').next().unwrap_or(path);
    let extension = basename
        .rfind('.')
        .filter(|index| *index > 0)
        .map(|index| &basename[index + 1..])
        .unwrap_or("");
    let content = format!("{}{extension}", STANDARD.encode(bytes));
    blake3::hash(content.as_bytes()).to_hex()[..32].to_owned()
}

#[cfg(test)]
mod tests;
