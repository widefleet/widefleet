use object_store::{ObjectStore, ObjectStoreExt, PutMode, PutOptions, path::Path};
use platform_core::{Error, Result, model::RuntimeRelease};
use serde_json::{Value, json};
use uuid::Uuid;

// Persist independently of access credentials. Concurrent bootstrap/agent starts
// must agree on one key; replacing it would make published snapshots unreadable.
pub async fn connector_key(store: &dyn ObjectStore, organization_id: &str) -> Result<String> {
    let path = Path::from(format!("organizations/{organization_id}/connector-key"));
    let failure =
        |error: object_store::Error| Error::invalid(format!("Runtime key storage failed: {error}"));
    let missing = match store.head(&path).await {
        Ok(_) => false,
        Err(object_store::Error::NotFound { .. }) => true,
        Err(error) => return Err(failure(error)),
    };
    if missing {
        let value = platform_core::sha256(
            format!("{}{}{}", Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()).as_bytes(),
        );
        match store
            .put_opts(
                &path,
                value.into(),
                PutOptions {
                    mode: PutMode::Create,
                    ..Default::default()
                },
            )
            .await
        {
            Ok(_) | Err(object_store::Error::AlreadyExists { .. }) => {}
            Err(error) => return Err(failure(error)),
        }
    }
    let bytes = store
        .get(&path)
        .await
        .map_err(failure)?
        .bytes()
        .await
        .map_err(failure)?;
    let value =
        String::from_utf8(bytes.to_vec()).map_err(|error| Error::invalid(error.to_string()))?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Error::invalid("Invalid connector encryption key".into()));
    }
    Ok(value)
}

pub fn configuration(release: &RuntimeRelease, token: &str, connector_key: &str) -> Result<Value> {
    if release.protocol != 2 || release.auth != 1 || release.celld != "0.6.2" {
        return Err(Error::invalid(
            "Unsupported runtime installation protocol or celld version".into(),
        ));
    }
    let mut config = json!({
        "name": "widefleet", "main": release.main, "no_bundle": true,
        "compatibility_date": "2026-10-01", "compatibility_flags": ["nodejs_compat"],
        "worker_loaders": [{ "binding": "WIDEFLEET_LOADER" }],
        "vars": { "WIDEFLEET_CONTROL_TOKEN": token, "WIDEFLEET_CONNECTOR_KEY": connector_key, "WIDEFLEET_MANAGEMENT_HTTP": "true", "WIDEFLEET_CONFIGURATION": "{\"crons\":{},\"queues\":{}}" },
        "r2_buckets": [{ "binding": "WIDEFLEET_PACKAGES", "bucket_name": "widefleet-packages" }],
        "kv_namespaces": [{ "binding": "AUTH_CONFIG", "id": "widefleet-auth" }],
        "services": [],
        "durable_objects": { "bindings": [
            { "name": "WIDEFLEET_CONNECTORS", "class_name": "ConnectorCatalog" },
            { "name": "WIDEFLEET_CONNECTOR_STATE", "class_name": "ConnectorSupervisor" },
        ] },
    });
    if release.workflows == Some(1) {
        config["services"] = json!([{ "binding": "WIDEFLEET_WORKFLOW_SESSIONS", "service": "widefleet", "entrypoint": "WorkflowSessions" }]);
        config["workflows"] = json!([{ "binding": "WIDEFLEET_WORKFLOWS", "name": "widefleet-apps", "class_name": "AppWorkflow" }]);
        config["durable_objects"]["bindings"].as_array_mut().ok_or_else(|| Error::invalid("Invalid runtime object bindings".into()))?.push(json!({ "name": "WIDEFLEET_WORKFLOW_CATALOG", "class_name": "WidefleetWorkflowCatalog" }));
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn concurrent_starts_reuse_one_independent_encryption_key() -> platform_core::Result<()> {
        let store = object_store::memory::InMemory::new();
        let organization = "test-organization";
        let (first, second) = tokio::join!(
            super::connector_key(&store, organization),
            super::connector_key(&store, organization)
        );
        let first = first?;
        assert_eq!(first, second?);
        assert_eq!(first.len(), 64);
        assert_eq!(first, super::connector_key(&store, organization).await?);
        assert_ne!(
            first,
            super::connector_key(&store, "other-organization").await?
        );
        Ok(())
    }
}
