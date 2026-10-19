use crate::auth;
use clap::Args;
use platform_core::{
    Error, Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{IsTerminal, Write},
    path::PathBuf,
    time::Duration,
};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    /// App name or ID; otherwise use the current project without creating an app.
    pub app: Option<String>,
    /// Read shared connector logs (administrator access required).
    #[arg(long, conflicts_with_all = ["app", "deployment"])]
    connector: Option<String>,
    /// Restrict connector logs to one published version.
    #[arg(long, requires = "connector")]
    version: Option<Uuid>,
    #[arg(long, default_value = "wrangler.jsonc")]
    config: PathBuf,
    #[arg(long, default_value = "1h")]
    since: String,
    #[arg(long, conflicts_with = "follow")]
    until: Option<String>,
    /// Minimum severity.
    #[arg(long, value_parser = ["debug", "info", "warn", "error"])]
    level: Option<String>,
    #[arg(long, value_parser = ["server", "browser", "runtime"])]
    source: Option<String>,
    #[arg(long)]
    deployment: Option<Uuid>,
    #[arg(long)]
    request_id: Option<String>,
    #[arg(long)]
    trace_id: Option<String>,
    /// Case-insensitive substring in the original log body.
    #[arg(long)]
    query: Option<String>,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=500))]
    limit: u16,
    /// Print recent history, then poll for newly received records until Ctrl-C.
    #[arg(long)]
    follow: bool,
    /// One JSON object per line (also the default when stdout is redirected).
    #[arg(long)]
    json: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    generated_file: String,
    generated_line: u32,
    generated_column: u32,
    file: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    name: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Log {
    id: String,
    timestamp: String,
    received_at: String,
    level: String,
    source: String,
    kind: String,
    message: String,
    stack: Option<String>,
    frames: Vec<Frame>,
    build_id: Option<String>,
    deployment_id: Option<Uuid>,
    connector_version: Option<Uuid>,
    request_id: Option<String>,
    trace_id: Option<String>,
    span_id: Option<String>,
    route: Option<String>,
    status: Option<u16>,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    entries: Vec<Log>,
    next_cursor: Option<String>,
    received_through: String,
    since: String,
}

// A follow window can arrive in either backend's native pagination order.
// Flush only after its final page, ordered by receipt time across all pages.
#[derive(Default)]
struct FollowBuffer {
    entries: Vec<Log>,
    bytes: usize,
}

impl FollowBuffer {
    fn push(&mut self, entry: Log) -> Result<()> {
        self.bytes += serde_json::to_vec(&entry)?.len();
        if self.bytes > 32 * 1024 * 1024 || self.entries.len() >= 100_000 {
            return Err(Error::invalid("Follow exceeded its ordering buffer; narrow the filters and restart with --since to recover history".into()));
        }
        self.entries.push(entry);
        Ok(())
    }

    fn drain(&mut self) -> Result<Vec<Log>> {
        let mut keyed = std::mem::take(&mut self.entries)
            .into_iter()
            .map(|entry| Ok((micros(&entry.received_at)?, entry)))
            .collect::<Result<Vec<_>>>()?;
        keyed.sort_by(|(time_a, a), (time_b, b)| time_a.cmp(time_b).then(a.id.cmp(&b.id)));
        self.bytes = 0;
        Ok(keyed.into_iter().map(|(_, entry)| entry).collect())
    }
}

fn safe_text(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control() || *ch == '\n' || *ch == '\t')
        .collect()
}

fn output(log: &Log, json: bool) -> Result<()> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if json {
        writeln!(out, "{}", serde_json::to_string(log)?)?;
    } else {
        writeln!(
            out,
            "{} {:5} {:7} {}",
            safe_text(&log.timestamp),
            safe_text(&log.level),
            safe_text(&log.source),
            safe_text(&log.message)
        )?;
        if let Some(stack) = &log.stack {
            writeln!(out, "{}", safe_text(stack))?;
        }
        for frame in &log.frames {
            if let (Some(file), Some(line), Some(column)) = (&frame.file, frame.line, frame.column)
            {
                writeln!(out, "  → {}:{line}:{column}", safe_text(file))?;
            }
        }
    }
    out.flush()?;
    Ok(())
}

fn micros(value: &str) -> Result<u64> {
    value
        .parse()
        .map_err(|_| Error::invalid("The API returned an invalid ingestion watermark".into()))
}

async fn poll(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let path = match &options.connector {
        Some(name) => format!("/connectors/{}/logs", crate::connector::segment(name)?),
        None => {
            let app =
                crate::apps::resolve(api, credentials, options.app.as_deref(), &options.config)
                    .await?;
            format!("/apps/{app}/logs")
        }
    };
    let json_output = options.json || !std::io::stdout().is_terminal();
    let mut parameters = vec![
        ("since", options.since.clone()),
        ("limit", options.limit.to_string()),
    ];
    for (key, value) in [
        ("until", options.until.as_ref()),
        ("level", options.level.as_ref()),
        ("source", options.source.as_ref()),
        ("requestId", options.request_id.as_ref()),
        ("traceId", options.trace_id.as_ref()),
        ("query", options.query.as_ref()),
    ] {
        if let Some(value) = value {
            parameters.push((key, value.clone()));
        }
    }
    if let Some(deployment) = options.deployment {
        parameters.push(("deploymentId", deployment.to_string()));
    }
    if let Some(version) = options.version {
        parameters.push(("version", version.to_string()));
    }
    let mut first = true;
    let mut cursor: Option<String> = None;
    let mut after: Option<u64> = None;
    let mut seen = HashMap::<String, u64>::new();
    let mut pending = FollowBuffer::default();
    loop {
        let token = auth::access_token(api, credentials).await?;
        let mut request = api
            .authenticated(Method::GET, &path, &token)
            .query(&parameters);
        if let Some(after) = after {
            request = request.query(&[("receivedAfter", after.to_string())]);
        }
        if let Some(cursor) = &cursor {
            request = request.query(&[("cursor", cursor)]);
        }
        let mut page: Page = json(request.send().await?).await?;
        if first {
            page.entries.reverse();
        }
        for entry in page.entries {
            let received = micros(&entry.received_at)?;
            if seen.insert(entry.id.clone(), received).is_none() {
                if first {
                    output(&entry, json_output)?;
                } else {
                    pending.push(entry)?;
                }
            }
        }
        if !options.follow {
            return Ok(());
        }
        if seen.len() > 100_000 {
            return Err(Error::invalid("Follow exceeded its overlap buffer; narrow the filters and restart with --since to recover history".into()));
        }
        if first {
            parameters[0].1 = page.since;
            first = false;
            eprintln!("Following runtime logs; press Ctrl-C to stop.");
        } else if let Some(next) = page.next_cursor {
            cursor = Some(next);
            continue;
        }
        for entry in pending.drain()? {
            output(&entry, json_output)?;
        }
        // Re-read a bounded ingestion overlap to cover concurrent writes. This
        // deliberately follows receive time, so delayed exports remain visible.
        let lower = micros(&page.received_through)?.saturating_sub(60_000_000);
        seen.retain(|_, received| *received >= lower);
        after = Some(lower);
        cursor = None;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    tokio::select! {
        result = poll(api, credentials, options) => match result {
            Err(error) if matches!(error.kind(), platform_core::ErrorKind::Io(cause) if cause.kind() == std::io::ErrorKind::BrokenPipe) => Ok(()),
            result => result,
        },
        signal = tokio::signal::ctrl_c() => { signal?; Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn terminal_output_removes_control_sequences_but_keeps_stack_lines() {
        assert_eq!(
            super::safe_text("message\u{1b}[2J\n\tframe"),
            "message[2J\n\tframe"
        );
    }
    #[test]
    fn follow_orders_records_across_backend_pages_and_breaks_timestamp_ties()
    -> platform_core::Result<()> {
        let mut buffer = super::FollowBuffer::default();
        for (id, received) in [("new", "10000"), ("z", "900"), ("a", "900"), ("old", "80")] {
            let entry: super::Log = serde_json::from_value(serde_json::json!({
                "id": id, "receivedAt": received, "timestamp": "2026-10-15T00:00:00Z",
                "level":"info", "source":"server", "kind":"log", "message":id,
                "body":id, "frames":[]
            }))?;
            buffer.push(entry)?;
        }
        let entries = buffer.drain()?;
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["old", "a", "z", "new"]
        );
        assert!(buffer.drain()?.is_empty());
        Ok(())
    }
}
