use crate::{apps, auth};
use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json as value};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[arg(long, global = true)]
    app: Option<String>,
    #[arg(long, global = true, default_value = "wrangler.jsonc")]
    config: PathBuf,
    /// Print the queued operation and return without waiting for the agent.
    #[arg(long, global = true)]
    no_wait: bool,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// List Workflow declarations in the current deployment.
    Definitions,
    /// List instances, including instances from earlier deployments.
    List {
        workflow: String,
        #[arg(long)]
        cursor: Option<String>,
    },
    Create {
        workflow: String,
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        params: Option<PathBuf>,
    },
    Status {
        workflow: String,
        id: String,
    },
    Pause {
        workflow: String,
        id: String,
    },
    Resume {
        workflow: String,
        id: String,
    },
    Restart {
        workflow: String,
        id: String,
        /// Restart from this step, retaining earlier step results.
        #[arg(long)]
        from_step_name: Option<String>,
        /// One-based occurrence of the step name and type (default: 1).
        #[arg(long, requires = "from_step_name", value_parser = clap::value_parser!(u64).range(1..=9_007_199_254_740_991))]
        from_step_count: Option<u64>,
        /// Step type to select (default: do).
        #[arg(long, requires = "from_step_name", value_parser = ["do", "sleep", "waitForEvent"])]
        from_step_type: Option<String>,
    },
    Terminate {
        workflow: String,
        id: String,
    },
    Delete {
        workflow: String,
        id: String,
    },
    SendEvent {
        workflow: String,
        id: String,
        event_type: String,
        #[arg(long)]
        payload: PathBuf,
    },
    /// Read a previously queued management operation.
    Operation {
        id: Uuid,
    },
}
#[derive(Deserialize, serde::Serialize)]
struct Operation {
    id: Uuid,
    state: String,
    message: Option<String>,
    result: Value,
}
fn read_json(path: &PathBuf) -> Result<Value> {
    let bytes = std::fs::read(path)?;
    if bytes.len() > 64 * 1024 {
        return Err(Error::invalid(
            "Workflow management payload exceeds 64 KiB".into(),
        ));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    let token = auth::access_token(api, credentials).await?;
    let request = match options.command {
        Command::Definitions => {
            let response: Value = json(
                api.authenticated(Method::GET, &format!("/apps/{app}/workflows"), &token)
                    .send()
                    .await?,
            )
            .await?;
            return super::print_json(&response);
        }
        Command::Operation { id } => {
            let response: Operation = json(
                api.authenticated(
                    Method::GET,
                    &format!("/apps/{app}/workflows/operations/{id}"),
                    &token,
                )
                .send()
                .await?,
            )
            .await?;
            return super::print_json(&response);
        }
        Command::List { workflow, cursor } => {
            let mut request = value!({ "action": "list", "workflow": workflow });
            if let Some(cursor) = cursor {
                request["cursor"] = value!(cursor);
            }
            request
        }
        Command::Create {
            workflow,
            id,
            params,
        } => {
            value!({ "action": "create", "workflow": workflow, "id": id.unwrap_or_else(|| Uuid::new_v4().to_string()), "params": params.as_ref().map(read_json).transpose()? })
        }
        Command::Status { workflow, id } => {
            value!({ "action": "status", "workflow": workflow, "id": id })
        }
        Command::Pause { workflow, id } => {
            value!({ "action": "pause", "workflow": workflow, "id": id })
        }
        Command::Resume { workflow, id } => {
            value!({ "action": "resume", "workflow": workflow, "id": id })
        }
        Command::Restart {
            workflow,
            id,
            from_step_name,
            from_step_count,
            from_step_type,
        } => {
            let mut request = value!({ "action": "restart", "workflow": workflow, "id": id });
            if let Some(name) = from_step_name {
                let mut from = value!({ "name": name });
                if let Some(count) = from_step_count {
                    from["count"] = value!(count);
                }
                if let Some(kind) = from_step_type {
                    from["type"] = value!(kind);
                }
                request["from"] = from;
            }
            request
        }
        Command::Terminate { workflow, id } => {
            value!({ "action": "terminate", "workflow": workflow, "id": id })
        }
        Command::Delete { workflow, id } => {
            value!({ "action": "delete", "workflow": workflow, "id": id })
        }
        Command::SendEvent {
            workflow,
            id,
            event_type,
            payload,
        } => {
            value!({ "action": "sendEvent", "workflow": workflow, "id": id, "event": { "type": event_type, "payload": read_json(&payload)? } })
        }
    };
    let query = matches!(request["action"].as_str(), Some("list" | "status"));
    let path = format!("/apps/{app}/workflows{}", if query { "/query" } else { "" });
    let request_id = Uuid::new_v4();
    eprintln!("Workflow operation: {request_id}");
    let mut operation: Operation = json(
        api.authenticated(Method::POST, &path, &token)
            .header("idempotency-key", request_id.to_string())
            .json(&value!({ "request": request }))
            .send()
            .await?,
    )
    .await?;
    while !options.no_wait && matches!(operation.state.as_str(), "queued" | "running") {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let token = auth::access_token(api, credentials).await?;
        operation = json(
            api.authenticated(
                Method::GET,
                &format!("/apps/{app}/workflows/operations/{}", operation.id),
                &token,
            )
            .send()
            .await?,
        )
        .await?;
    }
    super::print_json(&operation)?;
    if operation.state == "failed" {
        return Err(Error::invalid(
            operation
                .message
                .unwrap_or_else(|| "Workflow operation failed".into()),
        ));
    }
    Ok(())
}
