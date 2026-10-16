use platform_core::{Error, Result, model::RuntimeRelease};
use serde_json::{Value, json};

pub fn configuration(release: &RuntimeRelease, token: &str) -> Result<Value> {
    if release.protocol != 1 || release.auth != 1 || release.celld != "0.6.2" {
        return Err(Error::invalid(
            "Unsupported runtime installation protocol or celld version".into(),
        ));
    }
    let mut config = json!({
        "name": "widefleet", "main": release.main, "no_bundle": true,
        "compatibility_date": "2026-10-01", "compatibility_flags": ["nodejs_compat"],
        "worker_loaders": [{ "binding": "WIDEFLEET_LOADER" }],
        "vars": { "WIDEFLEET_CONTROL_TOKEN": token, "WIDEFLEET_MANAGEMENT_HTTP": "true", "WIDEFLEET_CONFIGURATION": "{\"crons\":{},\"queues\":{}}" },
        "r2_buckets": [{ "binding": "WIDEFLEET_PACKAGES", "bucket_name": "widefleet-packages" }],
        "kv_namespaces": [{ "binding": "AUTH_CONFIG", "id": "widefleet-auth" }],
        "services": [],
    });
    if release.workflows == Some(1) {
        config["services"] = json!([{ "binding": "WIDEFLEET_WORKFLOW_SESSIONS", "service": "widefleet", "entrypoint": "WorkflowSessions" }]);
        config["workflows"] = json!([{ "binding": "WIDEFLEET_WORKFLOWS", "name": "widefleet-apps", "class_name": "AppWorkflow" }]);
        config["durable_objects"] = json!({ "bindings": [{ "name": "WIDEFLEET_WORKFLOW_CATALOG", "class_name": "WidefleetWorkflowCatalog" }] });
    }
    Ok(config)
}
