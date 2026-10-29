use super::*;
use platform_core::reporting::{Frame, Report};

fn capture(failure: Failure, preferences: Preferences) -> Vec<Value> {
    events(
        &Configuration {
            id: Uuid::nil(),
            preferences,
        },
        preferences,
        "deploy",
        Duration::from_millis(10),
        false,
        Some(failure),
    )
}

#[test]
fn expected_failures_are_usage_only() {
    let failures = [
        Error::invalid("private input".into()),
        Error::credentials("private credential path".into()),
        Error::api(401, "private response".into()),
        Error::api(429, "private response".into()),
        std::io::Error::new(std::io::ErrorKind::NotFound, "private file").into(),
        std::io::Error::new(std::io::ErrorKind::PermissionDenied, "private file").into(),
        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "private output").into(),
    ];
    for error in failures {
        let events = capture(Failure::error(&error), Preferences::default());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event"], "cli_command_completed");
        assert_eq!(events[0]["properties"]["outcome"], "failed");
        assert!(!events[0].to_string().contains("private"));
        assert!(
            capture(
                Failure::error(&error),
                Preferences {
                    usage: false,
                    crashes: true
                },
            )
            .is_empty()
        );
    }
}

#[test]
fn returned_errors_are_handled_and_respect_each_reporting_preference() {
    let error = Error::api(503, "secret-token user@example.test".into());
    for usage in [true, false] {
        for crashes in [true, false] {
            let events = capture(Failure::error(&error), Preferences { usage, crashes });
            assert_eq!(events.len(), usize::from(usage) + usize::from(crashes));
            for event in events {
                assert!(!event.to_string().contains("secret-token"));
                assert!(!event.to_string().contains("example.test"));
                assert_eq!(event["properties"]["http_status"], 503);
                if event["event"] == "$exception" {
                    let properties = &event["properties"];
                    assert_eq!(
                        properties["$issue_name"],
                        "deploy: API request failed (HTTP 503)"
                    );
                    let exception = &properties["$exception_list"][0];
                    assert_eq!(exception["mechanism"]["handled"], true);
                    assert_eq!(exception["mechanism"]["synthetic"], true);
                    assert_eq!(
                        exception["stacktrace"]["frames"][0]["filename"],
                        "crates/platform-cli/src/reporting/tests.rs"
                    );
                    assert!(
                        exception["stacktrace"]["frames"][0]
                            .get("function")
                            .is_none()
                    );
                }
            }
        }
    }
}

#[test]
fn different_api_statuses_do_not_share_an_issue() {
    let fingerprint = |status| {
        let events = capture(
            Failure::error(&Error::api(status, "private".into())),
            Preferences::default(),
        );
        events[1]["properties"]["$exception_fingerprint"].clone()
    };
    assert_eq!(fingerprint(503), fingerprint(503));
    assert_ne!(fingerprint(500), fingerprint(503));
}

#[test]
fn panics_remain_unhandled_exceptions() {
    let events = capture(
        Failure::panic(Report {
            kind: "Panic".into(),
            frames: vec![Frame {
                filename: "crates/platform-cli/src/main.rs".into(),
                lineno: 100,
                colno: Some(1),
            }],
        }),
        Preferences {
            usage: false,
            crashes: true,
        },
    );
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "$exception");
    assert_eq!(events[0]["properties"]["error_code"], "panic");
    assert_eq!(
        events[0]["properties"]["$exception_list"][0]["mechanism"]["handled"],
        false
    );
}
