use bollard::models::{Mount, MountType};
use clap::{Args, ValueEnum};
use object_store::{
    ObjectStore, aws::AmazonS3Builder, azure::MicrosoftAzureBuilder, gcp::GoogleCloudStorageBuilder,
};
use platform_core::{Error, Result};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

const RUNTIME_CREDENTIAL: &str = "/run/widefleet/storage-credential";

#[derive(Clone, Copy, Default, PartialEq, Eq, ValueEnum)]
pub enum Provider {
    #[default]
    S3,
    Azure,
    Gcs,
}

#[derive(Clone, Default, Args)]
pub struct StorageOptions {
    #[arg(long, env = "FLEET_STORAGE_PROVIDER", value_enum, default_value = "s3")]
    pub storage_provider: Provider,
    #[arg(long, env = "FLEET_S3_ENDPOINT")]
    pub fleet_endpoint: Option<String>,
    #[arg(long, env = "FLEET_RUNTIME_S3_ENDPOINT")]
    pub runtime_endpoint: Option<String>,
    #[arg(long, env = "FLEET_S3_BUCKET")]
    pub fleet_bucket: Option<String>,
    #[arg(long, env = "FLEET_S3_REGION")]
    pub fleet_region: Option<String>,
    #[arg(long, env = "FLEET_S3_ACCESS_KEY_ID", hide_env_values = true)]
    pub fleet_access_key: Option<String>,
    #[arg(long, env = "FLEET_S3_SECRET_ACCESS_KEY", hide_env_values = true)]
    pub fleet_secret_key: Option<String>,
    #[arg(long, env = "FLEET_AZURE_CONTAINER")]
    pub azure_container: Option<String>,
    #[arg(long, env = "AZURE_STORAGE_ACCOUNT_NAME")]
    pub azure_account: Option<String>,
    #[arg(long, env = "AZURE_STORAGE_ACCESS_KEY", hide_env_values = true)]
    pub azure_access_key: Option<String>,
    #[arg(long, env = "AZURE_CLIENT_ID")]
    pub azure_client_id: Option<String>,
    #[arg(long, env = "AZURE_TENANT_ID")]
    pub azure_tenant_id: Option<String>,
    #[arg(long, env = "AZURE_FEDERATED_TOKEN_FILE")]
    pub azure_token_file: Option<PathBuf>,
    #[arg(long, env = "FLEET_GCS_BUCKET")]
    pub gcs_bucket: Option<String>,
    #[arg(long, env = "GOOGLE_APPLICATION_CREDENTIALS")]
    pub google_credentials: Option<PathBuf>,
    /// Docker-host path of the credential file, mounted read-only into app runtimes.
    #[arg(long, env = "FLEET_CREDENTIAL_HOST_FILE")]
    pub credential_host_file: Option<PathBuf>,
}

#[derive(Clone)]
pub struct CredentialFile {
    local: PathBuf,
    host: PathBuf,
}

#[derive(Clone)]
pub enum AzureIdentity {
    Key(String),
    Managed(Option<String>),
    Workload {
        client_id: String,
        tenant_id: String,
        token: CredentialFile,
    },
}

#[derive(Clone)]
pub enum FleetStorage {
    S3 {
        endpoint: String,
        runtime_endpoint: String,
        bucket: String,
        region: String,
        access_key: String,
        secret_key: String,
    },
    Azure {
        account: String,
        container: String,
        identity: AzureIdentity,
    },
    Gcs {
        bucket: String,
        credentials: Option<CredentialFile>,
    },
}

fn invalid(message: &str) -> Error {
    Error::invalid(message.into())
}
fn required(value: &Option<String>, name: &str) -> Result<String> {
    value
        .as_ref()
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| {
            invalid(&format!(
                "{name} is required for the selected fleet storage provider"
            ))
        })
}
fn name(value: &Option<String>, label: &str) -> Result<String> {
    let value = required(value, label)?;
    if value.len() < 3
        || value.len() > 222
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-_".contains(&byte)
        })
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
    {
        return Err(invalid(&format!(
            "{label} must be a bucket/container name without a path"
        )));
    }
    Ok(value)
}
fn credential_file(local: &Path, host: &Option<PathBuf>) -> Result<CredentialFile> {
    let host = host.as_ref().ok_or_else(|| {
        invalid("FLEET_CREDENTIAL_HOST_FILE is required when fleet authentication uses a file")
    })?;
    if !local.is_absolute()
        || !host.is_absolute()
        || local.to_str().is_none()
        || host.to_str().is_none()
    {
        return Err(invalid(
            "Fleet credential paths must be absolute UTF-8 paths",
        ));
    }
    if !local.is_file() {
        return Err(invalid(
            "The configured fleet credential file is not a readable regular file",
        ));
    }
    std::fs::File::open(local)?;
    Ok(CredentialFile {
        local: local.into(),
        host: host.clone(),
    })
}

impl StorageOptions {
    pub fn resolve(&self) -> Result<FleetStorage> {
        let s3_present = self.fleet_endpoint.is_some()
            || self.runtime_endpoint.is_some()
            || self.fleet_bucket.is_some()
            || self.fleet_region.is_some()
            || self.fleet_access_key.is_some()
            || self.fleet_secret_key.is_some();
        let azure_present = self.azure_container.is_some()
            || self.azure_account.is_some()
            || self.azure_access_key.is_some()
            || self.azure_client_id.is_some()
            || self.azure_tenant_id.is_some()
            || self.azure_token_file.is_some();
        let gcs_present = self.gcs_bucket.is_some() || self.google_credentials.is_some();
        if (self.storage_provider != Provider::S3 && s3_present)
            || (self.storage_provider != Provider::Azure && azure_present)
            || (self.storage_provider != Provider::Gcs && gcs_present)
        {
            return Err(invalid(
                "Fleet storage contains settings for an unselected provider",
            ));
        }
        if self.credential_host_file.is_some()
            && self.azure_token_file.is_none()
            && self.google_credentials.is_none()
        {
            return Err(invalid(
                "FLEET_CREDENTIAL_HOST_FILE requires an Azure or Google credential file",
            ));
        }
        match self.storage_provider {
            Provider::S3 => {
                let endpoint = required(&self.fleet_endpoint, "FLEET_S3_ENDPOINT")?;
                Ok(FleetStorage::S3 {
                    runtime_endpoint: self
                        .runtime_endpoint
                        .clone()
                        .unwrap_or_else(|| endpoint.clone()),
                    endpoint,
                    bucket: name(&self.fleet_bucket, "FLEET_S3_BUCKET")?,
                    region: self
                        .fleet_region
                        .clone()
                        .unwrap_or_else(|| "us-east-1".into()),
                    access_key: required(&self.fleet_access_key, "FLEET_S3_ACCESS_KEY_ID")?,
                    secret_key: required(&self.fleet_secret_key, "FLEET_S3_SECRET_ACCESS_KEY")?,
                })
            }
            Provider::Azure => {
                let account = required(&self.azure_account, "AZURE_STORAGE_ACCOUNT_NAME")?;
                if !(3..=24).contains(&account.len())
                    || !account
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                {
                    return Err(invalid("Invalid AZURE_STORAGE_ACCOUNT_NAME"));
                }
                let container = name(&self.azure_container, "FLEET_AZURE_CONTAINER")?;
                if container.len() > 63
                    || container.contains(['.', '_'])
                    || container.contains("--")
                {
                    return Err(invalid("Invalid FLEET_AZURE_CONTAINER"));
                }
                for id in [&self.azure_client_id, &self.azure_tenant_id]
                    .into_iter()
                    .flatten()
                {
                    Uuid::parse_str(id)
                        .map_err(|_| invalid("Azure client and tenant IDs must be UUIDs"))?;
                }
                let workload = self.azure_tenant_id.is_some() || self.azure_token_file.is_some();
                let identity = if self.azure_access_key.is_some() {
                    if self.azure_client_id.is_some() || workload {
                        return Err(invalid(
                            "Choose an Azure account key or an identity, not both",
                        ));
                    }
                    AzureIdentity::Key(required(
                        &self.azure_access_key,
                        "AZURE_STORAGE_ACCESS_KEY",
                    )?)
                } else if workload {
                    AzureIdentity::Workload {
                        client_id: required(&self.azure_client_id, "AZURE_CLIENT_ID")?,
                        tenant_id: required(&self.azure_tenant_id, "AZURE_TENANT_ID")?,
                        token: credential_file(
                            self.azure_token_file.as_ref().ok_or_else(|| {
                                invalid(
                                    "AZURE_FEDERATED_TOKEN_FILE is required for workload identity",
                                )
                            })?,
                            &self.credential_host_file,
                        )?,
                    }
                } else {
                    AzureIdentity::Managed(self.azure_client_id.clone())
                };
                Ok(FleetStorage::Azure {
                    account,
                    container,
                    identity,
                })
            }
            Provider::Gcs => Ok(FleetStorage::Gcs {
                bucket: name(&self.gcs_bucket, "FLEET_GCS_BUCKET")?,
                credentials: self
                    .google_credentials
                    .as_ref()
                    .map(|file| credential_file(file, &self.credential_host_file))
                    .transpose()?,
            }),
        }
    }
}

impl FleetStorage {
    pub fn verify_runtime(
        &self,
        app_id: Uuid,
        arguments: &[String],
        environment: &[String],
    ) -> Result<()> {
        for expected in self.arguments(app_id, true).as_chunks::<2>().0 {
            if !arguments.windows(2).any(|actual| actual == expected) {
                return Err(invalid(
                    "The existing app uses different fleet storage; migrate its data and runtime explicitly before changing storage configuration",
                ));
            }
        }
        if let Self::Azure { account, .. } = self
            && !environment.contains(&format!("AZURE_STORAGE_ACCOUNT_NAME={account}"))
        {
            return Err(invalid(
                "The existing app uses a different Azure storage account; an explicit storage migration is required",
            ));
        }

        Ok(())
    }

    pub fn bucket_url(&self, app_id: Uuid) -> String {
        let (scheme, bucket) = match self {
            Self::S3 { bucket, .. } => ("s3", bucket),
            Self::Azure { container, .. } => ("az", container),
            Self::Gcs { bucket, .. } => ("gs", bucket),
        };
        format!("{scheme}://{bucket}/fleets/{app_id}")
    }
    pub fn arguments(&self, app_id: Uuid, runtime: bool) -> Vec<String> {
        let mut args = vec!["--bucket".into(), self.bucket_url(app_id)];
        if let Self::S3 {
            endpoint,
            runtime_endpoint,
            region,
            ..
        } = self
        {
            args.extend([
                "--endpoint".into(),
                if runtime { runtime_endpoint } else { endpoint }.clone(),
                "--region".into(),
                region.clone(),
            ]);
        }
        args
    }
    fn credential_file(&self) -> Option<&CredentialFile> {
        match self {
            Self::Azure {
                identity: AzureIdentity::Workload { token, .. },
                ..
            } => Some(token),
            Self::Gcs { credentials, .. } => credentials.as_ref(),
            _ => None,
        }
    }
    pub fn credential_mount(&self) -> Option<Mount> {
        self.credential_file().map(|file| Mount {
            typ: Some(MountType::BIND),
            source: Some(file.host.to_string_lossy().into()),
            target: Some(RUNTIME_CREDENTIAL.into()),
            read_only: Some(true),
            ..Default::default()
        })
    }
    pub fn environment(&self, runtime: bool) -> Vec<(String, String)> {
        let path = |file: &CredentialFile| {
            if runtime {
                RUNTIME_CREDENTIAL.into()
            } else {
                file.local.to_string_lossy().into_owned()
            }
        };
        match self {
            Self::S3 {
                access_key,
                secret_key,
                ..
            } => vec![
                ("AWS_ACCESS_KEY_ID".into(), access_key.clone()),
                ("AWS_SECRET_ACCESS_KEY".into(), secret_key.clone()),
            ],
            Self::Azure {
                account, identity, ..
            } => {
                let mut env = vec![("AZURE_STORAGE_ACCOUNT_NAME".into(), account.clone())];
                match identity {
                    AzureIdentity::Key(key) => {
                        env.push(("AZURE_STORAGE_ACCESS_KEY".into(), key.clone()))
                    }
                    AzureIdentity::Managed(client_id) => {
                        if let Some(id) = client_id {
                            env.push(("AZURE_CLIENT_ID".into(), id.clone()));
                        }
                    }
                    AzureIdentity::Workload {
                        client_id,
                        tenant_id,
                        token,
                    } => env.extend([
                        ("AZURE_CLIENT_ID".into(), client_id.clone()),
                        ("AZURE_TENANT_ID".into(), tenant_id.clone()),
                        ("AZURE_FEDERATED_TOKEN_FILE".into(), path(token)),
                    ]),
                }
                env
            }
            Self::Gcs { credentials, .. } => credentials
                .as_ref()
                .map(|file| vec![("GOOGLE_APPLICATION_CREDENTIALS".into(), path(file))])
                .unwrap_or_default(),
        }
    }
    pub fn object_store(&self) -> Result<Arc<dyn ObjectStore>> {
        let store: Arc<dyn ObjectStore> = match self {
            Self::S3 {
                endpoint,
                bucket,
                region,
                access_key,
                secret_key,
                ..
            } => Arc::new(
                AmazonS3Builder::new()
                    .with_bucket_name(bucket)
                    .with_endpoint(endpoint)
                    .with_region(region)
                    .with_access_key_id(access_key)
                    .with_secret_access_key(secret_key)
                    .with_allow_http(endpoint.starts_with("http://"))
                    .build()
                    .map_err(storage_error)?,
            ),
            Self::Azure {
                account,
                container,
                identity,
            } => {
                let mut builder = MicrosoftAzureBuilder::new()
                    .with_account(account)
                    .with_container_name(container);
                match identity {
                    AzureIdentity::Key(key) => builder = builder.with_access_key(key),
                    AzureIdentity::Managed(client_id) => {
                        if let Some(id) = client_id {
                            builder = builder.with_client_id(id);
                        }
                    }
                    AzureIdentity::Workload {
                        client_id,
                        tenant_id,
                        token,
                    } => {
                        builder = builder
                            .with_client_id(client_id)
                            .with_tenant_id(tenant_id)
                            .with_federated_token_file(token.local.to_string_lossy())
                    }
                }
                Arc::new(builder.build().map_err(storage_error)?)
            }
            Self::Gcs {
                bucket,
                credentials,
            } => {
                let mut builder = GoogleCloudStorageBuilder::new().with_bucket_name(bucket);
                if let Some(file) = credentials {
                    builder = builder.with_application_credentials(file.local.to_string_lossy());
                }
                Arc::new(builder.build().map_err(storage_error)?)
            }
        };
        Ok(store)
    }
}
fn storage_error(error: object_store::Error) -> Error {
    Error::invalid(format!("Fleet storage configuration failed: {error}"))
}

#[cfg(test)]
mod tests;
