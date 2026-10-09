use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub catalog_listed: bool,
    pub parent_id: Option<Uuid>,
    pub fleet_id: Uuid,
    pub hostname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub created_at: String,
    pub state: String,
    pub active_deployment_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub id: Uuid,
    pub app_id: Uuid,
    pub artifact_id: Uuid,
    pub status: String,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Asset {
    pub hash: String,
    pub size: u64,
}
pub type AssetManifest = BTreeMap<String, Asset>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSession {
    pub id: Uuid,
    pub url: Option<String>,
    pub expires_at: String,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Binding {
    Workflow {
        name: String,
        workflow_name: String,
        class_name: String,
    },
    PlainText {
        name: String,
        text: String,
    },
    D1 {
        name: String,
        database_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        database_id: Option<String>,
    },
    KvNamespace {
        name: String,
        id: String,
    },
    Queue {
        name: String,
        queue: String,
    },
    R2Bucket {
        name: String,
        bucket_name: String,
    },
}

impl Binding {
    pub fn name(&self) -> &str {
        match self {
            Self::PlainText { name, .. }
            | Self::Workflow { name, .. }
            | Self::D1 { name, .. }
            | Self::KvNamespace { name, .. }
            | Self::Queue { name, .. }
            | Self::R2Bucket { name, .. } => name,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueueConsumer {
    pub queue: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_batch_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_batch_timeout: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_delay: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dead_letter_queue: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkerAssets {
    pub upload_session: Uuid,
    pub binding: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkerMetadata {
    pub main_module: String,
    pub compatibility_date: String,
    pub compatibility_flags: Vec<String>,
    pub bindings: Vec<Binding>,
    #[serde(default)]
    pub crons: Vec<String>,
    #[serde(default)]
    pub queue_consumers: Vec<QueueConsumer>,
    pub assets: WorkerAssets,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug: Option<DebugMetadata>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DebugMetadata {
    pub build_id: String,
    pub source_maps: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModuleType {
    Esm,
    Wasm,
    Text,
    Data,
    Sourcemap,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Module {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ModuleType,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: Uuid,
    pub app_id: Uuid,
    pub metadata: WorkerMetadata,
    pub manifest: AssetManifest,
    pub modules: Vec<Module>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Deploy,
    Runtime,
    Connector,
    Delete,
    Configure,
    Migrations,
    Workflows,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub fleet_id: Uuid,
    pub id: Uuid,
    pub kind: JobKind,
    pub migration: Option<crate::migrations::ArtifactReference>,
    pub access: Option<AppAccessSnapshot>,
    pub workflow: Option<serde_json::Value>,
    pub network: Option<NetworkSnapshot>,
    pub capabilities: Option<CapabilitySnapshot>,
    pub app_id: Option<Uuid>,
    pub hostname: Option<String>,
    pub deployment_id: Option<Uuid>,
    pub artifact_id: Option<Uuid>,
    pub attempt: u32,
    pub lease_token: Uuid,
    pub lease_until: String,
}

impl Job {
    pub fn app_id(&self) -> crate::Result<Uuid> {
        self.app_id
            .ok_or_else(|| crate::Error::invalid("This job has no app".into()))
    }

    pub fn hostname(&self) -> crate::Result<&str> {
        self.hostname
            .as_deref()
            .ok_or_else(|| crate::Error::invalid("This job has no hostname".into()))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppAccessSnapshot {
    pub revision: u64,
    pub groups: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NetworkPolicy {
    pub backend: Vec<String>,
    pub browser: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NetworkSnapshot {
    pub revision: u64,
    pub policy: NetworkPolicy,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CapabilityGrant {
    pub connector: String,
    pub entrypoint: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CapabilitySnapshot {
    pub revision: u64,
    pub grants: BTreeMap<String, CapabilityGrant>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedApp {
    #[serde(flatten)]
    pub artifact: Artifact,
    pub version: Uuid,
    pub deployment_id: Uuid,
    pub hostname: String,
    pub native_bindings: BTreeMap<String, String>,
    pub network: NetworkSnapshot,
    #[serde(default)]
    pub capabilities: BTreeMap<String, String>,
    #[serde(default)]
    pub capability_revision: u64,
    pub telemetry: Option<TelemetryDestination>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelemetryDestination {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReleaseModule {
    pub name: String,
    pub source: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuntimeRelease {
    pub protocol: u32,
    pub version: String,
    pub celld: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflows: Option<u32>,
    pub main: String,
    pub modules: Vec<ReleaseModule>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuntimePackages {
    pub runtime: RuntimeRelease,
    #[serde(default)]
    pub connectors: Vec<ConnectorPackage>,
    #[serde(default, rename = "connectorSecrets")]
    pub connector_secrets: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConnectorPackage {
    pub protocol: u32,
    pub name: String,
    pub main: String,
    pub modules: Vec<ReleaseModule>,
    pub entrypoints: Vec<String>,
    pub configuration: serde_json::Value,
}
