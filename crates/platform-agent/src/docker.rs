use crate::config::Configuration;
use bollard::{Docker, container::LogOutput, exec::StartExecResults, models::ExecConfig};
use futures_util::StreamExt;
use platform_core::{
    Error, Result,
    model::{Job, PublishedApp},
};
use serde::Deserialize;
use serde_json::{Value, json as value};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

fn docker_error(error: bollard::errors::Error) -> Error {
    Error::invalid(format!("Docker operation failed: {error}"))
}

pub async fn verify_native(docker: &Docker, configuration: &Configuration) -> Result<()> {
    let output = execute_output(
        docker,
        &configuration.runtime_container,
        vec!["celld".into(), "--version".into()],
    )
    .await?;
    crate::native::verify(&output, "Installed runtime")
}

pub async fn verify_storage(
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Installed {
        organization_id: String,
        arguments: Vec<String>,
        azure_account: Option<String>,
    }
    let installed: Installed = serde_json::from_slice(
        &execute_output(
            docker,
            &configuration.runtime_container,
            vec!["cat".into(), "/state/runtime.json".into()],
        )
        .await?,
    )?;
    if installed.organization_id != job.organization_id {
        return Err(Error::invalid(
            "The runtime belongs to a different organization".into(),
        ));
    }
    let environment = installed
        .azure_account
        .map(|account| format!("AZURE_STORAGE_ACCOUNT_NAME={account}"))
        .into_iter()
        .collect::<Vec<_>>();
    configuration.storage.resolve()?.verify_runtime(
        &job.organization_id,
        &installed.arguments,
        &environment,
    )
}

pub async fn ensure(docker: &Docker, configuration: &Configuration) -> Result<String> {
    let address = "127.0.0.1";
    activate(docker, &configuration.runtime_container, address).await?;
    Ok(address.into())
}

async fn operator(
    docker: &Docker,
    container: &str,
    address: &str,
    port: u16,
    path: &str,
    method: &str,
) -> Result<Value> {
    operator_headers(docker, container, address, port, path, method, &[]).await
}

async fn operator_headers(
    docker: &Docker,
    container: &str,
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
    execute_json(docker, container, command).await
}

async fn execute_json(docker: &Docker, container: &str, command: Vec<String>) -> Result<Value> {
    Ok(serde_json::from_slice(
        &execute_output(docker, container, command).await?,
    )?)
}

pub async fn execute_output(
    docker: &Docker,
    container: &str,
    command: Vec<String>,
) -> Result<Vec<u8>> {
    execute_with_environment(docker, container, command, Vec::new(), None).await
}

pub async fn execute_native(
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
    mut command: Vec<String>,
) -> Result<Vec<u8>> {
    let storage = configuration.storage.resolve()?;
    command.extend(storage.arguments(&job.organization_id, true));
    // Docker exec does not inherit environment added by the container entrypoint.
    let environment = storage
        .environment(true)
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect();
    execute_with_environment(
        docker,
        &configuration.runtime_container,
        command,
        environment,
        None,
    )
    .await
}

async fn execute_with_environment(
    docker: &Docker,
    container: &str,
    command: Vec<String>,
    environment: Vec<String>,
    stdin: Option<Vec<u8>>,
) -> Result<Vec<u8>> {
    let exec = docker
        .create_exec(
            container,
            ExecConfig {
                user: Some("0".into()),
                attach_stdin: Some(stdin.is_some()),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                cmd: Some(command),
                env: Some(environment),
                ..Default::default()
            },
        )
        .await
        .map_err(docker_error)?;
    let mut bytes = Vec::new();
    let mut errors = Vec::new();
    if let StartExecResults::Attached {
        mut output,
        mut input,
    } = docker
        .start_exec(&exec.id, None)
        .await
        .map_err(docker_error)?
    {
        if let Some(body) = stdin {
            input.write_all(&body).await?;
            input.shutdown().await?;
        }
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
    let command = |operation: &str| {
        vec![
            "celld".into(),
            "queue".into(),
            operation.into(),
            queue.into(),
            "--json".into(),
        ]
    };
    let info: Value = serde_json::from_slice(
        &execute_native(docker, configuration, job, command("info")).await?,
    )?;
    match info.get("paused").and_then(Value::as_bool) {
        Some(false) => {
            execute_native(docker, configuration, job, command("resume")).await?;
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

pub async fn activate(docker: &Docker, container: &str, address: &str) -> Result<()> {
    let mut ready = false;
    for _ in 0..30 {
        if operator(docker, container, address, 8081, "/state", "GET")
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

pub async fn reload(docker: &Docker, container: &str, address: &str) -> Result<()> {
    let response = operator(docker, container, address, 8081, "/reload", "POST").await?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(Error::invalid(format!(
            "celld rejected the deployment: {response}"
        )));
    }
    Ok(())
}

pub async fn check_runtime(
    docker: &Docker,
    container: &str,
    address: &str,
    token: &str,
    version: &str,
) -> Result<()> {
    let ready = operator_headers(
        docker,
        container,
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
    container: &str,
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
        container,
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
    let name = format!("platform-app-{}", job.app_id()?);
    route_host(configuration, &name, job.hostname()?).await
}

pub async fn route_connectors(
    configuration: &Configuration,
    origins: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    for origin in origins.values() {
        let url = reqwest::Url::parse(origin).map_err(|error| Error::invalid(error.to_string()))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(Error::invalid("Invalid connector browser origin".into()));
        }
        let hostname = url
            .host_str()
            .ok_or_else(|| Error::invalid("Connector origin has no hostname".into()))?;
        let name = format!(
            "platform-connector-{}",
            platform_core::sha256(hostname.as_bytes())
        );
        route_host(configuration, &name, hostname).await?;
    }
    Ok(())
}

async fn route_host(configuration: &Configuration, name: &str, hostname: &str) -> Result<()> {
    tokio::fs::create_dir_all(&configuration.routing_directory).await?;
    let tls = route_tls(configuration, hostname)?;
    let upstream = format!("http://{}:8080", configuration.runtime_container);
    let route = value!({ "http": {
        "routers": { name: { "rule": format!("Host(`{hostname}`) && !PathPrefix(`/.well-known/widefleet/`) && !HeaderRegexp(`X-Widefleet-Candidate`, `.*`)") , "entryPoints": ["websecure"], "tls": tls, "service": &name } },
        "services": { name: { "loadBalancer": { "servers": [{ "url": upstream }] } } },
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

pub async fn connector_request(
    docker: &Docker,
    container: &str,
    token: &str,
    request: &Value,
) -> Result<Value> {
    let bytes = execute_with_environment(
        docker,
        container,
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
            "@-".into(),
            "http://127.0.0.1:8080/.well-known/widefleet/connectors".into(),
        ],
        Vec::new(),
        Some(serde_json::to_vec(request)?),
    )
    .await?;
    let response: Value = serde_json::from_slice(&bytes)?;
    let mut result = response
        .get("result")
        .cloned()
        .ok_or_else(|| Error::invalid("Connector runtime returned no result".into()))?;
    result["action"] = value!("activate");
    Ok(result)
}

pub async fn workflow_request(
    docker: &Docker,
    container: &str,
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
        container,
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

    #[tokio::test]
    async fn publishes_connector_routes_without_an_app_and_reuses_the_same_route() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let configuration = Configuration::try_parse_from([
            "platform-agent",
            "--url",
            "https://platform.example.test",
            "--token",
            "fixture-only",
            "--routing-directory",
            directory
                .path()
                .to_str()
                .ok_or_else(|| Error::invalid("Invalid test path".into()))?,
            "--tls-mode",
            "provided",
        ])
        .map_err(|error| Error::invalid(error.to_string()))?;
        let hostname = "connector.apps.example.test";
        let origins = std::collections::BTreeMap::from([(
            "fixture".into(),
            format!("https://{hostname}:8443"),
        )]);
        route_connectors(&configuration, &origins).await?;
        let name = format!(
            "platform-connector-{}",
            platform_core::sha256(hostname.as_bytes())
        );
        let path = directory.path().join(format!("{name}.yaml"));
        let first = tokio::fs::read(&path).await?;
        let route: Value = serde_json::from_slice(&first)?;
        assert_eq!(route["http"]["routers"][&name]["service"], name);
        assert_eq!(
            route["http"]["services"][&name]["loadBalancer"]["servers"][0]["url"],
            "http://app-platform-runtime:8080"
        );
        assert!(
            route["http"]["routers"][&name]["rule"]
                .as_str()
                .is_some_and(|rule| rule.contains(hostname)
                    && rule.contains("!PathPrefix(`/.well-known/widefleet/`)"))
        );
        route_connectors(&configuration, &origins).await?;
        assert_eq!(tokio::fs::read(path).await?, first);
        assert!(
            route_connectors(
                &configuration,
                &std::collections::BTreeMap::from([(
                    "fixture".into(),
                    "https://connector.apps.example.test/path".into()
                )])
            )
            .await
            .is_err()
        );
        Ok(())
    }

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
