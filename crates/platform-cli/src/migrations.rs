use crate::{apps, auth};
use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    migrations::{self, Action, Entry, File, Request},
};
use reqwest::Method;
use serde::Deserialize;
use std::{
    io::IsTerminal,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    /// App name or ID; otherwise use the current project's name.
    #[arg(long, global = true)]
    app: Option<String>,
    #[arg(long, global = true, default_value = "wrangler.jsonc")]
    config: PathBuf,
    /// Print JSON (also the default for redirected output).
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List applied and pending SQL files for a deployed D1 binding.
    List { database: String },
    /// Apply pending SQL files, stopping at the first failure.
    Apply { database: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Database {
    pub binding: String,
    pub database_name: String,
    pub database_id: Option<String>,
    pub migrations_dir: Option<String>,
    pub migrations_pattern: Option<String>,
    pub migrations_table: Option<String>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    id: Uuid,
    state: String,
    message: Option<String>,
    entries: Option<Vec<Entry>>,
}

fn relative(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        || path.to_string_lossy().contains('\\')
    {
        return Err(Error::invalid(
            "Migration paths must be relative to the project without '..'".into(),
        ));
    }
    Ok(path
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .collect())
}

// The supported pattern syntax is deliberately limited to * within a segment
// and ** as a complete segment. Reject other glob syntax instead of ignoring it.
fn segment(pattern: &str, name: &str) -> bool {
    if let Some((first, rest)) = pattern.split_once('*') {
        let Some(name) = name.strip_prefix(first) else {
            return false;
        };
        name.char_indices()
            .map(|(index, _)| index)
            .chain(std::iter::once(name.len()))
            .any(|index| segment(rest, &name[index..]))
    } else {
        pattern == name
    }
}

fn matches(pattern: &[&str], path: &[&str]) -> bool {
    match (pattern.split_first(), path.split_first()) {
        (None, None) => true,
        (Some((&"**", rest)), _) => (0..=path.len()).any(|index| matches(rest, &path[index..])),
        (Some((first, rest)), Some((name, tail))) => segment(first, name) && matches(rest, tail),
        _ => false,
    }
}

fn walk(
    root: &Path,
    directory: &Path,
    pattern: &[&str],
    action: Action,
    files: &mut Vec<File>,
    remaining: &mut usize,
) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(Error::invalid(format!(
                "Migration directories cannot contain symlinks: {}",
                entry.path().display()
            )));
        }
        if kind.is_dir() {
            walk(root, &entry.path(), pattern, action, files, remaining)?;
        } else if kind.is_file() {
            let path = entry.path();
            let name = path
                .strip_prefix(root)
                .map_err(|cause| Error::invalid(cause.to_string()))?
                .to_str()
                .ok_or_else(|| Error::invalid("Migration filenames must be UTF-8".into()))?
                .replace('\\', "/");
            if !matches(pattern, &name.split('/').collect::<Vec<_>>()) {
                continue;
            }
            if files.len() >= migrations::MAX_FILES
                || entry.metadata()?.len() > migrations::MAX_SQL_BYTES as u64
            {
                return Err(Error::invalid(
                    "At most 1000 migration files of 1 MiB each are supported".into(),
                ));
            }
            let sql = if action == Action::Apply {
                let sql = std::fs::read_to_string(path)?;
                *remaining = remaining
                    .checked_sub(sql.len())
                    .ok_or_else(|| Error::invalid("Migration SQL exceeds 8 MiB".into()))?;
                Some(sql)
            } else {
                None
            };
            files.push(File { name, sql });
        }
    }
    Ok(())
}

fn read(config: &Path, database: &str, action: Action) -> Result<Request> {
    #[derive(Deserialize)]
    struct Project {
        d1_databases: Vec<Database>,
    }
    let config = config.canonicalize()?;
    let project = config
        .parent()
        .ok_or_else(|| Error::invalid("Configuration has no project directory".into()))?;
    let parsed: Project = jsonc_parser::parse_to_serde_value(
        &std::fs::read_to_string(&config)?,
        &jsonc_parser::ParseOptions::default(),
    )
    .map_err(|cause| Error::invalid(format!("Invalid Wrangler configuration: {cause}")))?;
    let selected: Vec<_> = parsed
        .d1_databases
        .into_iter()
        .filter(|entry| entry.binding == database || entry.database_name == database)
        .collect();
    let [database] = selected.as_slice() else {
        return Err(Error::invalid(
            "Choose an unambiguous D1 binding or database_name from the project configuration"
                .into(),
        ));
    };
    let directory = relative(database.migrations_dir.as_deref().unwrap_or("migrations"))?;
    if directory.as_os_str().is_empty() {
        return Err(Error::invalid(
            "migrations_dir must name a project subdirectory".into(),
        ));
    }
    let prefix = format!("{}/", directory.to_string_lossy().replace('\\', "/"));
    let default_pattern = format!("{prefix}*.sql");
    let pattern = database
        .migrations_pattern
        .as_deref()
        .unwrap_or(&default_pattern);
    let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
    let pattern = pattern.strip_prefix(&prefix).ok_or_else(|| {
        Error::invalid("migrations_pattern must start with migrations_dir/".into())
    })?;
    if pattern.is_empty()
        || pattern.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || (part.contains("**") && part != "**")
                || !part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_.*-".contains(c))
        })
    {
        return Err(Error::invalid(
            "migrations_pattern supports literal paths, * and ** only".into(),
        ));
    }
    let root = project.join(directory).canonicalize()?;
    if !root.starts_with(project) {
        return Err(Error::invalid(
            "Migrations must remain inside the app project".into(),
        ));
    }
    let mut request = Request {
        action,
        database: database.binding.clone(),
        database_id: database
            .database_id
            .as_ref()
            .unwrap_or(&database.database_name)
            .clone(),
        table: database
            .migrations_table
            .clone()
            .unwrap_or_else(|| "d1_migrations".into()),
        files: Vec::new(),
    };
    let mut remaining = migrations::MAX_TOTAL_BYTES;
    walk(
        &root,
        &root,
        &pattern.split('/').collect::<Vec<_>>(),
        action,
        &mut request.files,
        &mut remaining,
    )?;
    request.validate()?;
    Ok(request)
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let (database, action) = match &options.command {
        Command::List { database } => (database, Action::List),
        Command::Apply { database } => (database, Action::Apply),
    };
    let request = read(&options.config, database, action)?;
    let app = apps::resolve(api, credentials, options.app.as_deref(), &options.config).await?;
    eprintln!(
        "Database: {database}; app: {app}; platform: {}",
        api.origin_text()
    );
    let token = auth::access_token(api, credentials).await?;
    let mut operation: Operation = json(
        api.authenticated(Method::POST, &format!("/apps/{app}/migrations"), &token)
            .header("idempotency-key", Uuid::new_v4().to_string())
            .json(&request)
            .send()
            .await?,
    )
    .await?;
    eprintln!("Migration operation: {}", operation.id);
    while matches!(operation.state.as_str(), "queued" | "running") {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let token = auth::access_token(api, credentials).await?;
        operation = json(
            api.authenticated(
                Method::GET,
                &format!("/apps/{app}/migrations/{}", operation.id),
                &token,
            )
            .send()
            .await?,
        )
        .await?;
    }
    if options.json || !std::io::stdout().is_terminal() {
        super::print_json(&operation)?;
    } else if let Some(entries) = &operation.entries {
        for entry in entries {
            println!(
                "{}\t{}",
                if entry.applied { "applied" } else { "pending" },
                entry.name
            );
        }
        if entries.is_empty() {
            println!("No matching migration files.");
        }
    }
    if operation.state != "succeeded" {
        return Err(Error::invalid(
            operation
                .message
                .unwrap_or_else(|| "Migration operation failed".into()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(directory: &Path, pattern: &str) -> Result<PathBuf> {
        let config = directory.join("wrangler.jsonc");
        std::fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!({
                "name": "fixture", "d1_databases": [{"binding": "DB", "database_name": "fixture", "migrations_dir": "drizzle", "migrations_pattern": pattern}]
            }))?,
        )?;
        Ok(config)
    }

    #[test]
    fn discovers_flat_and_drizzle_v1_files_in_numeric_order() -> Result<()> {
        let project = tempfile::tempdir()?;
        let root = project.path().join("drizzle");
        std::fs::create_dir_all(root.join("20261008120000_initial"))?;
        std::fs::create_dir_all(root.join("20261008130000_next"))?;
        for name in [
            "10_next.sql",
            "2_first.sql",
            "20261008120000_initial/migration.sql",
            "20261008130000_next/migration.sql",
        ] {
            std::fs::write(root.join(name), "SELECT 1;")?;
        }
        std::fs::write(root.join("20261008120000_initial/snapshot.json"), "{}")?;
        let config = fixture(project.path(), "drizzle/*.sql")?;
        let flat = read(&config, "DB", Action::List)?;
        assert_eq!(
            flat.files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            ["2_first.sql", "10_next.sql"]
        );
        assert!(flat.files.iter().all(|file| file.sql.is_none()));
        fixture(project.path(), "drizzle/**/migration.sql")?;
        let nested = read(&config, "fixture", Action::Apply)?;
        assert_eq!(
            nested
                .files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            [
                "20261008120000_initial/migration.sql",
                "20261008130000_next/migration.sql"
            ]
        );
        assert!(
            nested
                .files
                .iter()
                .all(|file| file.sql.as_deref() == Some("SELECT 1;"))
        );
        Ok(())
    }

    #[test]
    fn rejects_escaping_paths_unsupported_patterns_and_unnumbered_files() -> Result<()> {
        let project = tempfile::tempdir()?;
        std::fs::create_dir(project.path().join("drizzle"))?;
        for pattern in [
            "../*.sql",
            "drizzle/../*.sql",
            "drizzle/[0-9]*.sql",
            "drizzle/**bad/*.sql",
        ] {
            let config = fixture(project.path(), pattern)?;
            assert!(read(&config, "DB", Action::Apply).is_err());
        }
        let config = fixture(project.path(), "drizzle/*.sql")?;
        std::fs::write(project.path().join("drizzle/unnumbered.sql"), "SELECT 1;")?;
        assert!(read(&config, "DB", Action::Apply).is_err());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_in_migration_directories() -> Result<()> {
        let project = tempfile::tempdir()?;
        std::fs::create_dir(project.path().join("drizzle"))?;
        std::os::unix::fs::symlink(project.path(), project.path().join("drizzle/loop"))?;
        let config = fixture(project.path(), "drizzle/**/*.sql")?;
        assert!(read(&config, "DB", Action::Apply).is_err());
        Ok(())
    }
}
