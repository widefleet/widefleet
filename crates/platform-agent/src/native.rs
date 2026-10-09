use crate::config::Configuration;
use platform_core::{Error, Result};
use std::time::Duration;
use tokio::process::Command;

pub const VERSION: &str = "0.6.2";

pub fn verify(output: &[u8], source: &str) -> Result<()> {
    let actual = String::from_utf8_lossy(output);
    if actual.trim() != format!("celld {VERSION}") {
        return Err(Error::invalid(format!(
            "{source} requires celld {VERSION}, but reported {:?}. Use the matching publisher binary and recreate incompatible fleet containers with the matching runtime image",
            actual.trim()
        )));
    }
    Ok(())
}

pub async fn verify_publisher(configuration: &Configuration) -> Result<()> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        Command::new(&configuration.celld)
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| Error::invalid("Publisher celld version check timed out".into()))??;
    if !output.status.success() {
        return Err(Error::invalid(format!(
            "Publisher celld version check failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    verify(&output.stdout, "Publisher binary")
}
