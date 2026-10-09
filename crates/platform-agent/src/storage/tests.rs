use super::*;

fn s3() -> StorageOptions {
    StorageOptions {
        fleet_endpoint: Some("http://localhost:9000".into()),
        runtime_endpoint: Some("http://storage:9000".into()),
        fleet_bucket: Some("fleet-test".into()),
        fleet_access_key: Some("test-key".into()),
        fleet_secret_key: Some("test-secret".into()),
        ..Default::default()
    }
}
fn azure() -> StorageOptions {
    StorageOptions {
        storage_provider: Provider::Azure,
        azure_account: Some("testaccount".into()),
        azure_container: Some("fleet-test".into()),
        ..Default::default()
    }
}
fn gcs() -> StorageOptions {
    StorageOptions {
        storage_provider: Provider::Gcs,
        gcs_bucket: Some("fleet-test".into()),
        ..Default::default()
    }
}

#[test]
fn preserves_s3_defaults_and_distinct_agent_and_runtime_endpoints() -> Result<()> {
    let storage = s3().resolve()?;
    let app = Uuid::nil();
    assert_eq!(
        storage.bucket_url(app),
        format!("s3://fleet-test/fleets/{app}")
    );
    assert_eq!(
        storage.arguments(app, false),
        [
            "--bucket",
            &storage.bucket_url(app),
            "--endpoint",
            "http://localhost:9000",
            "--region",
            "us-east-1"
        ]
    );
    assert_eq!(storage.arguments(app, true)[3], "http://storage:9000");
    assert_eq!(storage.environment(false), storage.environment(true));
    assert!(storage.credential_mount().is_none());
    assert!(storage.object_store().is_ok());
    Ok(())
}

#[test]
fn cloud_backends_use_native_bucket_schemes_without_s3_flags_or_keys() -> Result<()> {
    for (options, scheme) in [(azure(), "az"), (gcs(), "gs")] {
        let storage = options.resolve()?;
        let expected = format!("{scheme}://fleet-test/fleets/{}", Uuid::nil());
        assert_eq!(
            storage.arguments(Uuid::nil(), false),
            ["--bucket", &expected]
        );
        assert_eq!(
            storage.arguments(Uuid::nil(), false),
            storage.arguments(Uuid::nil(), true)
        );
        assert!(
            !storage
                .environment(true)
                .iter()
                .any(|(key, _)| key.starts_with("AWS_"))
        );
    }
    Ok(())
}

#[test]
fn validates_provider_configuration_before_any_job() {
    assert!(StorageOptions::default().resolve().is_err());
    let mut options = azure();
    options.fleet_endpoint = Some("http://unrelated-s3:9000".into());
    assert!(options.resolve().is_err());
    let mut options = gcs();
    options.gcs_bucket = Some("bucket/another-prefix".into());
    assert!(options.resolve().is_err());
    let mut options = azure();
    options.azure_container = Some("invalid_container".into());
    assert!(options.resolve().is_err());
}

#[test]
fn azure_supports_account_keys_and_explicit_managed_identities() -> Result<()> {
    let mut options = azure();
    options.azure_access_key = Some("dGVzdC1rZXk=".into());
    let storage = options.resolve()?;
    assert!(
        storage
            .environment(true)
            .contains(&("AZURE_STORAGE_ACCESS_KEY".into(), "dGVzdC1rZXk=".into()))
    );
    assert!(storage.object_store().is_ok());
    options.azure_client_id = Some(Uuid::nil().to_string());
    assert!(options.resolve().is_err());
    options.azure_access_key = None;
    let storage = options.resolve()?;
    assert!(
        storage
            .environment(true)
            .contains(&("AZURE_CLIENT_ID".into(), Uuid::nil().to_string()))
    );
    options.azure_tenant_id = Some(Uuid::nil().to_string());
    assert!(options.resolve().is_err());
    Ok(())
}

#[test]
fn credential_files_are_explicit_read_only_docker_host_mounts() -> Result<()> {
    let file = tempfile::NamedTempFile::new()?;
    let host = PathBuf::from("/srv/widefleet/identity.json");
    let mut options = gcs();
    options.google_credentials = Some(file.path().into());
    assert!(options.resolve().is_err());
    options.credential_host_file = Some(host.clone());
    let storage = options.resolve()?;
    assert_eq!(
        storage.environment(false),
        vec![(
            "GOOGLE_APPLICATION_CREDENTIALS".into(),
            file.path().to_string_lossy().into_owned()
        )]
    );
    assert_eq!(
        storage.environment(true),
        vec![(
            "GOOGLE_APPLICATION_CREDENTIALS".into(),
            RUNTIME_CREDENTIAL.into()
        )]
    );
    let mount = storage
        .credential_mount()
        .ok_or_else(|| invalid("Missing credential mount"))?;
    assert_eq!(mount.source.as_deref(), host.to_str());
    assert_eq!(mount.target.as_deref(), Some(RUNTIME_CREDENTIAL));
    assert_eq!(mount.read_only, Some(true));
    assert_eq!(mount.typ, Some(MountType::BIND));
    Ok(())
}

#[test]
fn azure_workload_identity_mounts_the_live_token_file() -> Result<()> {
    let file = tempfile::NamedTempFile::new()?;
    let mut options = azure();
    options.azure_client_id = Some(Uuid::nil().to_string());
    options.azure_tenant_id = Some(Uuid::nil().to_string());
    options.azure_token_file = Some(file.path().into());
    options.credential_host_file = Some("/run/identity/token".into());
    let storage = options.resolve()?;
    assert!(storage.environment(true).contains(&(
        "AZURE_FEDERATED_TOKEN_FILE".into(),
        RUNTIME_CREDENTIAL.into()
    )));
    assert!(storage.environment(false).contains(&(
        "AZURE_FEDERATED_TOKEN_FILE".into(),
        file.path().to_string_lossy().into_owned()
    )));
    assert!(storage.credential_mount().is_some());
    Ok(())
}

#[test]
fn rejects_provider_bucket_endpoint_and_account_changes_for_existing_apps() -> Result<()> {
    let original = s3().resolve()?;
    let args = original.arguments(Uuid::nil(), true);
    assert!(original.verify_runtime(Uuid::nil(), &args, &[]).is_ok());
    assert!(
        azure()
            .resolve()?
            .verify_runtime(Uuid::nil(), &args, &[])
            .is_err()
    );
    let mut changed = s3();
    changed.fleet_bucket = Some("different-bucket".into());
    assert!(
        changed
            .resolve()?
            .verify_runtime(Uuid::nil(), &args, &[])
            .is_err()
    );
    changed = s3();
    changed.runtime_endpoint = Some("http://different-storage:9000".into());
    assert!(
        changed
            .resolve()?
            .verify_runtime(Uuid::nil(), &args, &[])
            .is_err()
    );
    let original = azure().resolve()?;
    let args = original.arguments(Uuid::nil(), true);
    assert!(
        original
            .verify_runtime(
                Uuid::nil(),
                &args,
                &["AZURE_STORAGE_ACCOUNT_NAME=testaccount".into()]
            )
            .is_ok()
    );
    assert!(
        original
            .verify_runtime(
                Uuid::nil(),
                &args,
                &["AZURE_STORAGE_ACCOUNT_NAME=differentaccount".into()]
            )
            .is_err()
    );
    Ok(())
}
