use crate::{app_bindings, apps, auth, deploy};
use clap::{Args, Subcommand, ValueEnum};
use platform_core::{
    Error, FailureReason, Result,
    http::{Api, json},
    model::{CapabilityGrant, Deployment},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::{io::IsTerminal, path::PathBuf};
use uuid::Uuid;

#[derive(Args)]
pub struct Catalog {
    #[command(subcommand)]
    command: Option<CatalogCommand>,
}

#[derive(Subcommand)]
enum CatalogCommand {
    /// List the methods of an app's active deployment, or describe selected methods and types.
    Describe {
        app: String,
        /// Entrypoint of the methods to describe.
        #[arg(long, default_value = "default")]
        entrypoint: String,
        /// Method to describe with its signatures and types; repeat for several methods.
        #[arg(long = "method", value_name = "NAME")]
        methods: Vec<String>,
        /// Documented type to describe, as types, uses and omittedTypes name it; repeat for several.
        #[arg(long = "type", value_name = "NAME")]
        types: Vec<String>,
    },
    /// Generate TypeScript types for a binding to an app's API from its active deployment.
    Types {
        app: String,
        /// Binding name in the caller's environment, which names the generated interface.
        #[arg(long = "as", value_name = "BINDING")]
        binding: String,
        /// Entrypoint the binding connects to.
        #[arg(long, default_value = "default")]
        entrypoint: String,
        /// File to write instead of standard output.
        #[arg(long, short, value_name = "FILE")]
        output: Option<PathBuf>,
        /// Fail if the output file differs from the types of the active deployment.
        #[arg(long, requires = "output")]
        check: bool,
    },
    /// Set who may connect to an API (organization administrators only).
    Access {
        app: String,
        #[arg(long, value_enum)]
        mode: AccessMode,
    },
    /// List your connection requests, or all requests as an administrator.
    Requests,
    /// Approve a request and submit its connection for activation.
    Approve { request: Uuid },
    /// Reject a pending connection request.
    Reject { request: Uuid },
}

#[derive(Clone, Copy, ValueEnum, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum AccessMode {
    ApprovalRequired,
    Organization,
}

fn default_access_mode() -> AccessMode {
    AccessMode::ApprovalRequired
}

#[derive(Args)]
pub struct Connect {
    /// Ask an administrator to approve this connection.
    #[arg(long, conflicts_with = "no_wait")]
    request: bool,
    target: String,
    #[arg(long = "as")]
    binding: String,
    #[arg(long, default_value = "default")]
    entrypoint: String,
    #[command(flatten)]
    source: app_bindings::Target,
    #[arg(long)]
    no_wait: bool,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
pub struct Disconnect {
    binding: String,
    #[command(flatten)]
    source: app_bindings::Target,
    #[arg(long)]
    no_wait: bool,
    #[arg(long)]
    json: bool,
}

#[derive(Deserialize)]
struct BindingTypes {
    declarations: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Service {
    app_id: Uuid,
    slug: String,
    display_name: String,
    entrypoints: Vec<String>,
    #[serde(default = "default_access_mode")]
    access_mode: AccessMode,
}

// Resolve one app through its description, which also covers deployed entrypoints that the
// catalog omits, such as an undocumented default web handler that callers bind explicitly.
async fn resolve_service(api: &Api, token: &str, target: &str) -> Result<Service> {
    let service = app_bindings::segment(target)?;
    json(
        api.authenticated(Method::GET, &format!("/app-services/{service}"), token)
            .send()
            .await?,
    )
    .await
}

async fn types(
    api: &Api,
    token: &str,
    app: &str,
    binding: &str,
    entrypoint: &str,
    output: Option<PathBuf>,
    check: bool,
) -> Result<()> {
    let service = app_bindings::segment(app)?;
    let binding = app_bindings::segment(binding)?;
    let generated: BindingTypes = json(
        api.authenticated(
            Method::GET,
            &format!("/app-services/{service}/types"),
            token,
        )
        .query(&[("binding", binding), ("entrypoint", entrypoint)])
        .send()
        .await?,
    )
    .await?;
    let declarations = generated.declarations + "\n";
    let Some(path) = output else {
        print!("{declarations}");
        return Ok(());
    };
    if !check {
        return Ok(std::fs::write(path, declarations)?);
    }
    let current = match std::fs::read_to_string(&path) {
        Ok(current) => Some(current),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    // Compare lines, so a checkout that converts line endings still matches.
    if current.is_some_and(|current| current.lines().eq(declarations.lines())) {
        return Ok(());
    }
    Err(Error::invalid(format!(
        "{} does not match the API of {app}'s active deployment; run the command without --check to update it",
        path.display()
    ))
    .with_reason(FailureReason::ServiceTypesOutdated))
}

pub async fn catalog(api: &Api, credentials: &auth::Credentials, options: Catalog) -> Result<()> {
    let token = auth::access_token(api, credentials).await?;
    if let Some(command) = options.command {
        let request = match command {
            CatalogCommand::Types {
                app,
                binding,
                entrypoint,
                output,
                check,
            } => return types(api, &token, &app, &binding, &entrypoint, output, check).await,
            CatalogCommand::Describe {
                app,
                entrypoint,
                methods,
                types,
            } => {
                let service = app_bindings::segment(&app)?;
                let request =
                    api.authenticated(Method::GET, &format!("/app-services/{service}"), &token);
                if methods.is_empty() && types.is_empty() {
                    request
                } else {
                    let selection = methods
                        .into_iter()
                        .map(|method| ("methods[]", method))
                        .chain(types.into_iter().map(|name| ("types[]", name)));
                    request.query(
                        &std::iter::once(("entrypoint", entrypoint))
                            .chain(selection)
                            .collect::<Vec<_>>(),
                    )
                }
            }
            CatalogCommand::Access { app, mode } => {
                let target = resolve_service(api, &token, &app).await?;
                api.authenticated(
                    Method::PUT,
                    &format!("/app-services/{}/access", target.app_id),
                    &token,
                )
                .json(&serde_json::json!({ "accessMode": mode }))
            }
            CatalogCommand::Requests => {
                api.authenticated(Method::GET, "/connection-requests", &token)
            }
            CatalogCommand::Approve { request } => api
                .authenticated(
                    Method::POST,
                    &format!("/connection-requests/{request}/approve"),
                    &token,
                )
                .json(&serde_json::json!({})),
            CatalogCommand::Reject { request } => api
                .authenticated(
                    Method::POST,
                    &format!("/connection-requests/{request}/reject"),
                    &token,
                )
                .json(&serde_json::json!({})),
        };
        let result: serde_json::Value = json(request.send().await?).await?;
        return crate::print_json(&result);
    }
    let entries: Vec<Service> = json(
        api.authenticated(Method::GET, "/app-services", &token)
            .send()
            .await?,
    )
    .await?;
    crate::print_json(&entries)
}

pub async fn connect(api: &Api, credentials: &auth::Credentials, options: Connect) -> Result<()> {
    let token = auth::access_token(api, credentials).await?;
    let target = resolve_service(api, &token, &options.target).await?;
    if options.request {
        app_bindings::segment(&options.binding)?;
        let app = options.source.resolve(api, credentials).await?;
        let request: serde_json::Value = json(api.authenticated(Method::POST, "/connection-requests", &token)
            .json(&serde_json::json!({
                "appId": app, "app": target.app_id, "binding": options.binding, "entrypoint": options.entrypoint,
            })).send().await?).await?;
        return crate::print_json(&request);
    }
    app_bindings::change_binding(
        api,
        credentials,
        options.source,
        options.binding,
        Some(CapabilityGrant {
            app: target.app_id,
            entrypoint: options.entrypoint,
        }),
        options.no_wait,
        options.json,
    )
    .await
}

pub async fn disconnect(
    api: &Api,
    credentials: &auth::Credentials,
    options: Disconnect,
) -> Result<()> {
    app_bindings::change_binding(
        api,
        credentials,
        options.source,
        options.binding,
        None,
        options.no_wait,
        options.json,
    )
    .await
}

#[derive(Args)]
pub struct Secrets {
    #[arg(long, global = true)]
    app: Option<String>,
    #[arg(long, global = true, default_value = "wrangler.jsonc")]
    config: PathBuf,
    #[arg(long, global = true)]
    json: bool,
    #[arg(long, global = true)]
    no_wait: bool,
    #[command(subcommand)]
    command: SecretCommand,
}

#[derive(Subcommand)]
enum SecretCommand {
    List,
    Put {
        name: String,
        #[arg(long)]
        file: Option<PathBuf>,
    },
    Delete {
        name: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretStatus {
    names: Vec<String>,
    revision: u64,
    applied_revision: Option<u64>,
    deployment: Option<Deployment>,
}

pub async fn secrets(api: &Api, credentials: &auth::Credentials, options: Secrets) -> Result<()> {
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    let token = auth::access_token(api, credentials).await?;
    let path = format!("/apps/{app}/secrets");
    let changing = !matches!(&options.command, SecretCommand::List);
    let request = match options.command {
        SecretCommand::List => api.authenticated(Method::GET, &path, &token),
        SecretCommand::Put { name, file } => {
            let name = app_bindings::segment(&name)?;
            api.authenticated(Method::PUT, &format!("{path}/{name}"), &token)
                .json(&serde_json::json!({ "value": app_bindings::secret_value(file)? }))
        }
        SecretCommand::Delete { name } => api.authenticated(
            Method::DELETE,
            &format!("{path}/{}", app_bindings::segment(&name)?),
            &token,
        ),
    };
    let mut status: SecretStatus = json(request.send().await?).await?;
    // Only this response identifies our mutation; a later read can describe another edit.
    if changing
        && let Some(deployment) = &status.deployment
        && deployment.status == "failed"
    {
        return Err(Error::invalid(
            deployment
                .message
                .clone()
                .unwrap_or_else(|| "Secret activation failed".into()),
        )
        .with_reason(FailureReason::DeploymentFailed));
    }
    if changing
        && !options.no_wait
        && let Some(deployment) = &status.deployment
        && (deployment.status == "queued" || deployment.status == "running")
    {
        deploy::wait(api, credentials, app, deployment.id).await?;
        let token = auth::access_token(api, credentials).await?;
        status = json(api.authenticated(Method::GET, &path, &token).send().await?).await?;
    }
    if options.json || !std::io::stdout().is_terminal() {
        return crate::print_json(&status);
    }
    println!("Secrets: {}", status.names.join(", "));
    println!(
        "Revision: {} (active: {:?})",
        status.revision, status.applied_revision
    );
    Ok(())
}
