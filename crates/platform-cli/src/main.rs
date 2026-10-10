mod access;
mod apps;
mod auth;
mod catalog;
mod configuration;
mod connector;
mod deploy;
mod discovery;
mod groups;
mod installation;
mod logs;
mod migrations;
mod network;
mod preview;
mod reporting;
mod runtime;
mod settings;
mod workflows;

use clap::{Parser, Subcommand};
use platform_core::{
    Result,
    http::{Api, json},
    model::{App, Deployment},
};
use reqwest::Method;
use serde_json::{Value, json as value};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Parser)]
#[command(
    name = "widefleet",
    version,
    about = "Build and manage internal Worker applications"
)]
struct Arguments {
    #[arg(long, env = "PLATFORM_URL", global = true)]
    url: Option<String>,
    /// Use this CLI configuration file instead of the user and managed defaults.
    #[arg(long, env = "PLATFORM_CONFIG_FILE", global = true)]
    config_file: Option<PathBuf>,
    /// Store the login in an unencrypted, owner-only file instead of the OS credential store (Unix).
    #[arg(long, env = "PLATFORM_SESSION_FILE", global = true)]
    session_file: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Inspect or change local CLI configuration. No login is required.
    Config(configuration::Options),
    /// Show or change local usage and crash reporting. No login is required.
    Telemetry(reporting::Options),
    /// Create an independent SvelteKit project. No platform login is required.
    Init {
        directory: PathBuf,
    },
    Login(auth::LoginOptions),
    Logout,
    Whoami,
    /// List visible applications.
    Apps,
    /// Discover listed apps or publish and withdraw your app's catalog listing.
    Catalog(catalog::Options),
    /// Search the connected company directory.
    Groups(groups::Options),
    /// Configure this Widefleet installation (administrator access required).
    Settings(settings::Options),
    /// Update the application runtime independently of the deployment agent.
    Runtime(runtime::Options),
    /// Query browser/server runtime logs, with source maps and optional follow.
    Logs(logs::Options),
    /// Inspect and explicitly apply app D1 database migrations.
    Migrations(migrations::Options),
    /// Start, inspect and manage app Workflow instances.
    Workflows(workflows::Options),
    /// Show, allow or deny app network destinations.
    Network(network::Options),
    /// Manage app access groups inherited automatically by every preview.
    Access(access::Options),
    /// Deploy IT connectors and manage native RPC bindings.
    Connector(connector::Options),
    /// Create an application; use --parent for an isolated preview.
    Create {
        slug: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        parent: Option<Uuid>,
    },
    /// Build locally and upload a Wrangler-style deployment.
    Deploy {
        app: Option<Uuid>,
        #[command(flatten)]
        options: deploy::Options,
    },
    /// Build and deploy an isolated preview of the current app.
    Preview(preview::Options),
    History {
        app: Uuid,
    },
    Events {
        app: Uuid,
        deployment: Uuid,
    },
    Rollback {
        app: Uuid,
        artifact: Uuid,
        #[arg(long)]
        no_wait: bool,
    },
    /// Remove an app and its previews, routes and safely removable files.
    Delete {
        app: Uuid,
        #[arg(long)]
        yes: bool,
    },
    Agents,
    RegisterAgent {
        name: String,
    },
    DisableAgent {
        agent: Uuid,
    },
    Grant {
        app: Uuid,
        user: String,
    },
    Revoke {
        app: Uuid,
        user: String,
    },
}

fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

async fn run(args: Arguments) -> Result<()> {
    if let Command::Config(options) = args.command {
        return configuration::Files::locate(args.config_file.as_deref())?
            .command(options, args.url.as_deref());
    }
    if let Command::Telemetry(options) = args.command {
        return reporting::command(options);
    }
    if let Command::Init { directory } = &args.command {
        return installation::initialize(directory);
    }
    let domain = match &args.command {
        Command::Login(options) => options.discovery.domain(),
        _ => None,
    };
    let origin = if let Some(domain) = domain {
        if args.url.is_some() {
            return Err(platform_core::Error::invalid(
                "--email or --domain cannot be used with --url or PLATFORM_URL; remove the URL override to discover a different company".into(),
            ));
        }
        discovery::resolve(domain).await?
    } else {
        match configuration::explicit(args.url.as_deref())? {
            Some(selected) => selected.platform_url,
            None => match configuration::Files::locate(args.config_file.as_deref())?.selection()? {
                Some(selected) => selected.platform_url,
                None if matches!(args.command, Command::Login(_)) => {
                    discovery::resolve(&discovery::prompt()?).await?
                }
                None => return Err(platform_core::Error::invalid(
                    "No platform is configured. Run widefleet login --email employee@example.com or widefleet login --domain example.com".into(),
                )),
            },
        }
    };
    let api = Api::new(&origin)?;
    let credentials = auth::Credentials::new(args.session_file);
    match args.command {
        Command::Login(options) => {
            let files = match configuration::Files::locate(args.config_file.as_deref()) {
                Ok(files) => Some(files),
                Err(error) if args.url.is_some() && args.config_file.is_none() => {
                    eprintln!(
                        "Platform URL will not be saved: {error}. Continue supplying --url or PLATFORM_URL"
                    );
                    None
                }
                Err(error) => return Err(error),
            };
            auth::login(&api, &credentials, options).await?;
            if let Some(files) = files {
                files.save(Some(&api.origin_text()))
                .map_err(|error| {
                    platform_core::Error::invalid(format!(
                        "Login succeeded, but the platform URL could not be saved: {error}. Use --url for subsequent commands or fix the configuration file permissions"
                    ))
                })?;
            }
            return Ok(());
        }
        Command::Logout => return auth::logout(&api, &credentials).await,
        _ => {}
    }
    let token = auth::access_token(&api, &credentials).await?;
    let grant = matches!(&args.command, Command::Grant { .. });
    match args.command {
        Command::Logs(options) => logs::run(&api, &credentials, options).await,
        Command::Migrations(options) => migrations::run(&api, &credentials, options).await,
        Command::Workflows(options) => workflows::run(&api, &credentials, options).await,
        Command::Network(options) => network::run(&api, &credentials, options).await,
        Command::Access(options) => access::run(&api, &credentials, options).await,
        Command::Connector(options) => connector::run(&api, &credentials, options).await,
        Command::Runtime(options) => runtime::run(&api, &credentials, &token, options).await,
        Command::Settings(options) => settings::run(&api, &token, options).await,
        Command::Groups(options) => groups::run(&api, &token, options).await,
        Command::Catalog(options) => catalog::run(&api, &token, options).await,
        Command::Whoami => print_json(
            &json::<Value>(api.authenticated(Method::GET, "/me", &token).send().await?).await?,
        ),
        Command::Apps => print_json(
            &json::<Vec<App>>(
                api.authenticated(Method::GET, "/apps", &token)
                    .send()
                    .await?,
            )
            .await?,
        ),
        Command::Create { slug, name, parent } => {
            let input = value!({ "slug": slug, "displayName": name, "parentId": parent });
            print_json(
                &json::<App>(
                    api.authenticated(Method::POST, "/apps", &token)
                        .json(&input)
                        .send()
                        .await?,
                )
                .await?,
            )
        }
        Command::Deploy { app, options } => {
            deploy::run(&api, &credentials, deploy::Target::App(app), options).await
        }
        Command::Preview(options) => preview::run(&api, &credentials, options).await,
        Command::History { app } => print_json(
            &json::<Vec<Deployment>>(
                api.authenticated(Method::GET, &format!("/apps/{app}/deployments"), &token)
                    .send()
                    .await?,
            )
            .await?,
        ),
        Command::Events { app, deployment } => print_json(
            &json::<Value>(
                api.authenticated(
                    Method::GET,
                    &format!("/apps/{app}/deployments/{deployment}/events"),
                    &token,
                )
                .send()
                .await?,
            )
            .await?,
        ),
        Command::Rollback {
            app,
            artifact,
            no_wait,
        } => {
            let deployment: Deployment = json(
                api.authenticated(Method::POST, &format!("/apps/{app}/rollback"), &token)
                    .header("idempotency-key", Uuid::new_v4().to_string())
                    .json(&value!({ "artifactId": artifact }))
                    .send()
                    .await?,
            )
            .await?;
            print_json(&deployment)?;
            if !no_wait {
                deploy::wait(&api, &credentials, app, deployment.id).await?;
            }
            Ok(())
        }
        Command::Delete { app, yes } => {
            if !yes {
                return Err(platform_core::Error::invalid(
                    "Deletion is permanent. Repeat with --yes to remove this app, all its previews and their published versions"
                        .into(),
                ));
            }
            print_json(
                &json::<Value>(
                    api.authenticated(Method::DELETE, &format!("/apps/{app}"), &token)
                        .send()
                        .await?,
                )
                .await?,
            )
        }
        Command::Agents => print_json(
            &json::<Value>(
                api.authenticated(Method::GET, "/agents", &token)
                    .send()
                    .await?,
            )
            .await?,
        ),
        Command::RegisterAgent { name } => print_json(
            &json::<Value>(
                api.authenticated(Method::POST, "/agents", &token)
                    .json(&value!({ "name": name }))
                    .send()
                    .await?,
            )
            .await?,
        ),
        Command::DisableAgent { agent } => print_json(
            &json::<Value>(
                api.authenticated(Method::DELETE, &format!("/agents/{agent}"), &token)
                    .send()
                    .await?,
            )
            .await?,
        ),
        Command::Grant { app, user } | Command::Revoke { app, user } => {
            let method = if grant { Method::PUT } else { Method::DELETE };
            let mut url = api.origin.clone();
            url.path_segments_mut()
                .map_err(|()| platform_core::Error::invalid("Invalid platform origin".into()))?
                .extend(["api", "v1", "apps", &app.to_string(), "creators", &user]);
            let response = api
                .client
                .request(method, url)
                .header("origin", api.origin_text())
                .bearer_auth(&token)
                .json(&value!({}))
                .send()
                .await?;
            print_json(&json::<Value>(response).await?)
        }
        Command::Config(_)
        | Command::Telemetry(_)
        | Command::Init { .. }
        | Command::Login(_)
        | Command::Logout => {
            unreachable!("Local and authentication commands return before API dispatch")
        }
    }
}

#[tokio::main]
async fn main() {
    let args = Arguments::parse();
    let command = match &args.command {
        Command::Config(_) => "config",
        Command::Telemetry(_) => "telemetry",
        Command::Init { .. } => "init",
        Command::Login(_) => "login",
        Command::Logout => "logout",
        Command::Whoami => "whoami",
        Command::Apps => "apps",
        Command::Catalog(_) => "catalog",
        Command::Groups(_) => "groups",
        Command::Settings(_) => "settings",
        Command::Runtime(_) => "runtime",
        Command::Logs(_) => "logs",
        Command::Migrations(_) => "migrations",
        Command::Workflows(_) => "workflows",
        Command::Network(_) => "network",
        Command::Access(_) => "access",
        Command::Connector(_) => "connector",
        Command::Create { .. } => "create",
        Command::Deploy { .. } => "deploy",
        Command::Preview(_) => "preview",
        Command::History { .. } => "history",
        Command::Events { .. } => "events",
        Command::Rollback { .. } => "rollback",
        Command::Delete { .. } => "delete",
        Command::Agents => "agents",
        Command::RegisterAgent { .. } => "register_agent",
        Command::DisableAgent { .. } => "disable_agent",
        Command::Grant { .. } => "grant",
        Command::Revoke { .. } => "revoke",
    };
    let telemetry = if matches!(command, "telemetry" | "config") {
        None
    } else {
        reporting::initialize()
    };
    let capture = telemetry
        .as_ref()
        .map(|_| platform_core::reporting::PanicCapture::install());
    let started = std::time::Instant::now();
    let joined = tokio::spawn(run(args)).await;
    let panicked = joined.as_ref().is_err_and(tokio::task::JoinError::is_panic);
    let result = joined.unwrap_or_else(|_| {
        Err(platform_core::Error::invalid(
            "Widefleet command panicked".into(),
        ))
    });
    let elapsed = started.elapsed();
    let succeeded = result.is_ok();
    let report = capture
        .and_then(|capture| capture.take())
        .or_else(|| result.as_ref().err().map(platform_core::reporting::error));

    // Make the original failure visible before reporting can wait on the network.
    if let Err(error) = result {
        match error.into_kind() {
            platform_core::ErrorKind::Http(error) => {
                // Query strings can contain credentials, including signed download URLs.
                let error = error.without_url();
                eprintln!("HTTP request failed: {error}");
                let mut source = std::error::Error::source(&error);
                while let Some(cause) = source {
                    eprintln!("  Caused by: {cause}");
                    source = cause.source();
                }
            }
            error => eprintln!("{error}"),
        }
    }
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        reporting::finish(telemetry, command, elapsed, succeeded, report),
    )
    .await;
    if !succeeded {
        std::process::exit(if panicked { 101 } else { 1 });
    }
}
