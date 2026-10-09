use crate::{Error, ErrorKind};
use serde::{Deserialize, Serialize};
use std::{
    backtrace::Backtrace,
    sync::{Arc, Mutex},
    time::Duration,
};

pub const PROJECT_TOKEN: &str = "phc_AdQ4DSNi7QHqvTVqhTGNFUNa5YxkiwLddL46KFSPvkML";
pub const CAPTURE_URL: &str = "https://eu.i.posthog.com/i/v0/e/";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub filename: String,
    pub lineno: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colno: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    #[serde(rename = "type")]
    pub kind: String,
    pub frames: Vec<Frame>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub usage: bool,
    pub crashes: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            usage: true,
            crashes: true,
        }
    }
}

impl Preferences {
    pub fn effective(self) -> Self {
        let disabled = std::env::var_os("CI").is_some()
            || std::env::var("WIDEFLEET_TELEMETRY_DISABLED").is_ok_and(|value| value == "1");
        Self {
            usage: !disabled
                && self.usage
                && std::env::var("PLATFORM_USAGE_REPORTING").map_or(true, |value| value != "false"),
            crashes: !disabled
                && self.crashes
                && std::env::var("PLATFORM_CRASH_REPORTING").map_or(true, |value| value != "false"),
        }
    }
}

fn location(text: &str) -> Option<Frame> {
    let text = text.replace('\\', "/");
    let start = [
        "crates/platform-core/src/",
        "crates/platform-cli/src/",
        "crates/platform-agent/src/",
    ]
    .iter()
    .filter_map(|prefix| text.find(prefix))
    .min()?;
    let mut fields = text[start..].split(':');
    let filename = fields.next()?;
    if !filename.ends_with(".rs")
        || filename.contains("..")
        || !filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/_-.".contains(&byte))
    {
        return None;
    }
    let lineno = fields.next()?.parse().ok()?;
    if lineno == 0 {
        return None;
    }
    let colno = fields
        .next()
        .and_then(|column| column.parse().ok())
        .filter(|column| *column > 0);
    Some(Frame {
        filename: filename.into(),
        lineno,
        colno,
    })
}

fn frames() -> Vec<Frame> {
    Backtrace::force_capture()
        .to_string()
        .lines()
        .filter_map(location)
        .take(20)
        .collect()
}

pub fn error(error: &Error) -> Report {
    let kind = match error.kind() {
        ErrorKind::Invalid(_) => "Invalid",
        ErrorKind::Http(_) => "Http",
        ErrorKind::Api { .. } => "Api",
        ErrorKind::Io(_) => "Io",
        ErrorKind::Json(_) => "Json",
        ErrorKind::Credentials(_) => "Credentials",
    };
    Report {
        kind: kind.into(),
        frames: location(&format!(
            "{}:{}:{}",
            error.location.file(),
            error.location.line(),
            error.location.column()
        ))
        .into_iter()
        .collect(),
    }
}

pub struct PanicCapture(Arc<Mutex<Option<Report>>>);

impl PanicCapture {
    pub fn install() -> Self {
        let captured = Arc::new(Mutex::new(None));
        let writer = Arc::clone(&captured);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic| {
            let mut stack = frames();
            if let Some(frame) = panic.location().and_then(|source| {
                location(&format!(
                    "{}:{}:{}",
                    source.file(),
                    source.line(),
                    source.column()
                ))
            }) {
                stack.insert(0, frame);
                stack.truncate(20);
            }
            if let Ok(mut target) = writer.lock() {
                *target = Some(Report {
                    kind: "Panic".into(),
                    frames: stack,
                });
            }
            previous(panic);
        }));
        Self(captured)
    }

    pub fn take(&self) -> Option<Report> {
        self.0.lock().ok().and_then(|mut value| value.take())
    }
}

pub fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .connect_timeout(Duration::from_millis(750))
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

pub fn metadata() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "os": match std::env::consts::OS { "linux" => "linux", "macos" => "macos", "windows" => "windows", _ => "other" },
        "arch": match std::env::consts::ARCH { "x86_64" => "x86_64", "aarch64" => "aarch64", _ => "other" },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returned_errors_keep_the_original_failure_location() {
        let report = error(&crate::tests::diagnostic_fixture());
        assert!(
            report
                .frames
                .first()
                .is_some_and(|frame| frame.filename == "crates/platform-core/src/tests.rs")
        );
        let result = crate::tests::converted_diagnostic_fixture();
        assert!(result.is_err());
        if let Err(failure) = result {
            let report = error(&failure);
            assert!(
                report
                    .frames
                    .first()
                    .is_some_and(|frame| frame.filename == "crates/platform-core/src/tests.rs")
            );
        }
    }

    #[test]
    fn removes_private_paths_and_rejects_foreign_sources() {
        let frame = location(" at /home/private-company/crates/platform-cli/src/main.rs:123:4");
        assert!(frame.is_some_and(
            |frame| frame.filename == "crates/platform-cli/src/main.rs" && frame.lineno == 123
        ));
        assert!(location("at /home/private-company/customer-worker.ts:12:3").is_none());
        assert!(location("crates/platform-cli/src/../../private.rs:12:3").is_none());
    }

    #[test]
    fn error_messages_are_never_serialized() -> Result<(), serde_json::Error> {
        let report = error(&Error::api(500, "secret-token user@example.test".into()));
        let serialized = serde_json::to_string(&report)?;
        assert!(!serialized.contains("secret-token"));
        assert!(!serialized.contains("example.test"));
        assert_eq!(report.kind, "Api");
        Ok(())
    }
}
