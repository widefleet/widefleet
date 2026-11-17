use platform_core::{
    Error, Result, asset_hash,
    http::{Api, json},
    model::{Artifact, Job, Module, ModuleType},
    sha256,
};
use reqwest::Method;
use std::{
    collections::BTreeSet,
    path::{Component, Path},
};
use tokio::io::AsyncWriteExt;

pub async fn fetch(api: &Api, token: &str, job: &Job, directory: &Path) -> Result<Artifact> {
    let artifact: Artifact = json(
        api.authenticated(
            Method::GET,
            &format!("/agent/jobs/{}/artifact", job.id),
            token,
        )
        .query(&[("leaseToken", job.lease_token)])
        .send()
        .await?,
    )
    .await?;
    if Some(artifact.app_id) != job.app_id || Some(artifact.id) != job.artifact_id {
        return Err(Error::invalid(
            "Artifact does not belong to this deployment job".into(),
        ));
    }
    fetch_modules(
        api,
        token,
        job,
        &artifact.modules,
        &artifact.metadata.worker.main_module,
        directory,
    )
    .await?;
    let public = directory.join("public");
    tokio::fs::create_dir_all(&public).await?;
    for (name, entry) in &artifact.manifest {
        let relative = name
            .strip_prefix('/')
            .ok_or_else(|| Error::invalid("Asset must have an absolute URL path".into()))?;
        if relative.is_empty()
            || relative.contains('\\')
            || !Path::new(relative)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(Error::invalid("Unsafe asset path".into()));
        }
        let bytes = download(
            api,
            token,
            job,
            "assets",
            &entry.hash,
            entry.size,
            25 * 1024 * 1024,
        )
        .await?;
        if asset_hash(name, &bytes) != entry.hash {
            return Err(Error::invalid("Asset checksum mismatch".into()));
        }
        let destination = public.join(relative);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .await?;
        file.write_all(&bytes).await?;
    }
    Ok(artifact)
}

pub(crate) async fn fetch_modules(
    api: &Api,
    token: &str,
    job: &Job,
    modules: &[Module],
    main: &str,
    directory: &Path,
) -> Result<()> {
    tokio::fs::create_dir_all(directory).await?;
    let mut names = BTreeSet::new();
    for module in modules {
        // Source maps remain private deployment artifacts, never runtime modules or assets.
        if matches!(module.kind, ModuleType::Sourcemap) {
            continue;
        }
        if Path::new(&module.name).components().count() != 1
            || !Path::new(&module.name)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || !names.insert(&module.name)
        {
            return Err(Error::invalid(
                "Unsafe or duplicate worker module name".into(),
            ));
        }
        let bytes = download_module(api, token, job, &module.sha256, module.size).await?;
        if sha256(&bytes) != module.sha256 {
            return Err(Error::invalid("Worker module checksum mismatch".into()));
        }
        tokio::fs::write(directory.join(&module.name), bytes).await?;
    }
    if !modules
        .iter()
        .any(|module| module.name == main && matches!(module.kind, ModuleType::Esm))
    {
        return Err(Error::invalid("Main worker module is missing".into()));
    }
    Ok(())
}

async fn download_module(
    api: &Api,
    token: &str,
    job: &Job,
    hash: &str,
    expected: u64,
) -> Result<Vec<u8>> {
    download_scoped(
        api,
        token,
        job,
        Download {
            kind: "modules",
            hash,
            expected,
            limit: 20 * 1024 * 1024,
        },
    )
    .await
}

pub(crate) async fn download(
    api: &Api,
    token: &str,
    job: &Job,
    kind: &str,
    hash: &str,
    expected: u64,
    limit: u64,
) -> Result<Vec<u8>> {
    download_scoped(
        api,
        token,
        job,
        Download {
            kind,
            hash,
            expected,
            limit,
        },
    )
    .await
}

struct Download<'a> {
    kind: &'a str,
    hash: &'a str,
    expected: u64,
    limit: u64,
}

async fn download_scoped(
    api: &Api,
    token: &str,
    job: &Job,
    download: Download<'_>,
) -> Result<Vec<u8>> {
    let Download {
        kind,
        hash,
        expected,
        limit,
    } = download;
    if expected > limit || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::invalid("Invalid artifact object metadata".into()));
    }
    let mut response = api
        .authenticated(
            Method::GET,
            &format!("/agent/jobs/{}/{kind}/{hash}", job.id),
            token,
        )
        .query(&[("leaseToken", job.lease_token)])
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() as u64 + chunk.len() as u64 > expected {
            return Err(Error::invalid(
                "Artifact download exceeds its declared size".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != expected {
        return Err(Error::invalid("Artifact download is incomplete".into()));
    }
    Ok(bytes)
}
