use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use object_store::{ObjectStore, ObjectStoreExt, PutMode, PutOptions, path::Path};
use platform_core::{Error, Result, model::RuntimeRelease};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

// Persist independently of access credentials. Concurrent bootstrap/agent starts
// must agree on one keyring; replacing it would make published snapshots unreadable.
// The keyring uses the runtime's format: a JWK Set of 32-byte keys, active first.
pub async fn secrets_keys(store: &dyn ObjectStore, organization_id: &str) -> Result<String> {
    let path = Path::from(format!(
        "organizations/{organization_id}/app-secrets-keyring.json"
    ));
    let failure =
        |error: object_store::Error| Error::invalid(format!("Runtime key storage failed: {error}"));
    let missing = match store.head(&path).await {
        Ok(_) => false,
        Err(object_store::Error::NotFound { .. }) => true,
        Err(error) => return Err(failure(error)),
    };
    if missing {
        let random = |count: usize| {
            (0..count)
                .map(|_| Uuid::new_v4().to_string())
                .collect::<String>()
        };
        let key = Sha256::digest(random(3).as_bytes());
        let id = platform_core::sha256(random(1).as_bytes());
        let value = json!({
            "keys": [{ "kty": "oct", "kid": &id[..8], "k": URL_SAFE_NO_PAD.encode(key) }]
        })
        .to_string();
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
    // The runtime validates each key; an empty or malformed set fails here first.
    let keys = serde_json::from_str::<Value>(&value)
        .ok()
        .and_then(|keyring| keyring["keys"].as_array().map(Vec::len));
    if !keys.is_some_and(|count| count > 0) {
        return Err(Error::invalid("Invalid app secret encryption keyring".into()));
    }
    Ok(value)
}

pub fn supports_celld(version: &str) -> bool {
    // The fork adds Web Crypto operations without changing the runtime protocol.
    matches!(version, "0.6.2" | "0.6.3-widefleet.1")
}

pub fn configuration(
    release: &RuntimeRelease,
    token: &str,
    secrets_keys: &str,
    app_domain: Option<&str>,
    app_https_port: u16,
) -> Result<Value> {
    if release.protocol != 3 || release.auth != 1 || !supports_celld(&release.celld) {
        return Err(Error::invalid(
            "Unsupported runtime installation protocol or celld version".into(),
        ));
    }
    let mut config = json!({
        "name": "widefleet", "main": release.main, "no_bundle": true,
        "compatibility_date": "2026-10-01", "compatibility_flags": ["nodejs_compat"],
        "worker_loaders": [{ "binding": "WIDEFLEET_LOADER" }],
        "vars": { "WIDEFLEET_CONTROL_TOKEN": token, "WIDEFLEET_SECRETS_KEYS": secrets_keys, "WIDEFLEET_MANAGEMENT_HTTP": "true", "WIDEFLEET_CONFIGURATION": "{\"crons\":{},\"queues\":{}}" },
        "r2_buckets": [{ "binding": "WIDEFLEET_PACKAGES", "bucket_name": "widefleet-packages" }],
        "kv_namespaces": [
            { "binding": "AUTH_CONFIG", "id": "widefleet-auth" },
            { "binding": "USER_PICTURES", "id": "widefleet-user-pictures" }
        ],
        "services": [],
        "durable_objects": { "bindings": [
        ] },
    });
    if let Some(domain) = app_domain {
        let port = if app_https_port == 443 {
            String::new()
        } else {
            format!(":{app_https_port}")
        };
        config["vars"]["WIDEFLEET_WORKLOAD_ISSUER"] =
            json!(format!("https://auth.{domain}{port}/workload"));
        config["vars"]["WIDEFLEET_MCP_ORIGIN"] = json!(format!("https://mcp.{domain}{port}"));
    }
    if release.workflows == Some(1) {
        config["services"] = json!([{ "binding": "WIDEFLEET_WORKFLOW_SESSIONS", "service": "widefleet", "entrypoint": "WorkflowSessions" }]);
        config["workflows"] = json!([{ "binding": "WIDEFLEET_WORKFLOWS", "name": "widefleet-apps", "class_name": "AppWorkflow" }]);
        config["durable_objects"]["bindings"].as_array_mut().ok_or_else(|| Error::invalid("Invalid runtime object bindings".into()))?.push(json!({ "name": "WIDEFLEET_WORKFLOW_CATALOG", "class_name": "WidefleetWorkflowCatalog" }));
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    #[test]
    fn deployments_keep_the_configured_workload_issuer_and_custom_port() -> platform_core::Result<()>
    {
        let mut release = platform_core::model::RuntimeRelease {
            auth: 1,
            protocol: 3,
            version: "1.0.0".into(),
            celld: "0.6.3-widefleet.1".into(),
            workflows: None,
            cloudflare: None,
            search: None,
            main: "loader.js".into(),
            modules: vec![],
        };
        for (port, issuer) in [
            (443, "https://auth.apps.example.test/workload"),
            (25453, "https://auth.apps.example.test:25453/workload"),
        ] {
            let configured = super::configuration(
                &release,
                "control",
                "secrets",
                Some("apps.example.test"),
                port,
            )?;
            assert_eq!(configured["vars"]["WIDEFLEET_WORKLOAD_ISSUER"], issuer);
        }
        release.celld = "0.6.2".into();
        assert!(super::configuration(&release, "control", "secrets", None, 443).is_ok());
        release.celld = "0.5.0".into();
        assert!(super::configuration(&release, "control", "secrets", None, 443).is_err());
        release.celld = "0.6.3-widefleet.1".into();
        let unconfigured = super::configuration(&release, "control", "secrets", None, 443)?;
        assert!(
            unconfigured["vars"]
                .get("WIDEFLEET_WORKLOAD_ISSUER")
                .is_none()
        );
        Ok(())
    }

    #[tokio::test]
    async fn concurrent_starts_reuse_one_independent_encryption_keyring()
    -> platform_core::Result<()> {
        let store = object_store::memory::InMemory::new();
        let organization = "test-organization";
        let (first, second) = tokio::join!(
            super::secrets_keys(&store, organization),
            super::secrets_keys(&store, organization)
        );
        let first = first?;
        assert_eq!(first, second?);
        let keyring: serde_json::Value = serde_json::from_str(&first)?;
        let key = &keyring["keys"][0];
        assert_eq!(key["kty"], "oct");
        assert_eq!(key["kid"].as_str().map(str::len), Some(8));
        assert_eq!(key["k"].as_str().map(str::len), Some(43));
        assert_eq!(first, super::secrets_keys(&store, organization).await?);
        assert_ne!(
            first,
            super::secrets_keys(&store, "other-organization").await?
        );
        Ok(())
    }
}
