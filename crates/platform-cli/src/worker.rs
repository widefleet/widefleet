use crate::migrations::Database;
use platform_core::model::{Binding, DebugMetadata, WorkerConfiguration};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Deserialize)]
pub(crate) struct Configuration {
    pub main: PathBuf,
    pub compatibility_date: String,
    #[serde(default)]
    pub compatibility_flags: Vec<String>,
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
    #[serde(default)]
    pub d1_databases: Vec<Database>,
    #[serde(default)]
    pub r2_buckets: Vec<Bucket>,
    #[serde(default)]
    pub kv_namespaces: Vec<Namespace>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bucket {
    binding: String,
    bucket_name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Namespace {
    binding: String,
    id: String,
}

impl Configuration {
    pub fn metadata(self, main_module: String, debug: DebugMetadata) -> WorkerConfiguration {
        let mut bindings = Vec::new();
        bindings.extend(
            self.vars
                .into_iter()
                .map(|(name, text)| Binding::PlainText { name, text }),
        );
        bindings.extend(self.d1_databases.into_iter().map(|db| Binding::D1 {
            name: db.binding,
            database_name: db.database_name,
            database_id: db.database_id,
        }));
        bindings.extend(self.r2_buckets.into_iter().map(|bucket| Binding::R2Bucket {
            name: bucket.binding,
            bucket_name: bucket.bucket_name,
        }));
        bindings.extend(
            self.kv_namespaces
                .into_iter()
                .map(|kv| Binding::KvNamespace {
                    name: kv.binding,
                    id: kv.id,
                }),
        );
        WorkerConfiguration {
            main_module,
            compatibility_date: self.compatibility_date,
            compatibility_flags: self.compatibility_flags,
            bindings,
            debug: Some(debug),
        }
    }
}
