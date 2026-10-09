use crate::{asset_hash, http::Api, sha256};

#[test]
fn app_json_preserves_catalog_listing_and_accepts_older_servers() -> crate::Result<()> {
    let legacy = serde_json::json!({
        "id": "00000000-0000-4000-8000-000000000001",
        "slug": "catalog-app",
        "displayName": "Catalog App",
        "parentId": null,
        "fleetId": "00000000-0000-4000-8000-000000000002",
        "hostname": "catalog-app.apps.example.test",
        "url": "https://catalog-app.apps.example.test/",
        "createdAt": "2026-10-01T00:00:00.000Z",
        "state": "active",
        "activeDeploymentId": "00000000-0000-4000-8000-000000000003"
    });
    let app: crate::model::App = serde_json::from_value(legacy.clone())?;
    assert!(!app.catalog_listed);

    for listed in [true, false] {
        let mut response = legacy.clone();
        response["catalogListed"] = listed.into();
        let app: crate::model::App = serde_json::from_value(response.clone())?;
        assert_eq!(serde_json::to_value(app)?, response);
    }
    Ok(())
}

#[test]
fn hashes_match_wrangler_vectors() {
    assert_eq!(
        asset_hash("/empty", b""),
        "af1349b9f5f9a1a6a0404dea36dcc949"
    );
    assert_ne!(
        asset_hash("/file.html", b"hello"),
        asset_hash("/file.HTML", b"hello")
    );
    assert_eq!(
        asset_hash("/.env", b"hello"),
        asset_hash("/file.", b"hello")
    );
    assert_eq!(
        sha256(b"hello"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
}

#[test]
fn platform_origins_reject_insecure_or_credential_bearing_targets() {
    for url in [
        "http://example.test",
        "https://user:secret@example.test",
        "https://example.test/path",
        "https://example.test?query=1",
        "https://example.test#fragment",
        "file:///tmp/socket",
    ] {
        assert!(Api::new(url).is_err(), "Accepted {url}");
    }
    for url in [
        "http://localhost:25430",
        "http://127.0.0.1:25430",
        "http://[::1]:25430",
        "https://platform.example.test/",
    ] {
        assert!(Api::new(url).is_ok(), "Rejected {url}");
    }
}
pub(crate) fn diagnostic_fixture() -> crate::Error {
    crate::Error::invalid("private native failure".into())
}

pub(crate) fn converted_diagnostic_fixture() -> crate::Result<()> {
    let failure: std::io::Result<()> = Err(std::io::Error::other("private I/O failure"));
    failure?;
    Ok(())
}
