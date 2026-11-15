use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCategory {
    Cancelled,
    Usage,
    Technical,
    Unknown,
}

// Only explicitly identified outcomes can suppress an exception. The legacy
// error kinds also contain protocol and platform faults, so they are not enough.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureReason {
    DeploymentWaitCancelled,
    LoginDenied,
    LoginExpired,
    DiscoveryExpired,
    LoginRequired,
    InvalidLoginScope,
    PlatformNotConfigured,
    EmptyAccessToken,
    SessionPlatformMismatch,
    SessionPermissions,
    SessionPathInvalid,
    InvalidAppName,
    AppNameMissing,
    SettingsRestartUnacknowledged,
    SettingsNotObject,
    InvalidDomain,
    InvalidEmail,
    CredentialStoreUnavailable,
    CredentialReadFailed,
    CredentialWriteFailed,
    CredentialDeleteFailed,
    SessionCorrupt,
    SessionChanged,
    IncompleteCredentials,
    InvalidLoginResponse,
    DeploymentFailed,
    DeploymentMissing,
    DeploymentStatusInvalid,
    AssetManifestMismatch,
}

impl FailureReason {
    pub fn diagnostic(self) -> (&'static str, &'static str, FailureCategory) {
        use FailureCategory::{Cancelled, Technical, Usage};
        match self {
            Self::DeploymentWaitCancelled => (
                "deployment_wait_cancelled",
                "Stopped waiting for deployment",
                Cancelled,
            ),
            Self::LoginDenied => ("login_denied", "Device login was denied", Usage),
            Self::LoginExpired => ("login_expired", "Device login expired", Usage),
            Self::DiscoveryExpired => ("discovery_expired", "Company discovery expired", Usage),
            Self::LoginRequired => ("login_required", "No saved login is available", Usage),
            Self::InvalidLoginScope => (
                "invalid_login_scope",
                "Login scope format is invalid",
                Usage,
            ),
            Self::PlatformNotConfigured => (
                "platform_not_configured",
                "No platform is configured",
                Usage,
            ),
            Self::EmptyAccessToken => (
                "empty_access_token",
                "Configured access token is empty",
                Usage,
            ),
            Self::SessionPlatformMismatch => (
                "session_platform_mismatch",
                "Session belongs to another platform",
                Usage,
            ),
            Self::SessionPermissions => (
                "session_permissions",
                "Session storage permissions are unsafe",
                Usage,
            ),
            Self::SessionPathInvalid => (
                "session_path_invalid",
                "Session storage path is invalid",
                Usage,
            ),
            Self::InvalidAppName => ("invalid_app_name", "App name is invalid", Usage),
            Self::AppNameMissing => ("app_name_missing", "App name is missing", Usage),
            Self::SettingsRestartUnacknowledged => (
                "settings_restart_unacknowledged",
                "Settings restart needs acknowledgement",
                Usage,
            ),
            Self::SettingsNotObject => (
                "settings_not_object",
                "Settings must be a JSON object",
                Usage,
            ),
            Self::InvalidDomain => ("invalid_domain", "Company domain format is invalid", Usage),
            Self::InvalidEmail => ("invalid_email", "Work email format is invalid", Usage),
            Self::CredentialStoreUnavailable => (
                "credential_store_unavailable",
                "Credential store is unavailable",
                Technical,
            ),
            Self::CredentialReadFailed => (
                "credential_read_failed",
                "Stored credentials could not be read",
                Technical,
            ),
            Self::CredentialWriteFailed => (
                "credential_write_failed",
                "Credentials could not be saved",
                Technical,
            ),
            Self::CredentialDeleteFailed => (
                "credential_delete_failed",
                "Credentials could not be deleted",
                Technical,
            ),
            Self::SessionCorrupt => ("session_corrupt", "Stored session is malformed", Technical),
            Self::SessionChanged => (
                "session_changed",
                "Session file changed while opening",
                Technical,
            ),
            Self::IncompleteCredentials => (
                "incomplete_credentials",
                "OAuth server returned incomplete credentials",
                Technical,
            ),
            Self::InvalidLoginResponse => (
                "invalid_login_response",
                "Login server returned an invalid response",
                Technical,
            ),
            Self::DeploymentFailed => ("deployment_failed", "Deployment failed", Technical),
            Self::DeploymentMissing => (
                "deployment_missing",
                "Deployment disappeared from history",
                Technical,
            ),
            Self::DeploymentStatusInvalid => (
                "deployment_status_invalid",
                "Server returned an unknown deployment status",
                Technical,
            ),
            Self::AssetManifestMismatch => (
                "asset_manifest_mismatch",
                "Server requested an asset outside the manifest",
                Technical,
            ),
        }
    }
}
