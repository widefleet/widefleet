use platform_core::{
    Error, ErrorKind, FailureCategory,
    reporting::{self, Report},
};

pub struct Failure {
    pub(super) report: Report,
    pub(super) code: &'static str,
    pub(super) summary: String,
    pub(super) http_status: Option<u16>,
    pub(super) api_code: Option<String>,
    pub(super) category: FailureCategory,
}

impl Failure {
    pub fn error(error: &Error) -> Self {
        // Use structured categories only. Error messages and source chains can
        // contain credentials, response bodies, private paths and signed URLs.
        let (code, summary, category) = error
            .reason()
            .map(|reason| reason.diagnostic())
            .unwrap_or_else(|| match error.kind() {
                ErrorKind::Invalid(_) => (
                    "unclassified_invalid",
                    "Unclassified operation failure",
                    FailureCategory::Unknown,
                ),
                ErrorKind::Credentials(_) => (
                    "unclassified_credentials",
                    "Credential operation failed",
                    FailureCategory::Unknown,
                ),
                // The server names a code only for its own decisions. A missing
                // code means another component, such as a proxy, answered.
                ErrorKind::Api {
                    status,
                    code: Some(code),
                    ..
                } if (400..500).contains(status) => match code.as_str() {
                    "INVALID_REQUEST" => (
                        "api_invalid_request",
                        "Request does not match the API contract",
                        FailureCategory::Technical,
                    ),
                    "ROUTE_NOT_FOUND" => (
                        "api_route_not_found",
                        "API route does not exist",
                        FailureCategory::Technical,
                    ),
                    _ => (
                        "api_rejected",
                        "API rejected the request",
                        FailureCategory::Usage,
                    ),
                },
                ErrorKind::Api { status, .. } if (400..500).contains(status) => (
                    "api_rejected",
                    "API rejected the request",
                    FailureCategory::Unknown,
                ),
                ErrorKind::Api { .. } => (
                    "api_failure",
                    "API request failed",
                    FailureCategory::Technical,
                ),
                ErrorKind::Http(error)
                    if error
                        .status()
                        .is_some_and(|status| status.is_client_error()) =>
                {
                    (
                        "http_rejected",
                        "HTTP request rejected",
                        FailureCategory::Unknown,
                    )
                }
                ErrorKind::Http(error) if error.is_timeout() => (
                    "http_timeout",
                    "HTTP request timed out",
                    FailureCategory::Technical,
                ),
                ErrorKind::Http(error) if error.is_connect() => (
                    "http_connect",
                    "HTTP connection failed",
                    FailureCategory::Technical,
                ),
                ErrorKind::Http(error) if error.is_decode() => (
                    "http_decode",
                    "HTTP response could not be decoded",
                    FailureCategory::Technical,
                ),
                ErrorKind::Http(_) => (
                    "http_failure",
                    "HTTP request failed",
                    FailureCategory::Technical,
                ),
                ErrorKind::Io(error) => match error.kind() {
                    std::io::ErrorKind::NotFound => (
                        "io_not_found",
                        "Local file not found",
                        FailureCategory::Unknown,
                    ),
                    std::io::ErrorKind::PermissionDenied => (
                        "io_permission_denied",
                        "Local file access denied",
                        FailureCategory::Unknown,
                    ),
                    std::io::ErrorKind::AlreadyExists => (
                        "io_already_exists",
                        "Local file already exists",
                        FailureCategory::Unknown,
                    ),
                    std::io::ErrorKind::BrokenPipe => (
                        "io_broken_pipe",
                        "Output pipe closed",
                        FailureCategory::Unknown,
                    ),
                    std::io::ErrorKind::Interrupted => (
                        "io_interrupted",
                        "I/O interrupted",
                        FailureCategory::Unknown,
                    ),
                    _ => (
                        "io_failure",
                        "I/O operation failed",
                        FailureCategory::Technical,
                    ),
                },
                ErrorKind::Json(_) => (
                    "json_decode",
                    "JSON did not match the expected format",
                    FailureCategory::Technical,
                ),
            });
        let http_status = match error.kind() {
            ErrorKind::Api { status, .. } => Some(*status),
            ErrorKind::Http(error) => error.status().map(|status| status.as_u16()),
            _ => None,
        };
        let api_code = match error.kind() {
            ErrorKind::Api { code, .. } => code.clone(),
            _ => None,
        };
        Self {
            report: reporting::error(error),
            code,
            summary: match http_status {
                Some(status) => format!("{summary} (HTTP {status})"),
                None => summary.into(),
            },
            http_status,
            api_code,
            category,
        }
    }

    pub fn panic(report: Report) -> Self {
        Self {
            report,
            code: "panic",
            summary: "CLI panicked".into(),
            http_status: None,
            api_code: None,
            category: FailureCategory::Technical,
        }
    }
}
