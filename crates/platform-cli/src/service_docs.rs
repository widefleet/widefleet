use platform_core::{Error, Result};
use serde_json::Value;
use std::path::Path;

pub async fn extract(project: &Path, output: &Path, entrypoints: &[String]) -> Result<Value> {
    // Keep file reads and type analysis off the executor so it can observe idle
    // HTTP connections closing between source lookup and deployment upload.
    let project = project.to_owned();
    let output = output.to_owned();
    let entrypoints = entrypoints.to_owned();
    tokio::task::spawn_blocking(move || extract_blocking(&project, &output, &entrypoints))
        .await
        .unwrap_or_else(|error| std::panic::resume_unwind(error.into_panic()))
}

fn extract_blocking(project: &Path, output: &Path, entrypoints: &[String]) -> Result<Value> {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{io::Write, time::Duration};

    #[tokio::test(flavor = "current_thread")]
    async fn source_map_reads_leave_the_executor_responsive()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let map = directory.path().join("worker.js.map");
        // rustix does not expose mkfifoat on macOS; the POSIX utility works on
        // both supported Unix hosts without excluding this regression there.
        let status = tokio::process::Command::new("mkfifo")
            .args(["-m", "600"])
            .arg(&map)
            .status()
            .await?;
        assert!(status.success(), "could not create the source map FIFO");
        let (opened, reading) = tokio::sync::oneshot::channel();
        let (resume, resumed) = std::sync::mpsc::channel();
        // The writer releases the read only after the async executor responds.
        // Its timeout also lets the unfixed implementation fail instead of hang.
        let writer = std::thread::spawn(move || -> std::io::Result<bool> {
            let mut file = std::fs::OpenOptions::new().write(true).open(map)?;
            let _ = opened.send(());
            let responsive = resumed.recv_timeout(Duration::from_secs(5)).is_ok();
            file.write_all(b"invalid source map")?;
            Ok(responsive)
        });
        let project = directory.path().to_owned();
        let analysis =
            tokio::spawn(async move { extract(&project, &project, &["default".to_owned()]).await });
        tokio::time::timeout(Duration::from_secs(10), reading).await??;
        let _ = resume.send(());
        let responsive = writer
            .join()
            .map_err(|_| std::io::Error::other("source map writer panicked"))??;
        assert!(responsive, "source map reads blocked the async executor");
        assert!(analysis.await?.is_err());
        Ok(())
    }
}
