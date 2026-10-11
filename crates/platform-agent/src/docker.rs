use crate::config::Configuration;
use bollard::{
    Docker,
    container::LogOutput,
    exec::StartExecResults,
    models::{
        ContainerCreateBody, ContainerInspectResponse, EndpointIpamConfig, EndpointSettings,
        ExecConfig, HostConfig, HostConfigLogConfig, NetworkConnectRequest, NetworkCreateRequest,
        NetworkingConfig, RestartPolicy, RestartPolicyNameEnum,
    },
    query_parameters::{
        AttachContainerOptionsBuilder, CreateContainerOptionsBuilder, InspectContainerOptions,
        InspectNetworkOptions, RemoveContainerOptionsBuilder, RenameContainerOptions,
        StartContainerOptions, StopContainerOptionsBuilder, WaitContainerOptions,
    },
};
use futures_util::StreamExt;
use platform_core::{
    Error, Result,
    model::{Job, PublishedApp},
};
use serde_json::{Value, json as value};
use std::{
    collections::{HashMap, HashSet},
    net::Ipv4Addr,
    time::Duration,
};

fn docker_error(error: bollard::errors::Error) -> Error {
    Error::invalid(format!("Docker operation failed: {error}"))
}
fn missing(error: &bollard::errors::Error) -> bool {
    matches!(
        error,
        bollard::errors::Error::DockerResponseServerError {
            status_code: 404,
            ..
        }
    )
}
pub fn name(job: &Job) -> String {
    format!("platform-fleet-{}", job.fleet_id)
}
fn labels(job: &Job) -> HashMap<String, String> {
    HashMap::from([("app-platform.fleet-id".into(), job.fleet_id.to_string())])
}

async fn owned_container(
    docker: &Docker,
    job: &Job,
    container: &str,
) -> Result<Option<ContainerInspectResponse>> {
    match docker
        .inspect_container(container, None::<InspectContainerOptions>)
        .await
    {
        Ok(record) => {
            if record
                .config
                .as_ref()
                .and_then(|config| config.labels.as_ref())
                .and_then(|labels| labels.get("app-platform.fleet-id"))
                != Some(&job.fleet_id.to_string())
            {
                return Err(Error::invalid(
                    "Refusing to replace a container not owned by this fleet".into(),
                ));
            }
            Ok(Some(record))
        }
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(docker_error(error)),
    }
}

async fn discard_container(docker: &Docker, container: &str) -> Result<()> {
    match docker
        .remove_container(
            container,
            Some(
                RemoveContainerOptionsBuilder::default()
                    .force(true)
                    .v(false)
                    .build(),
            ),
        )
        .await
    {
        Ok(()) => Ok(()),
        Err(error) if missing(&error) => Ok(()),
        Err(error) => Err(docker_error(error)),
    }
}

async fn restore_runtime(
    docker: &Docker,
    job: &Job,
    previous: &str,
    replacement: Option<&str>,
) -> Result<()> {
    if let Some(replacement) = replacement {
        discard_container(docker, replacement).await?;
    }
    let record = docker
        .inspect_container(previous, None::<InspectContainerOptions>)
        .await
        .map_err(docker_error)?;
    let name = name(job);
    if record.name.as_deref() != Some(&format!("/{name}")) {
        docker
            .rename_container(previous, RenameContainerOptions { name })
            .await
            .map_err(docker_error)?;
    }
    docker
        .start_container(previous, None::<StartContainerOptions>)
        .await
        .map_err(docker_error)?;
    Ok(())
}

// A retained previous container also makes an interrupted swap recoverable on
// the next job. Never run two runtimes against the same state directory.
async fn recover_replacement(docker: &Docker, job: &Job, address: &str) -> Result<()> {
    let name = name(job);
    let previous = format!("{name}-previous");
    if let Some(previous_container) = owned_container(docker, job, &previous).await? {
        let replacement = owned_container(docker, job, &name).await?;
        let recovered = if replacement.is_some() {
            // Activation may already have succeeded before the agent stopped.
            // Finish the cutover if the replacement can serve the published
            // artifact; the old container is only a fallback, not a failure flag.
            let resumed = async {
                if previous_container.state.and_then(|state| state.running) == Some(true) {
                    docker
                        .stop_container(
                            &previous,
                            Some(StopContainerOptionsBuilder::default().t(30).build()),
                        )
                        .await
                        .map_err(docker_error)?;
                }
                docker
                    .start_container(&name, None::<StartContainerOptions>)
                    .await
                    .map_err(docker_error)?;
                activate(docker, job, address).await
            }
            .await;
            if resumed.is_ok() {
                // Cleanup failure must not roll back a successfully activated runtime.
                docker
                    .remove_container(
                        &previous,
                        Some(RemoveContainerOptionsBuilder::default().v(false).build()),
                    )
                    .await
                    .map_err(docker_error)?;
                true
            } else {
                false
            }
        } else {
            false
        };
        if !recovered {
            restore_runtime(
                docker,
                job,
                &previous,
                replacement.as_ref().and_then(|record| record.id.as_deref()),
            )
            .await?;
        }
    }
    let pending = format!("{name}-replacement");
    if owned_container(docker, job, &pending).await?.is_some() {
        discard_container(docker, &pending).await?;
    }
    Ok(())
}

pub async fn verify_native(
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
) -> Result<String> {
    let selected = docker
        .inspect_image(&configuration.runtime_image)
        .await
        .map_err(docker_error)?
        .id
        .ok_or_else(|| Error::invalid("Runtime image has no immutable ID".into()))?;
    let mut images = vec![(selected.clone(), "Configured runtime image".to_owned())];
    for container in [name(job), format!("{}-previous", name(job))] {
        if let Some(record) = owned_container(docker, job, &container).await? {
            let image = record
                .image
                .ok_or_else(|| Error::invalid("Fleet container has no image ID".into()))?;
            images.push((image, format!("Fleet container {container}")));
        }
    }
    // Probe immutable image bytes without starting a fleet or mounting its data.
    // This also checks stopped containers and either side of interrupted swaps.
    let probe = format!("{}-version-check", name(job));
    if owned_container(docker, job, &probe).await?.is_some() {
        discard_container(docker, &probe).await?;
    }
    let mut checked = HashSet::new();
    for (image, source) in images {
        if !checked.insert(image.clone()) {
            continue;
        }
        let id = docker
            .create_container(
                Some(
                    CreateContainerOptionsBuilder::default()
                        .name(&probe)
                        .build(),
                ),
                ContainerCreateBody {
                    image: Some(image),
                    entrypoint: Some(vec!["/usr/local/bin/celld".into()]),
                    cmd: Some(vec!["--version".into()]),
                    labels: Some(labels(job)),
                    host_config: Some(HostConfig {
                        network_mode: Some("none".into()),
                        readonly_rootfs: Some(true),
                        cap_drop: Some(vec!["ALL".into()]),
                        log_config: Some(HostConfigLogConfig {
                            typ: Some("none".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .map_err(docker_error)?
            .id;
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            // Attach before starting the short-lived process. Its output must
            // not depend on the host's log driver or stored-log availability.
            let mut output = docker
                .attach_container(
                    &id,
                    Some(
                        AttachContainerOptionsBuilder::default()
                            .stdout(true)
                            .stderr(true)
                            .stream(true)
                            .build(),
                    ),
                )
                .await
                .map_err(docker_error)?
                .output;
            docker
                .start_container(&id, None::<StartContainerOptions>)
                .await
                .map_err(docker_error)?;
            let mut bytes = Vec::new();
            while let Some(message) = output.next().await {
                bytes.extend_from_slice(message.map_err(docker_error)?.as_ref());
            }
            docker
                .wait_container(&id, None::<WaitContainerOptions>)
                .next()
                .await
                .ok_or_else(|| {
                    Error::invalid("Native version probe returned no exit status".into())
                })?
                .map_err(docker_error)?;
            crate::native::verify(&bytes, &source)
        })
        .await
        .map_err(|_| Error::invalid(format!("{source} celld version check timed out")));
        // The fixed, owned probe name also permits cleanup after agent interruption.
        discard_container(docker, &id).await?;
        result??;
    }
    // Container creation uses the checked digest even if its tag is moved later.
    Ok(selected)
}

pub async fn verify_storage(
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
) -> Result<()> {
    let container = match docker
        .inspect_container(&name(job), None::<InspectContainerOptions>)
        .await
    {
        Ok(container) => container,
        Err(error) if missing(&error) => return Ok(()),
        Err(error) => return Err(docker_error(error)),
    };
    let config = container
        .config
        .ok_or_else(|| Error::invalid("App container has no configuration".into()))?;
    if config
        .labels
        .as_ref()
        .and_then(|labels| labels.get("app-platform.fleet-id"))
        != Some(&job.fleet_id.to_string())
    {
        return Err(Error::invalid(
            "Refusing to use a container not owned by this fleet".into(),
        ));
    }
    configuration.storage.resolve()?.verify_runtime(
        job.fleet_id,
        &config.cmd.unwrap_or_default(),
        &config.env.unwrap_or_default(),
    )
}

pub async fn ensure(
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
    telemetry: &[String],
) -> Result<String> {
    let name = name(job);
    let network = match docker
        .inspect_network(&name, None::<InspectNetworkOptions>)
        .await
    {
        Ok(network) => network,
        Err(error) if missing(&error) => {
            docker
                .create_network(NetworkCreateRequest {
                    name: name.clone(),
                    driver: Some("bridge".into()),
                    labels: Some(labels(job)),
                    ..Default::default()
                })
                .await
                .map_err(docker_error)?;
            docker
                .inspect_network(&name, None::<InspectNetworkOptions>)
                .await
                .map_err(docker_error)?
        }
        Err(error) => return Err(docker_error(error)),
    };
    if network
        .labels
        .as_ref()
        .and_then(|labels| labels.get("app-platform.fleet-id"))
        != Some(&job.fleet_id.to_string())
    {
        return Err(Error::invalid(
            "Refusing to use a network not owned by this fleet".into(),
        ));
    }
    let gateway = network
        .ipam
        .and_then(|ipam| ipam.config)
        .and_then(|config| config.into_iter().find_map(|item| item.gateway))
        .ok_or_else(|| Error::invalid("App network has no IPv4 gateway".into()))?;
    let gateway: Ipv4Addr = gateway
        .parse()
        .map_err(|error| Error::invalid(format!("Invalid Docker network gateway: {error}")))?;
    let address = Ipv4Addr::from(
        u32::from(gateway)
            .checked_add(1)
            .ok_or_else(|| Error::invalid("Invalid Docker network range".into()))?,
    )
    .to_string();
    recover_replacement(docker, job, &address).await?;
    let existing = owned_container(docker, job, &name).await?;
    let replacement = existing.as_ref().filter(|container| {
        crate::telemetry::changed(
            container
                .config
                .as_ref()
                .and_then(|config| config.env.as_deref())
                .unwrap_or_default(),
            telemetry,
        )
    });
    let created = if existing.is_none() || replacement.is_some() {
        let local_state = configuration.state.join(job.fleet_id.to_string());
        tokio::fs::create_dir_all(&local_state).await?;
        let host_state = configuration
            .host_state
            .as_ref()
            .unwrap_or(&configuration.state)
            .join(job.fleet_id.to_string());
        let storage = configuration.storage.resolve()?;
        let mut environment: Vec<String> = storage
            .environment(true)
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        environment.extend([
            "CELLD_WATCH=/state/node".into(),
            "CELLD_ASSET_CACHE_DIR=/state/assets".into(),
            "CELLD_SHUTDOWN_TOTAL_MS=10000".into(),
        ]);
        environment.extend_from_slice(telemetry);
        let mut arguments = storage.arguments(job.fleet_id, true);
        arguments.extend([
            "--listen".into(),
            "0.0.0.0:8080".into(),
            "--internal-listen".into(),
            format!("{address}:8081"),
            "--advertise".into(),
            format!("{address}:8081"),
            "--trust-forwarded-headers".into(),
        ]);
        let options = ContainerCreateBody {
            image: Some(configuration.runtime_image.clone()),
            labels: Some(labels(job)),
            env: Some(environment),
            cmd: Some(arguments),
            stop_timeout: Some(30),
            host_config: Some(HostConfig {
                binds: Some(vec![format!("{}:/state", host_state.display())]),
                mounts: Some(storage.credential_mount().into_iter().collect()),
                network_mode: Some(name.clone()),
                readonly_rootfs: Some(true),
                cap_drop: Some(vec!["ALL".into()]),
                security_opt: Some(vec!["no-new-privileges:true".into()]),
                pids_limit: Some(256),
                tmpfs: Some(HashMap::from([(
                    "/tmp".into(),
                    "rw,nosuid,nodev,noexec,size=64m".into(),
                )])),
                restart_policy: Some(RestartPolicy {
                    name: Some(RestartPolicyNameEnum::UNLESS_STOPPED),
                    maximum_retry_count: None,
                }),
                ..Default::default()
            }),
            networking_config: Some(NetworkingConfig {
                endpoints_config: Some(HashMap::from([(
                    name.clone(),
                    EndpointSettings {
                        ipam_config: Some(EndpointIpamConfig {
                            ipv4_address: Some(address.clone()),
                            ..Default::default()
                        }),
                        aliases: Some(vec![name.clone()]),
                        ..Default::default()
                    },
                )])),
            }),
            ..Default::default()
        };
        // Prepare and create the replacement while the current runtime still
        // serves traffic. Missing images or invalid configuration cannot stop it.
        // Docker allocates the fixed address on start, after the old runtime is
        // stopped, not when this stopped candidate is created.
        let create_name = if replacement.is_some() {
            format!("{name}-replacement")
        } else {
            name.clone()
        };
        Some(
            docker
                .create_container(
                    Some(
                        CreateContainerOptionsBuilder::default()
                            .name(&create_name)
                            .build(),
                    ),
                    options,
                )
                .await
                .map_err(docker_error)?
                .id,
        )
    } else {
        None
    };
    for (index, trusted) in configuration.trusted_containers.iter().enumerate() {
        let container = docker
            .inspect_container(trusted, None::<InspectContainerOptions>)
            .await
            .map_err(docker_error)?;
        let connected = container
            .network_settings
            .and_then(|settings| settings.networks)
            .is_some_and(|networks| networks.contains_key(&name));
        if !connected {
            docker
                .connect_network(
                    &name,
                    NetworkConnectRequest {
                        container: trusted.clone(),
                        endpoint_config: Some(EndpointSettings {
                            ipam_config: Some(EndpointIpamConfig {
                                ipv4_address: Some(
                                    Ipv4Addr::from(
                                        u32::from(gateway)
                                            .checked_add(
                                                u32::try_from(index).map_err(|error| {
                                                    Error::invalid(error.to_string())
                                                })? + 2,
                                            )
                                            .ok_or_else(|| {
                                                Error::invalid(
                                                    "Docker network address overflow".into(),
                                                )
                                            })?,
                                    )
                                    .to_string(),
                                ),
                                ..Default::default()
                            }),
                            ..Default::default()
                        }),
                    },
                )
                .await
                .map_err(docker_error)?;
        }
    }
    if let Some(previous) = replacement {
        let previous = previous
            .id
            .as_deref()
            .ok_or_else(|| Error::invalid("App container has no ID".into()))?;
        let next = created
            .as_deref()
            .ok_or_else(|| Error::invalid("Missing replacement container".into()))?;
        tracing::info!(fleet = %job.fleet_id, "Replacing fleet runtime to apply configuration; persistent state is retained");
        let swapped = async {
            docker
                .rename_container(
                    previous,
                    RenameContainerOptions {
                        name: format!("{name}-previous"),
                    },
                )
                .await
                .map_err(docker_error)?;
            docker
                .stop_container(
                    previous,
                    Some(StopContainerOptionsBuilder::default().t(30).build()),
                )
                .await
                .map_err(docker_error)?;
            docker
                .rename_container(next, RenameContainerOptions { name: name.clone() })
                .await
                .map_err(docker_error)?;
            docker
                .start_container(next, None::<StartContainerOptions>)
                .await
                .map_err(docker_error)?;
            activate(docker, job, &address).await
        }
        .await;
        if let Err(cause) = swapped {
            if let Err(recovery) = restore_runtime(docker, job, previous, Some(next)).await {
                return Err(Error::invalid(format!(
                    "Runtime replacement failed: {cause}; restoring the previous runtime also failed: {recovery}"
                )));
            }
            return Err(cause);
        }
        docker
            .remove_container(
                previous,
                Some(RemoveContainerOptionsBuilder::default().v(false).build()),
            )
            .await
            .map_err(docker_error)?;
    } else {
        docker
            .start_container(&name, None::<StartContainerOptions>)
            .await
            .map_err(docker_error)?;
        activate(docker, job, &address).await?;
    }
    Ok(address)
}

async fn operator(
    docker: &Docker,
    job: &Job,
    address: &str,
    port: u16,
    path: &str,
    method: &str,
) -> Result<Value> {
    operator_headers(docker, job, address, port, path, method, &[]).await
}

async fn operator_headers(
    docker: &Docker,
    job: &Job,
    address: &str,
    port: u16,
    path: &str,
    method: &str,
    headers: &[String],
) -> Result<Value> {
    let mut command = vec![
        "curl".into(),
        "--silent".into(),
        "--show-error".into(),
        "--fail-with-body".into(),
        "--max-time".into(),
        "60".into(),
        "-X".into(),
        method.into(),
        format!("http://{address}:{port}{path}"),
    ];
    for header in headers {
        command.extend(["-H".into(), header.clone()]);
    }
    execute_json(docker, job, command).await
}

async fn execute_json(docker: &Docker, job: &Job, command: Vec<String>) -> Result<Value> {
    Ok(serde_json::from_slice(
        &execute_output(docker, job, command).await?,
    )?)
}

pub async fn execute_output(docker: &Docker, job: &Job, command: Vec<String>) -> Result<Vec<u8>> {
    let exec = docker
        .create_exec(
            &name(job),
            ExecConfig {
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(command),
                ..Default::default()
            },
        )
        .await
        .map_err(docker_error)?;
    let mut bytes = Vec::new();
    let mut errors = Vec::new();
    if let StartExecResults::Attached { mut output, .. } = docker
        .start_exec(&exec.id, None)
        .await
        .map_err(docker_error)?
    {
        while let Some(message) = output.next().await {
            match message.map_err(docker_error)? {
                LogOutput::StdErr { message } => errors.extend_from_slice(&message),
                message => bytes.extend_from_slice(message.as_ref()),
            }
        }
    }
    let result = docker.inspect_exec(&exec.id).await.map_err(docker_error)?;
    if result.exit_code != Some(0) {
        return Err(Error::invalid(format!(
            "celld operator request failed: {}{}",
            String::from_utf8_lossy(&bytes),
            String::from_utf8_lossy(&errors)
        )));
    }
    Ok(bytes)
}

// celld 0.6.1 can retain a detached queue's distant retention alarm after a
// consumer is attached. Its supported resume command rearms the backlog.
pub async fn wake_queue(
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
    queue: &str,
) -> Result<()> {
    let storage = configuration.storage.resolve()?;
    let command = |operation: &str| {
        let mut command = vec![
            "celld".into(),
            "queue".into(),
            operation.into(),
            queue.into(),
            "--json".into(),
        ];
        command.extend(storage.arguments(job.fleet_id, true));
        command
    };
    let info = execute_json(docker, job, command("info")).await?;
    match info.get("paused").and_then(Value::as_bool) {
        Some(false) => {
            execute_json(docker, job, command("resume")).await?;
        }
        Some(true) => {} // Preserve an operator's explicit pause.
        None => {
            return Err(Error::invalid(
                "celld queue info omitted its paused state".into(),
            ));
        }
    }
    Ok(())
}

pub async fn activate(docker: &Docker, job: &Job, address: &str) -> Result<()> {
    let mut ready = false;
    for _ in 0..30 {
        if operator(docker, job, address, 8081, "/state", "GET")
            .await
            .is_ok()
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    if !ready {
        return Err(Error::invalid(
            "App runtime did not become ready; inspect its container logs".into(),
        ));
    }
    Ok(())
}

pub async fn reload(docker: &Docker, job: &Job, address: &str) -> Result<()> {
    let response = operator(docker, job, address, 8081, "/reload", "POST").await?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(Error::invalid(format!(
            "celld rejected the deployment: {response}"
        )));
    }
    Ok(())
}

pub async fn check_runtime(
    docker: &Docker,
    job: &Job,
    address: &str,
    token: &str,
    version: &str,
) -> Result<()> {
    let ready = operator_headers(
        docker,
        job,
        address,
        8080,
        "/.well-known/widefleet/runtime",
        "GET",
        &[format!("Authorization: Bearer {token}")],
    )
    .await?;
    if ready.get("runtimeVersion").and_then(Value::as_str) != Some(version) {
        return Err(Error::invalid(
            "The requested runtime version is not active".into(),
        ));
    }
    Ok(())
}

pub async fn check_candidate(
    docker: &Docker,
    job: &Job,
    address: &str,
    token: &str,
    app: &PublishedApp,
) -> Result<()> {
    let headers = [
        format!("Host: {}", app.hostname),
        format!("Authorization: Bearer {token}"),
        format!(
            "X-Widefleet-Candidate: {}/{}",
            app.artifact.app_id, app.version
        ),
    ];
    let ready = operator_headers(
        docker,
        job,
        address,
        8080,
        "/.well-known/widefleet/ready",
        "GET",
        &headers,
    )
    .await?;
    if ready.get("version").and_then(Value::as_str) != Some(app.version.to_string().as_str())
        || ready.get("deploymentId").and_then(Value::as_str)
            != Some(app.deployment_id.to_string().as_str())
        || ready.get("networkRevision").and_then(Value::as_u64) != Some(app.network.revision)
        || ready.get("capabilityRevision").and_then(Value::as_u64) != Some(app.capability_revision)
    {
        return Err(Error::invalid(
            "The candidate has not loaded the requested code and permissions".into(),
        ));
    }
    Ok(())
}

pub async fn route(configuration: &Configuration, job: &Job) -> Result<()> {
    tokio::fs::create_dir_all(&configuration.routing_directory).await?;
    let runtime = name(job);
    let name = format!("platform-app-{}", job.app_id()?);
    let tls = route_tls(configuration, job.hostname()?)?;
    let auth = crate::access::middleware(configuration, job)?;
    let marker = crate::access::marker(job)?;
    let auth_name = format!("{name}-auth");
    let revision_name = format!("{name}-access-revision");
    let route = value!({ "http": {
        "routers": { &name: { "rule": format!("Host(`{}`)", job.hostname()?), "entryPoints": ["websecure"], "tls": tls, "service": &name, "middlewares": ["clear-client-identity@file", format!("{revision_name}@file"), format!("{auth_name}@file"), "remove-app-credentials@file"] } },
        "middlewares": {
            &auth_name: auth,
            &revision_name: { "headers": { "customResponseHeaders": { "X-Widefleet-Access-Revision": marker } } }
        },
        "services": { &name: { "loadBalancer": { "servers": [{ "url": format!("http://{runtime}:8080") }] } } },
    } });
    let temporary = configuration.routing_directory.join(format!(".{name}.tmp"));
    // JSON is valid YAML; Traefik's file provider discovers .yaml, not .json.
    tokio::fs::write(&temporary, serde_json::to_vec_pretty(&route)?).await?;
    tokio::fs::rename(
        temporary,
        configuration.routing_directory.join(format!("{name}.yaml")),
    )
    .await?;
    Ok(())
}

fn route_tls(configuration: &Configuration, hostname: &str) -> Result<Value> {
    if configuration.tls_mode == crate::config::TlsMode::Provided {
        return Ok(value!({}));
    }
    let domain = configuration
        .app_domain
        .as_deref()
        .ok_or_else(|| Error::invalid("Set APP_DOMAIN when TLS_MODE is cloudflare".into()))?;
    let prefix = hostname
        .strip_suffix(&format!(".{domain}"))
        .ok_or_else(|| Error::invalid("App hostname is outside APP_DOMAIN".into()))?;
    let Some((preview, parent)) = prefix.split_once('.') else {
        return Ok(value!({}));
    };
    if preview.is_empty() || parent.is_empty() || parent.contains('.') {
        return Err(Error::invalid(
            "Expected one preview label below the parent app hostname".into(),
        ));
    }
    // All previews of this app share one certificate. Traefik owns issuance, reuse and renewal.
    Ok(
        value!({ "certResolver": "letsencrypt", "domains": [{ "main": format!("*.{parent}.{domain}") }] }),
    )
}

pub async fn remove(configuration: &Configuration, job: &Job) -> Result<()> {
    let route = configuration
        .routing_directory
        .join(format!("platform-app-{}.yaml", job.app_id()?));
    match tokio::fs::remove_file(route).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub async fn workflow_request(
    docker: &Docker,
    job: &Job,
    token: &str,
    request: Value,
) -> Result<Value> {
    // Argument-vector execution: request text is never interpreted by a shell.
    let body = serde_json::to_string(
        &value!({ "appId": job.app_id()?, "hostname": job.hostname()?, "requestId": job.id, "request": request }),
    )?;
    let response = execute_json(
        docker,
        job,
        vec![
            "curl".into(),
            "--silent".into(),
            "--show-error".into(),
            "--fail-with-body".into(),
            "--max-time".into(),
            "60".into(),
            "-H".into(),
            format!("Authorization: Bearer {token}"),
            "-H".into(),
            "Content-Type: application/json".into(),
            "--data-binary".into(),
            body,
            "http://127.0.0.1:8080/.well-known/widefleet/workflows".into(),
        ],
    )
    .await?;
    response
        .get("result")
        .cloned()
        .ok_or_else(|| Error::invalid("Workflow runtime returned no result".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn requests_one_wildcard_per_parent_and_reuses_the_app_certificate() -> Result<()> {
        let mut configuration = Configuration::try_parse_from([
            "platform-agent",
            "--url",
            "https://platform.example.test",
            "--token",
            "fixture-only",
            "--routing-directory",
            "/tmp/preview-routing",
            "--tls-mode",
            "cloudflare",
            "--app-domain",
            "apps.example.test",
        ])
        .map_err(|error| Error::invalid(error.to_string()))?;
        assert_eq!(
            route_tls(&configuration, "notes.apps.example.test")?,
            value!({})
        );
        let expected = value!({ "certResolver": "letsencrypt", "domains": [{ "main": "*.notes.apps.example.test" }] });
        assert_eq!(
            route_tls(&configuration, "review.notes.apps.example.test")?,
            expected
        );
        assert_eq!(
            route_tls(&configuration, "other.notes.apps.example.test")?,
            expected
        );
        assert!(route_tls(&configuration, "review.notes.attacker.test").is_err());
        assert!(route_tls(&configuration, "deep.review.notes.apps.example.test").is_err());
        configuration.tls_mode = crate::config::TlsMode::Provided;
        assert_eq!(
            route_tls(&configuration, "review.notes.apps.example.test")?,
            value!({})
        );
        Ok(())
    }
}
