use platform_core::{Error, Result};
use serde_json::Value;
use std::path::Path;

pub fn extract(project: &Path, output: &Path, entrypoints: &[String]) -> Result<Value> {
    if entrypoints.is_empty() {
        return Ok(platform_service_docs::empty());
    }
    let map = std::fs::read_to_string(output.join("worker.js.map"))?;
    platform_service_docs::extract(
        tsrs_vfs::osvfs::fs(),
        &project.to_string_lossy(),
        &output.join("worker.js").to_string_lossy(),
        &map,
        None,
        entrypoints,
    )
    .map_err(|error| Error::invalid(error.0))
}
