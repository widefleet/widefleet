use platform_core::{
    Error, ErrorKind,
    reporting::{self, Report},
};

pub struct Failure {
    pub(super) report: Report,
    pub(super) code: &'static str,
    pub(super) summary: String,
    pub(super) http_status: Option<u16>,
    pub(super) expected: bool,
}

impl Failure {
    pub fn error(error: &Error) -> Self {
        // Use structured categories only. Error messages and source chains can
        // contain credentials, response bodies, private paths and signed URLs.
        let (code, summary, expected) = match error.kind() {
            ErrorKind::Invalid(_) => ("invalid_input", "Invalid input or configuration", true),
            ErrorKind::Credentials(_) => ("credentials", "Local credentials unavailable", true),
            ErrorKind::Api { status, .. } if (400..500).contains(status) => {
                ("api_rejected", "API rejected the request", true)
            }
            ErrorKind::Api { .. } => ("api_failure", "API request failed", false),
            ErrorKind::Http(error) if error.is_timeout() => {
                ("http_timeout", "HTTP request timed out", false)
            }
            ErrorKind::Http(error) if error.is_connect() => {
                ("http_connect", "HTTP connection failed", false)
            }
            ErrorKind::Http(error) if error.is_decode() => {
                ("http_decode", "HTTP response could not be decoded", false)
            }
            ErrorKind::Http(_) => ("http_failure", "HTTP request failed", false),
            ErrorKind::Io(error) => match error.kind() {
                std::io::ErrorKind::NotFound => ("io_not_found", "Local file not found", true),
                std::io::ErrorKind::PermissionDenied => {
                    ("io_permission_denied", "Local file access denied", true)
                }
                std::io::ErrorKind::AlreadyExists => {
                    ("io_already_exists", "Local file already exists", true)
                }
                std::io::ErrorKind::BrokenPipe => ("io_broken_pipe", "Output pipe closed", true),
                std::io::ErrorKind::Interrupted => ("io_interrupted", "I/O interrupted", true),
                _ => ("io_failure", "I/O operation failed", false),
            },
            ErrorKind::Json(_) => (
                "json_decode",
                "JSON did not match the expected format",
                false,
            ),
        };
        let http_status = match error.kind() {
            ErrorKind::Api { status, .. } => Some(*status),
            ErrorKind::Http(error) => error.status().map(|status| status.as_u16()),
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
            expected,
        }
    }

    pub fn panic(report: Report) -> Self {
        Self {
            report,
            code: "panic",
            summary: "CLI panicked".into(),
            http_status: None,
            expected: false,
        }
    }
}
