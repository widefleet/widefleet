use clap::{Parser, ValueEnum};
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum TlsMode {
    Provided,
    Cloudflare,
}

#[derive(Clone, Parser)]
#[command(version, about = "Poll and execute App Platform deployment jobs")]
pub struct Configuration {
    #[arg(long, env = "PLATFORM_URL")]
    pub url: String,
    /// Management origin reachable from fleet containers (defaults to PLATFORM_URL).
    #[arg(long, env = "PLATFORM_RUNTIME_PLATFORM_URL")]
    pub runtime_platform_url: Option<String>,
    #[arg(long, env = "PLATFORM_AGENT_TOKEN", hide_env_values = true)]
    pub token: String,
    #[arg(long, env = "PLATFORM_AGENT_STATE", default_value = ".local/agent")]
    pub state: PathBuf,
    /// Absolute path to the same state directory on the Docker host.
    #[arg(long, env = "PLATFORM_AGENT_HOST_STATE")]
    pub host_state: Option<PathBuf>,
    #[arg(
        long,
        env = "PLATFORM_RUNTIME_IMAGE",
        default_value = "app-platform-runtime:0.1.0"
    )]
    pub runtime_image: String,
    #[arg(long, env = "CELLD_BINARY", default_value = "celld")]
    pub celld: PathBuf,
    #[command(flatten)]
    pub storage: crate::storage::StorageOptions,
    /// Existing trusted containers to connect to the fleet's private network.
    #[arg(long, env = "PLATFORM_TRUSTED_CONTAINERS", value_delimiter = ',')]
    pub trusted_containers: Vec<String>,
    /// Traefik watches this persistent directory independently of the agent.
    #[arg(long, env = "PLATFORM_ROUTING_DIRECTORY")]
    pub routing_directory: PathBuf,
    /// Private Traefik HTTPS origin reachable from fleet containers for access-rule verification.
    #[arg(
        long,
        env = "PLATFORM_PROXY_URL",
        default_value = "https://app-platform-proxy:8443"
    )]
    pub proxy_url: String,
    /// OAuth2 Proxy endpoint as reached by Traefik.
    #[arg(
        long,
        env = "PLATFORM_APP_AUTH_URL",
        default_value = "http://oauth2-proxy:4180/"
    )]
    pub app_auth_url: String,
    /// Match the certificate mode configured for Traefik.
    #[arg(long, env = "TLS_MODE", default_value = "provided")]
    pub tls_mode: TlsMode,
    /// App namespace used to request preview wildcard certificates.
    #[arg(long, env = "APP_DOMAIN", required_if_eq("tls_mode", "cloudflare"))]
    pub app_domain: Option<String>,
    #[arg(long, default_value_t = 3)]
    pub poll_seconds: u64,
    /// Handle at most one job, useful for a local integration test.
    #[arg(long)]
    pub once: bool,
}
