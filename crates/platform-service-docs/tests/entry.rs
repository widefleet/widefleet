//! Entry-mode documentation for the shared fixture app. The WebAssembly build is
//! checked against the same expected output in packages/service-docs.

use std::path::Path;

const MAP: &str = r#"{"version":3,"sources":[],"names":[],"mappings":""}"#;

fn fixture() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/app");
    let mut files = Vec::new();
    let mut directories = vec![root.clone()];
    while let Some(directory) = directories.pop() {
        for entry in std::fs::read_dir(directory).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                directories.push(path);
            } else if let (Ok(relative), Ok(content)) =
                (path.strip_prefix(&root), std::fs::read_to_string(&path))
            {
                files.push((format!("/app/{}", relative.to_string_lossy()), content));
            }
        }
    }
    files
}

#[test]
fn entry_mode_matches_the_expected_documentation() -> Result<(), Box<dyn std::error::Error>> {
    let fs: &'static dyn tsrs_vfs::FS =
        Box::leak(Box::new(tsrs_vfs::vfstest::from_map(fixture(), true)));
    let documentation = platform_service_docs::extract(
        fs,
        "/app",
        "/app/worker.js",
        MAP,
        Some("/app/src/app.ts"),
        &["default".into()],
    )?;
    let expected: serde_json::Value = serde_json::from_str(include_str!("fixtures/expected.json"))?;
    assert_eq!(documentation, expected);
    Ok(())
}
