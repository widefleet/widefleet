use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    reporting::{self, Preferences, Report},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    time::Duration,
};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    action: Action,
    /// Change only usage reporting.
    #[arg(long, global = true, conflicts_with = "crashes")]
    usage: bool,
    /// Change only crash reporting.
    #[arg(long, global = true)]
    crashes: bool,
}

#[derive(Subcommand)]
enum Action {
    Status,
    Enable,
    Disable,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    id: Uuid,
    preferences: Preferences,
}

fn path() -> Result<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .ok_or_else(|| Error::invalid("No local state directory is available".into()))?;
    Ok(base.join("widefleet/telemetry.json"))
}

fn load() -> Result<Configuration> {
    let path = path()?;
    match std::fs::read(&path) {
        Ok(bytes) => return Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let configuration = Configuration {
        id: Uuid::new_v4(),
        preferences: Preferences::default(),
    };
    let parent = path
        .parent()
        .ok_or_else(|| Error::invalid("Invalid telemetry state path".into()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec(&configuration)?)?;
    match temporary.persist_noclobber(&path) {
        Ok(_) => {
            eprintln!(
                "Widefleet shares usage metadata and sanitized error reports with the Widefleet team via PostHog. Disable with `widefleet telemetry disable`. Details: https://widefleet.com/docs/self-hosting/installation-reporting"
            );
            Ok(configuration)
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            Ok(serde_json::from_slice(&std::fs::read(&path)?)?)
        }
        Err(error) => Err(error.error.into()),
    }
}

fn lock_state() -> Result<File> {
    let path = path()?.with_extension("lock");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    file.lock()?;
    Ok(file)
}

fn current(initial: &Configuration) -> Option<Configuration> {
    let saved: Configuration = serde_json::from_slice(&std::fs::read(path().ok()?).ok()?).ok()?;
    (saved.id == initial.id).then_some(saved)
}

pub fn command(options: Options) -> Result<()> {
    let _lock = if matches!(options.action, Action::Status) {
        None
    } else {
        Some(lock_state()?)
    };
    let mut configuration = load()?;
    if !matches!(options.action, Action::Status) {
        let enabled = matches!(options.action, Action::Enable);
        if !options.crashes {
            configuration.preferences.usage = enabled;
        }
        if !options.usage {
            configuration.preferences.crashes = enabled;
        }
        let path = path()?;
        let parent = path
            .parent()
            .ok_or_else(|| Error::invalid("Invalid telemetry state path".into()))?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(&serde_json::to_vec_pretty(&configuration)?)?;
        file.persist(path).map_err(|error| error.error)?;
    }
    crate::print_json(
        &json!({ "id": configuration.id, "preferences": configuration.preferences, "effective": configuration.preferences.effective() }),
    )
}

pub fn initialize() -> Option<Configuration> {
    let effective = Preferences::default().effective();
    if !effective.usage && !effective.crashes {
        return None;
    }
    load().ok()
}

fn envelope(configuration: &Configuration, event: &str, properties: Value) -> Value {
    let mut common = reporting::metadata();
    if let (Some(target), Some(extra)) = (common.as_object_mut(), properties.as_object()) {
        target.extend(extra.clone());
        target.extend(json!({
            "distinct_id": format!("cli:{}", configuration.id), "schema_version": 1,
            "scope": "cli", "component": "cli", "$process_person_profile": false, "$geoip_disable": true,
        }).as_object().into_iter().flatten().map(|(key, value)| (key.clone(), value.clone())));
    }
    json!({ "api_key": reporting::PROJECT_TOKEN, "event": event, "uuid": Uuid::new_v4(), "properties": common })
}

pub async fn finish(
    configuration: Option<Configuration>,
    command: &'static str,
    elapsed: Duration,
    succeeded: bool,
    report: Option<Report>,
) {
    let Some(configuration) = configuration.as_ref().and_then(current) else {
        return;
    };
    let preferences = configuration.preferences.effective();
    let mut events = Vec::new();
    if preferences.usage {
        events.push(envelope(&configuration, "cli_command_completed", json!({ "command": command, "elapsed_ms": elapsed.as_millis().min(u128::from(u64::MAX)) as u64, "outcome": if succeeded { "succeeded" } else { "failed" } })));
    }
    if preferences.crashes
        && let Some(report) = report
    {
        events.push(envelope(&configuration, "$exception", json!({ "command": command, "$exception_level": "error", "$exception_list": [{ "type": report.kind, "value": "Widefleet CLI error", "stacktrace": { "type": "raw", "frames": report.frames.into_iter().rev().map(|frame| json!({ "platform": "custom", "lang": "rust", "function": "<unknown>", "filename": frame.filename, "lineno": frame.lineno, "colno": frame.colno, "in_app": true, "resolved": true })).collect::<Vec<_>>() } }] })));
    }
    let debug = std::env::var("WIDEFLEET_TELEMETRY_DEBUG").is_ok_and(|value| value == "1");
    let Ok(client) = reporting::client() else {
        return;
    };
    for event in events {
        let Some(latest) = current(&configuration) else {
            return;
        };
        let preferences = latest.preferences.effective();
        let allowed = if event["event"] == "$exception" {
            preferences.crashes
        } else {
            preferences.usage
        };
        if !allowed {
            continue;
        }
        if debug {
            eprintln!("[widefleet telemetry] {event}");
        } else {
            let _ = client
                .post(reporting::CAPTURE_URL)
                .json(&event)
                .send()
                .await;
        }
    }
}
