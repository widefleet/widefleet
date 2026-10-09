use crate::{artifact, config::Configuration, docker, fleet};
use bollard::Docker;
use platform_core::{
    Error, Result,
    http::Api,
    migrations::{Action, Entry, MAX_ARTIFACT_BYTES, Request},
    model::Job,
    sha256,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::BTreeSet,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn migration_sql(request: &Request, file: &platform_core::migrations::File) -> Result<String> {
    let sql = file
        .sql
        .as_ref()
        .ok_or_else(|| Error::invalid("Migration has no SQL".into()))?;
    // celld executes the complete file in one native D1 transaction. A duplicate
    // history insert prevents re-execution, including after a lost acknowledgement.
    // Insert before the source so a trailing SQL comment cannot swallow it.
    // A SQL failure rolls back the history row as well as all schema/data changes.
    Ok(format!(
        "CREATE TABLE IF NOT EXISTS \"{}\" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);\nINSERT INTO \"{}\" (name) VALUES ({});\n{sql}",
        request.table,
        request.table,
        literal(&file.name),
    ))
}

async fn execute(
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
    directory: &Path,
    sql: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>> {
    tokio::fs::write(directory.join("query.sql"), sql).await?;
    let name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::invalid("Invalid migration staging directory".into()))?;
    let mut command = vec![
        "celld".into(),
        "d1".into(),
        "execute".into(),
        "migration".into(),
        "--file".into(),
        format!("/state/{name}/query.sql"),
        format!("/state/{name}"),
        "--json".into(),
    ];
    command.extend(
        configuration
            .storage
            .resolve()?
            .arguments(job.fleet_id, true),
    );
    if cancelled.load(Ordering::Relaxed) {
        return Err(Error::invalid(
            "Migration interrupted before the next SQL command".into(),
        ));
    }
    docker::execute_output(docker, job, command).await
}

pub async fn run(
    api: &Api,
    docker: &Docker,
    configuration: &Configuration,
    job: &Job,
    cancelled: &AtomicBool,
) -> Result<Vec<Entry>> {
    let reference = job
        .migration
        .as_ref()
        .ok_or_else(|| Error::invalid("Migration job has no artifact reference".into()))?;
    let bytes = artifact::download(
        api,
        &configuration.token,
        job,
        "migrations",
        &reference.sha256,
        reference.size,
        MAX_ARTIFACT_BYTES,
    )
    .await?;
    if sha256(&bytes) != reference.sha256 {
        return Err(Error::invalid(
            "Migration artifact checksum mismatch".into(),
        ));
    }
    let mut request: Request = serde_json::from_slice(&bytes)?;
    request.validate()?;
    let database = fleet::migration_database(configuration, job, &request).await?;
    let temporary = tempfile::Builder::new()
        .prefix("migrations-")
        .tempdir_in(configuration.state.join(job.fleet_id.to_string()))?;
    tokio::fs::write(temporary.path().join("wrangler.jsonc"), serde_json::to_vec(&json!({
        "name": "migration", "d1_databases": [{ "binding": "DB", "database_name": "migration", "database_id": database }],
    }))?).await?;
    let exists = execute(
        docker,
        configuration,
        job,
        temporary.path(),
        &format!(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = {} COLLATE NOCASE;",
            literal(&request.table),
        ),
        cancelled,
    )
    .await?;
    let mut applied = BTreeSet::new();
    if !exists.is_empty() && !request.files.is_empty() {
        let names = request
            .files
            .iter()
            .map(|file| literal(&file.name))
            .collect::<Vec<_>>()
            .join(",");
        let rows = execute(
            docker,
            configuration,
            job,
            temporary.path(),
            &format!(
                "SELECT name FROM \"{}\" WHERE name IN ({names});",
                request.table,
            ),
            cancelled,
        )
        .await?;
        #[derive(Deserialize)]
        struct Row {
            name: String,
        }
        for row in serde_json::Deserializer::from_slice(&rows).into_iter::<Row>() {
            applied.insert(row?.name);
        }
    }
    if request.action == Action::Apply {
        for file in &request.files {
            if applied.contains(&file.name) {
                continue;
            }
            execute(
                docker,
                configuration,
                job,
                temporary.path(),
                &migration_sql(&request, file)?,
                cancelled,
            )
            .await
            .map_err(|cause| Error::invalid(format!("Migration {} failed: {cause}", file.name)))?;
            applied.insert(file.name.clone());
        }
    }
    Ok(request
        .files
        .into_iter()
        .map(|file| Entry {
            applied: applied.contains(&file.name),
            name: file.name,
        })
        .collect())
}
