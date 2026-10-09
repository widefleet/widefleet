use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_FILES: usize = 1000;
pub const MAX_SQL_BYTES: usize = 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
// Include the request metadata and worst-case JSON escaping of SQL strings.
pub const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReference {
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    List,
    Apply,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub action: Action,
    pub database: String,
    pub database_id: String,
    pub table: String,
    pub files: Vec<File>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub name: String,
    pub applied: bool,
}

pub fn number(name: &str) -> Result<u64> {
    let prefix: String = name.chars().take_while(char::is_ascii_digit).collect();
    prefix.parse().map_err(|_| {
        Error::invalid(format!(
            "Migration {name:?} must start with a numeric version"
        ))
    })
}

pub fn identifier(name: &str) -> bool {
    let mut chars = name.chars();
    !name.is_empty()
        && name.len() <= 128
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl Request {
    pub fn validate(&mut self) -> Result<()> {
        if !identifier(&self.database)
            || self.database.len() > 64
            || !identifier(&self.table)
            || self.database_id.is_empty()
            // Match Zod/JavaScript string limits, which count UTF-16 code units.
            || self.database_id.encode_utf16().count() > 128
            || self.files.len() > MAX_FILES
        {
            return Err(Error::invalid("Invalid database migration request".into()));
        }
        let mut names = BTreeSet::new();
        let mut total = 0;
        for file in &self.files {
            number(&file.name)?;
            if file.name.len() > 512
                || !file.name.to_ascii_lowercase().ends_with(".sql")
                || file.name.split('/').any(|part| {
                    part.is_empty()
                        || part == "."
                        || part == ".."
                        || !part
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
                })
                || !names.insert(&file.name)
            {
                return Err(Error::invalid(format!(
                    "Invalid or duplicate migration name: {:?}",
                    file.name
                )));
            }
            match (self.action, &file.sql) {
                (Action::List, None) => {}
                (Action::Apply, Some(sql)) if sql.len() <= MAX_SQL_BYTES && !sql.contains('\0') => {
                    total += sql.len();
                }
                _ => {
                    return Err(Error::invalid(format!(
                        "Invalid SQL for migration {:?}",
                        file.name
                    )));
                }
            }
        }
        if total > MAX_TOTAL_BYTES {
            return Err(Error::invalid("Migration SQL exceeds 8 MiB".into()));
        }
        // Validation above makes every numeric key infallible here.
        self.files
            .sort_by_cached_key(|file| (number(&file.name).unwrap_or_default(), file.name.clone()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_ids_follow_the_api_utf16_length_limit() {
        for (database_id, accepted) in [
            ("é".repeat(65), true),
            ("é".repeat(128), true),
            ("é".repeat(129), false),
            ("😀".repeat(64), true),
            ("😀".repeat(65), false),
        ] {
            let mut request = Request {
                action: Action::List,
                database: "DB".into(),
                database_id,
                table: "d1_migrations".into(),
                files: Vec::new(),
            };
            assert_eq!(request.validate().is_ok(), accepted);
        }
    }
}
