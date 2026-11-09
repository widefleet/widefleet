use platform_core::{Error, Result, model::ServiceDescription, sha256};
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Deserialize)]
struct Generated {
    entry: String,
    inputs: BTreeMap<String, String>,
    documentation: BTreeMap<String, ServiceDescription>,
}

pub fn read(project: &Path, entry: &Path) -> Result<BTreeMap<String, ServiceDescription>> {
    let path = project.join(".widefleet/services.json");
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    if path.metadata()?.len() > 2 * 1024 * 1024 {
        return Err(Error::invalid(
            "Generated service documentation exceeds 2 MiB".into(),
        ));
    }
    let generated: Generated = serde_json::from_slice(&std::fs::read(path)?)?;
    if project.join(&generated.entry).canonicalize()? != entry.canonicalize()?
        || !generated.inputs.contains_key(&generated.entry)
    {
        return Err(Error::invalid(
            "Regenerate service documentation for the configured Worker entry".into(),
        ));
    }
    for (file, expected) in &generated.inputs {
        if sha256(&std::fs::read(project.join(file))?) != *expected {
            return Err(Error::invalid(format!(
                "Service documentation is stale: {file} changed. Rebuild before deploying."
            )));
        }
    }
    Ok(generated.documentation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_stale_documentation_including_imported_types() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let root = temporary.path();
        std::fs::create_dir(root.join(".widefleet"))?;
        std::fs::write(root.join("app.ts"), "export default class App {}")?;
        std::fs::write(root.join("types.ts"), "export type Input = string")?;
        let inputs: BTreeMap<_, _> = ["app.ts", "types.ts"]
            .into_iter()
            .map(|name| Ok((name, sha256(&std::fs::read(root.join(name))?))))
            .collect::<Result<_>>()?;
        std::fs::write(
            root.join(".widefleet/services.json"),
            serde_json::to_vec(&serde_json::json!({
                "entry": "app.ts", "inputs": inputs, "documentation": {}
            }))?,
        )?;
        assert!(read(root, &root.join("app.ts")).is_ok());
        std::fs::write(root.join("types.ts"), "export type Input = number")?;
        assert!(read(root, &root.join("app.ts")).is_err());
        Ok(())
    }
}
