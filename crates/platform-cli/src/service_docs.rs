use crate::installation;
use platform_core::{Error, Result};
use std::{path::Path, process::Stdio};
use tokio::process::Command;

pub async fn extract(
    project: &Path,
    output: &Path,
    entrypoints: &[String],
) -> Result<serde_json::Value> {
    let helper = installation::load()?
        .directory
        .join("service-docs/extract.cjs");
    if !helper.is_file() {
        return Err(Error::invalid(
            "The CLI's API documentation helper is missing; reinstall the complete release archive"
                .into(),
        ));
    }
    let child = Command::new(std::env::var_os("WIDEFLEET_NODE").unwrap_or_else(|| "node".into()))
        .arg(helper)
        .arg(project)
        .arg(output.join("worker.js"))
        .args(entrypoints)
        .current_dir(project)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| Error::invalid(format!("Cannot run API documentation extraction ({error}); app deployment requires Node.js 22.18 or newer")))?;
    // Command::output() overrides stderr with a pipe, hiding author diagnostics.
    let result = child.wait_with_output().await?;
    if !result.status.success() {
        return Err(Error::invalid(
            "API documentation extraction failed; see diagnostics above".into(),
        ));
    }
    if result.stdout.len() > 1024 * 1024 {
        return Err(Error::invalid(
            "API documentation output is too large".into(),
        ));
    }
    Ok(serde_json::from_slice(&result.stdout)?)
}
