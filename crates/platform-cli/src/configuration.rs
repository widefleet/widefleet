use clap::{Args, Subcommand};
use platform_core::{Error, Result, http::Api};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    action: Option<Action>,
}

#[derive(Subcommand)]
enum Action {
    /// Show the effective platform URL, its source, and configuration file paths.
    Show,
    /// Save a platform URL without logging in.
    SetUrl { url: String },
    /// Remove the saved URL; a managed default may still apply. Does not log out.
    UnsetUrl,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    platform_url: Option<String>,
}

pub struct Files {
    user: PathBuf,
    managed: Option<PathBuf>,
}

#[derive(Serialize)]
pub struct Selection {
    pub platform_url: String,
    source: &'static str,
}

pub fn explicit(origin: Option<&str>) -> Result<Option<Selection>> {
    origin
        .map(|origin| {
            Ok(Selection {
                platform_url: Api::new(origin)?.origin_text(),
                source: "override",
            })
        })
        .transpose()
}

impl Files {
    pub fn locate(path: Option<&Path>) -> Result<Self> {
        if let Some(path) = path {
            if path.as_os_str().is_empty() {
                return Err(Error::invalid(
                    "The configuration file path is empty".into(),
                ));
            }
            return Ok(Self {
                user: path.to_owned(),
                managed: None,
            });
        }
        Self::defaults(std::env::consts::OS, |name| std::env::var_os(name))
    }

    fn defaults(os: &str, variable: impl Fn(&str) -> Option<OsString>) -> Result<Self> {
        let directory = |name| {
            variable(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        let (user, managed) = match os {
            "windows" => (directory("APPDATA"), directory("PROGRAMDATA")),
            "macos" => (
                directory("HOME").map(|home| home.join("Library/Application Support")),
                Some(PathBuf::from("/Library/Application Support")),
            ),
            _ => (
                directory("XDG_CONFIG_HOME")
                    .or_else(|| directory("HOME").map(|home| home.join(".config"))),
                Some(PathBuf::from("/etc")),
            ),
        };
        let user = user.ok_or_else(|| {
            Error::invalid(
                "No user configuration directory is available; use --config-file PATH or PLATFORM_CONFIG_FILE"
                    .into(),
            )
        })?;
        if !user.is_absolute() || managed.as_ref().is_some_and(|path| !path.is_absolute()) {
            return Err(Error::invalid(
                "Configuration directories must be absolute paths".into(),
            ));
        }
        Ok(Self {
            user: user.join("widefleet/config.json"),
            managed: managed.map(|path| path.join("widefleet/config.json")),
        })
    }

    pub fn selection(&self) -> Result<Option<Selection>> {
        if let Some(platform_url) = read(&self.user)? {
            return Ok(Some(Selection {
                platform_url,
                source: "user",
            }));
        }
        if let Some(path) = &self.managed
            && let Some(platform_url) = read(path)?
        {
            return Ok(Some(Selection {
                platform_url,
                source: "managed",
            }));
        }
        Ok(None)
    }

    pub fn save(&self, origin: Option<&str>) -> Result<()> {
        let platform_url = origin
            .map(|origin| Api::new(origin).map(|api| api.origin_text()))
            .transpose()?;
        let parent = self
            .user
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temporary, &Configuration { platform_url })?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&self.user)
            .map_err(|error| Error::from(error.error))?;
        Ok(())
    }

    pub fn command(&self, options: Options, origin: Option<&str>) -> Result<()> {
        let override_url = explicit(origin)?;
        match options.action.unwrap_or(Action::Show) {
            Action::Show => {}
            Action::SetUrl { url } => self.save(Some(&url))?,
            Action::UnsetUrl => self.save(None)?,
        }
        let selected = match override_url {
            Some(selected) => Some(selected),
            None => self.selection()?,
        };
        crate::print_json(&serde_json::json!({
            "platform_url": selected.as_ref().map(|selected| &selected.platform_url),
            "source": selected.as_ref().map(|selected| selected.source),
            "config_file": self.user,
            "managed_config_file": self.managed,
        }))
    }
}

fn read(path: &Path) -> Result<Option<String>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let configuration: Configuration = serde_json::from_slice(&bytes).map_err(|error| {
        Error::invalid(format!(
            "Invalid CLI configuration in {}: {error}",
            path.display()
        ))
    })?;
    configuration
        .platform_url
        .map(|origin| {
            Api::new(&origin)
                .map(|api| api.origin_text())
                .map_err(|_| {
                    Error::invalid(format!(
                        "Invalid platform_url in {}; use an HTTPS origin, or HTTP on loopback for development",
                        path.display()
                    ))
                })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_directories_reject_missing_or_relative_user_locations() {
        let os = std::env::consts::OS;
        assert!(Files::defaults(os, |_| None).is_err());
        assert!(Files::defaults(os, |_| Some(OsString::new())).is_err());
        assert!(Files::defaults(os, |_| Some(OsString::from("relative"))).is_err());
    }

    #[test]
    fn user_configuration_overrides_managed_default_and_unset_restores_it() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let managed = directory.path().join("managed.json");
        fs::write(
            &managed,
            r#"{"platform_url":"https://managed.example.test"}"#,
        )?;
        let files = Files {
            user: directory.path().join("user/config.json"),
            managed: Some(managed.clone()),
        };
        assert_eq!(
            files.selection()?.map(|selected| selected.platform_url),
            Some("https://managed.example.test".into())
        );
        files.save(Some("https://user.example.test:443/"))?;
        assert_eq!(
            files.selection()?.map(|selected| selected.platform_url),
            Some("https://user.example.test".into())
        );
        files.save(None)?;
        assert_eq!(
            files.selection()?.map(|selected| selected.platform_url),
            Some("https://managed.example.test".into())
        );
        assert_eq!(
            fs::read_to_string(managed)?,
            r#"{"platform_url":"https://managed.example.test"}"#
        );
        Ok(())
    }

    #[test]
    fn broken_user_configuration_does_not_fall_back_to_a_different_platform() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let managed = directory.path().join("managed.json");
        fs::write(
            &managed,
            r#"{"platform_url":"https://managed.example.test"}"#,
        )?;
        let files = Files {
            user: directory.path().join("user.json"),
            managed: Some(managed),
        };
        for contents in [
            "{",
            r#"{"platform_url":"http://insecure.example.test"}"#,
            r#"{"platform_url":"https://example.test/api"}"#,
            r#"{"platform_ur":"https://typo.example.test"}"#,
        ] {
            fs::write(&files.user, contents)?;
            assert!(files.selection().is_err());
        }
        Ok(())
    }

    #[test]
    fn invalid_update_preserves_configuration_and_explicit_files_are_isolated() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let files = Files::locate(Some(&directory.path().join("config.json")))?;
        assert!(files.managed.is_none());
        assert!(files.selection()?.is_none());
        files.save(Some("http://localhost:25450"))?;
        assert!(
            files
                .save(Some("https://user:password@example.test"))
                .is_err()
        );
        assert_eq!(
            files.selection()?.map(|selected| selected.platform_url),
            Some("http://localhost:25450".into())
        );
        Ok(())
    }
}
