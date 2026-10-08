mod access;
mod artifact;
mod config;
mod docker;
#[cfg(test)]
mod execution_tests;
mod fleet;
mod migrations;
mod native;
mod reporting;
mod storage;
mod telemetry;

use bollard::Docker;
use clap::Parser;
use config::Configuration;
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::{Job, JobKind, RuntimePackages},
};
use reqwest::Method;
use serde_json::{Value, json as value};
use std::{
    fs::OpenOptions,
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

async fn event(api: &Api, configuration: &Configuration, job: &Job, message: &str) -> Result<()> {
    let _: Value = json(
        api.authenticated(
            Method::POST,
            &format!("/agent/jobs/{}/events", job.id),
            &configuration.token,
        )
        .json(&value!({ "leaseToken": job.lease_token, "message": message }))
        .send()
        .await?,
    )
    .await?;
    tracing::info!(app = ?job.app_id, job = %job.id, "{message}");
    Ok(())
}

async fn recover(docker: &Docker, configuration: &Configuration, job: &Job) -> Result<()> {
    if let Some(recovery) = fleet::recover(configuration, job).await? {
        if recovery.reload {
            let address =
                docker::ensure(docker, configuration, job, &["CELLD_OTEL=0".into()]).await?;
            docker::reload(docker, job, &address).await?;
        }
        for queue in recovery.wake {
            docker::wake_queue(docker, configuration, job, &queue).await?;
        }
        fleet::finish_recovery(configuration, job).await?;
    }
    Ok(())
}

async fn execute(
    api: &Api,
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
    cancelled: &AtomicBool,
) -> Result<Option<Value>> {
    native::verify_publisher(configuration).await?;
    let mut verified = configuration.clone();
    verified.runtime_image = docker::verify_native(docker, configuration, job).await?;
    let configuration = &verified;
    docker::verify_storage(docker, configuration, job).await?;
    recover(docker, configuration, job).await?;
    if matches!(job.kind, JobKind::Migrations) {
        return migrations::run(api, docker, configuration, job, cancelled)
            .await
            .map(|entries| Some(value!({ "migrations": entries })));
    }
    if matches!(job.kind, JobKind::Workflows) {
        let token = fleet::workflow_control(configuration, job)
            .await?
            .ok_or_else(|| {
                Error::invalid(
                    "Install an app runtime with Workflow support before managing workflows".into(),
                )
            })?;
        let request = job
            .workflow
            .clone()
            .ok_or_else(|| Error::invalid("Workflow job has no request".into()))?;
        docker::ensure(docker, configuration, job, &["CELLD_OTEL=0".into()]).await?;
        let result = docker::workflow_request(docker, job, &token, request).await?;
        return Ok(Some(value!({ "workflow": result })));
    }
    if matches!(job.kind, JobKind::Configure) && job.artifact_id.is_none() {
        return Ok(None);
    }
    let packages = if matches!(job.kind, JobKind::Delete) {
        event(
            api,
            configuration,
            job,
            "Removing this app and its owned files from the shared fleet",
        )
        .await?;
        if let Some(token) = fleet::workflow_control(configuration, job).await? {
            docker::ensure(docker, configuration, job, &["CELLD_OTEL=0".into()]).await?;
            loop {
                let result =
                    docker::workflow_request(docker, job, &token, value!({ "action": "purge" }))
                        .await?;
                if result.get("done").and_then(Value::as_bool) == Some(true) {
                    break;
                }
                if cancelled.load(Ordering::Relaxed) {
                    return Err(Error::invalid("App deletion interrupted".into()));
                }
            }
        }
        docker::remove(configuration, job).await?;
        let Some(packages) = fleet::detach(configuration, job).await? else {
            // An app can be deleted before any native fleet installation succeeds.
            return fleet::remove(configuration, job).await.map(|()| None);
        };
        packages
    } else {
        json::<RuntimePackages>(
            api.authenticated(
                Method::GET,
                &format!("/agent/jobs/{}/packages", job.id),
                &configuration.token,
            )
            .query(&[("leaseToken", job.lease_token)])
            .send()
            .await?,
        )
        .await?
    };
    event(
        api,
        configuration,
        job,
        "Verifying the independent runtime release and app artifact",
    )
    .await?;
    let temporary = tempfile::tempdir_in(&configuration.state)?;
    let artifact = if !matches!(job.kind, JobKind::Delete) && job.artifact_id.is_some() {
        Some(artifact::fetch(api, &configuration.token, job, temporary.path()).await?)
    } else {
        None
    };
    let telemetry = if artifact.is_none() {
        None
    } else {
        telemetry::destination(api, configuration, job).await?
    };
    let prepared = fleet::prepare(
        configuration,
        job,
        artifact,
        &packages,
        temporary.path(),
        telemetry,
    )
    .await?;
    let activation = async {
        if prepared.changed {
            event(
                api,
                configuration,
                job,
                "Publishing the shared fleet's native configuration",
            )
            .await?;
            fleet::publish(configuration, job, &packages, temporary.path()).await?;
        }
        let telemetry = vec!["CELLD_OTEL=0".into()];
        let address = docker::ensure(docker, configuration, job, &telemetry).await?;
        if prepared.changed {
            docker::reload(docker, job, &address).await?;
        }
        docker::check_runtime(
            docker,
            job,
            &address,
            &prepared.token,
            &packages.runtime.version,
        )
        .await?;
        for app in &prepared.probes {
            docker::check_candidate(docker, job, &address, &prepared.token, app).await?;
        }
        // Confirm access before selecting new app code. A failed proxy probe
        // must not leave a newly serving deployment recorded as the old one.
        if prepared.app.is_some() {
            docker::route(configuration, job).await?;
            access::verify(docker, configuration, job).await?;
        }
        Ok::<_, Error>(address)
    }
    .await;
    if let Err(error) = activation {
        recover(docker, configuration, job).await?;
        return Err(error);
    }
    fleet::commit(configuration, job, &prepared).await?;
    recover(docker, configuration, job).await?;
    if matches!(job.kind, JobKind::Delete) {
        fleet::remove(configuration, job).await?;
    }
    Ok(None)
}

async fn leased_execute(
    api: &Api,
    token: &str,
    job: &Job,
    cancelled: &AtomicBool,
    operation: impl Future<Output = Result<Option<Value>>>,
) -> Result<Option<Value>> {
    tokio::pin!(operation);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    let mut interruption = None;
    loop {
        tokio::select! {
            biased;
            result = &mut operation => return interruption.map_or(result, Err),
            renewed = async {
                heartbeat.tick().await;
                let _: Value = json(api.authenticated(Method::POST, &format!("/agent/jobs/{}/heartbeat", job.id), token)
                    .json(&value!({ "leaseToken": job.lease_token, "message": "Agent is processing the operation" })).send().await?).await?;
                Ok::<_, Error>(())
            } => {
                if let Err(error) = renewed {
                    if !matches!(job.kind, JobKind::Migrations | JobKind::Workflows) {
                        return Err(error);
                    }
                    // Dropping a Docker exec stream does not stop its command. Drain
                    // the current SQL file before reporting failure, and keep trying
                    // to renew the lease while waiting. Do not start another file.
                    cancelled.store(true, Ordering::Relaxed);
                    interruption.get_or_insert(error);
                }
            },
            signal = tokio::signal::ctrl_c(), if interruption.is_none() => {
                let error = signal.err().map(Error::from).unwrap_or_else(|| Error::invalid("Agent interrupted".into()));
                if !matches!(job.kind, JobKind::Migrations | JobKind::Workflows) {
                    return Err(error);
                }
                cancelled.store(true, Ordering::Relaxed);
                interruption = Some(error);
            },
        }
    }
}

async fn run(
    mut configuration: Configuration,
    reporting: Option<tokio::sync::mpsc::Sender<platform_core::reporting::Report>>,
) -> Result<()> {
    configuration.storage.resolve()?;
    tokio::fs::create_dir_all(&configuration.state).await?;
    configuration.state = configuration.state.canonicalize()?;
    if configuration
        .host_state
        .as_ref()
        .is_some_and(|path| !path.is_absolute())
    {
        return Err(Error::invalid(
            "PLATFORM_AGENT_HOST_STATE must be absolute".into(),
        ));
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(configuration.state.join("agent.lock"))?;
    lock.try_lock().map_err(|error| {
        Error::invalid(format!(
            "Another agent is using this state directory: {error}"
        ))
    })?;
    let api = Api::new(&configuration.url)?;
    let docker = Docker::connect_with_local_defaults()
        .map_err(|error| Error::invalid(format!("Could not connect to Docker: {error}")))?;
    docker
        .ping()
        .await
        .map_err(|error| Error::invalid(format!("Docker is unavailable: {error}")))?;
    loop {
        let claimed = async {
            json::<Option<Job>>(
                api.authenticated(Method::POST, "/agent/jobs/claim", &configuration.token)
                    .json(&value!({ "accessRules": 2 }))
                    .send()
                    .await?,
            )
            .await
        }
        .await;
        match claimed {
            Ok(Some(job)) => {
                tracing::info!(app = ?job.app_id, job = %job.id, attempt = job.attempt, "Job claimed");
                let cancelled = AtomicBool::new(false);
                let result = leased_execute(
                    &api,
                    &configuration.token,
                    &job,
                    &cancelled,
                    execute(&api, &docker, &configuration, &job, &cancelled),
                )
                .await;
                if let (Some(sender), Err(error)) = (&reporting, &result) {
                    let _ = sender.try_send(platform_core::reporting::error(error));
                }
                let (outcome, message) = match &result {
                    Ok(_) => ("succeeded", "Operation completed".into()),
                    Err(error) => {
                        tracing::error!(job = %job.id, %error, "Job failed");
                        (
                            "failed",
                            error.to_string().chars().take(4000).collect::<String>(),
                        )
                    }
                };
                let mut completion = value!({ "leaseToken": job.lease_token, "outcome": outcome, "message": message });
                if result.is_ok()
                    && job.deployment_id.is_some()
                    && matches!(job.kind, JobKind::Deploy | JobKind::Configure)
                    && let Some(access) = &job.access
                {
                    completion["accessRevision"] = value!(access.revision);
                }
                if let Ok(Some(fields)) = &result
                    && let Some(fields) = fields.as_object()
                {
                    for (name, value) in fields {
                        completion[name] = value.clone();
                    }
                }
                for attempt in 0..3 {
                    let acknowledged = async {
                        json::<Value>(
                            api.authenticated(
                                Method::POST,
                                &format!("/agent/jobs/{}/complete", job.id),
                                &configuration.token,
                            )
                            .json(&completion)
                            .send()
                            .await?,
                        )
                        .await
                    }
                    .await;
                    match acknowledged {
                        Ok(_) => break,
                        Err(error) if attempt == 2 => {
                            tracing::error!(job = %job.id, %error, "Completion was not acknowledged; the lease will be retried")
                        }
                        Err(_) => tokio::time::sleep(Duration::from_secs(2)).await,
                    }
                }
                if configuration.once {
                    return result.map(|_| ());
                }
            }
            Ok(None) if configuration.once => return Ok(()),
            Ok(None) => {}
            Err(error) if configuration.once => return Err(error),
            Err(error) => tracing::warn!(%error, "Could not poll management API"),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(configuration.poll_seconds.max(1))) => {},
            signal = tokio::signal::ctrl_c() => { signal?; return Ok(()); }
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let configuration = Configuration::parse();
    let reporting = reporting::start(&configuration);
    let capture = reporting
        .as_ref()
        .map(|_| platform_core::reporting::PanicCapture::install());
    let sender = reporting.as_ref().map(|(sender, _)| sender.clone());
    let joined = tokio::spawn(run(configuration, sender)).await;
    let panicked = joined.as_ref().is_err_and(tokio::task::JoinError::is_panic);
    let result = joined.unwrap_or_else(|_| Err(Error::invalid("Widefleet agent panicked".into())));
    if let Some((sender, task)) = reporting {
        let panic = capture.and_then(|capture| capture.take());
        if let Some(report) =
            panic.or_else(|| result.as_ref().err().map(platform_core::reporting::error))
        {
            let _ = sender.try_send(report);
        }
        drop(sender);
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }
    if let Err(error) = result {
        tracing::error!(%error, "Agent stopped");
        std::process::exit(if panicked { 101 } else { 1 });
    }
}
