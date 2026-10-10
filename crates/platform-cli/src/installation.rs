use platform_core::{Error, Result};
use serde::Deserialize;
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
};
use tokio::process::Command;

#[derive(Deserialize)]
struct Release {
    format: u32,
    version: String,
    esbuild_version: String,
}

pub struct Installation {
    pub directory: PathBuf,
    pub esbuild_version: String,
}

fn invocation_executable(invocation: &OsStr, search_path: Option<&OsStr>) -> Option<PathBuf> {
    let invocation = Path::new(invocation);
    if invocation.as_os_str().is_empty() {
        return None;
    }
    let resolve = |path: &Path| {
        let metadata = fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use rustix::fs::{Access, AtFlags, CWD, accessat};
            accessat(CWD, path, Access::EXEC_OK, AtFlags::EACCESS).ok()?;
        }
        path.canonicalize().ok()
    };
    if invocation.is_absolute()
        || invocation
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty())
    {
        return resolve(invocation);
    }
    std::env::split_paths(search_path?).find_map(|directory| resolve(&directory.join(invocation)))
}

fn executable(
    current: std::io::Result<PathBuf>,
    invocation: Option<&OsStr>,
    search_path: Option<&OsStr>,
) -> Result<PathBuf> {
    match current {
        Ok(path) => path.canonicalize().map_err(|error| {
            Error::invalid(format!("Cannot resolve the CLI executable: {error}"))
        }),
        Err(error) => invocation
            .and_then(|invocation| invocation_executable(invocation, search_path))
            .ok_or_else(|| Error::invalid(format!(
                "Cannot locate the CLI installation: {error}. The invocation path could not be resolved either. Invoke widefleet using its full path or a command on PATH, and keep the complete release archive together"
            ))),
    }
}

pub fn load() -> Result<Installation> {
    let executable = executable(
        std::env::current_exe(),
        std::env::args_os().next().as_deref(),
        std::env::var_os("PATH").as_deref(),
    )?;
    let directory = executable
        .parent()
        .ok_or_else(|| Error::invalid("CLI executable has no directory".into()))?;
    let release = fs::read(directory.join("release.json")).map_err(|error| Error::invalid(format!("Cannot read the CLI installation ({error}). Install the complete release archive, including esbuild and starter; copying only the widefleet binary is insufficient")))?;
    let release: Release = serde_json::from_slice(&release)?;
    if release.format != 1 || release.version != env!("CARGO_PKG_VERSION") {
        return Err(Error::invalid("CLI installation files belong to a different version; reinstall the complete release archive".into()));
    }
    Ok(Installation {
        directory: directory.to_owned(),
        esbuild_version: release.esbuild_version,
    })
}

pub async fn bundler() -> Result<PathBuf> {
    let installation = load()?;
    let executable = installation
        .directory
        .join("esbuild")
        .with_extension(std::env::consts::EXE_EXTENSION);
    let version = Command::new(&executable)
        .arg("--version")
        .output()
        .await
        .map_err(|error| Error::invalid(format!(
            "Cannot run the CLI's bundled esbuild ({error}); reinstall the complete release archive"
        )))?;
    if !version.status.success()
        || String::from_utf8_lossy(&version.stdout).trim() != installation.esbuild_version
    {
        return Err(Error::invalid("The installed esbuild version does not match the CLI release; reinstall the complete release archive".into()));
    }
    Ok(executable)
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if kind.is_file() {
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?;
            std::io::copy(&mut fs::File::open(entry.path())?, &mut output)?;
        } else {
            return Err(Error::invalid(
                "CLI starter must contain only regular files and directories".into(),
            ));
        }
    }
    Ok(())
}

fn write_project(template: &Path, directory: &Path) -> Result<()> {
    if directory.symlink_metadata().is_ok() {
        return Err(Error::invalid(format!(
            "{} already exists; choose a new directory",
            directory.display()
        )));
    }
    copy_directory(template, directory)
}

pub fn initialize(directory: &Path) -> Result<()> {
    let installation = load()?;
    write_project(&installation.directory.join("starter"), directory)?;
    let name = project_name(directory);
    let config = directory.join("wrangler.jsonc");
    let mut source = fs::read_to_string(&config)?;
    let parsed = jsonc_parser::parse_to_ast(&source, &Default::default(), &Default::default())
        .map_err(|error| Error::invalid(format!("Invalid starter configuration: {error}")))?;
    let range = parsed
        .value
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|object| object.get_string("name"))
        .map(|value| value.range)
        .ok_or_else(|| Error::invalid("Starter configuration must declare a name".into()))?;
    source.replace_range(range.start..range.end, &serde_json::to_string(&name)?);
    fs::write(config, source)?;
    println!("Created SvelteKit project at {}", directory.display());
    println!("App name: {name} (editable in wrangler.jsonc)");
    println!(
        "In that directory, run pnpm install --frozen-lockfile, then pnpm check. Run widefleet login to connect your company, then widefleet deploy."
    );
    Ok(())
}

fn project_name(directory: &Path) -> String {
    let basename = directory
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let mut name = basename
        .split(|character: char| !character.is_ascii_lowercase() && !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if !name.starts_with(|character: char| character.is_ascii_lowercase()) || name == "auth" {
        name = format!("app-{name}");
    }
    name.truncate(48);
    name.trim_end_matches('-').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_executable(path: &Path) -> Result<()> {
        fs::write(path, "synthetic executable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    }

    fn missing_executable() -> std::io::Result<PathBuf> {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "synthetic missing executable link",
        ))
    }

    #[test]
    fn operating_system_executable_takes_precedence_over_invocation() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let actual = directory.path().join("actual");
        let other = directory.path().join("other");
        write_executable(&actual)?;
        write_executable(&other)?;
        assert_eq!(
            executable(Ok(actual.clone()), Some(other.as_os_str()), None)?,
            actual.canonicalize()?
        );
        // A known executable that disappeared must not select another installation.
        fs::remove_file(&actual)?;
        assert!(executable(Ok(actual), Some(other.as_os_str()), None).is_err());
        Ok(())
    }

    #[test]
    fn missing_executable_link_falls_back_to_absolute_and_relative_invocations() -> Result<()> {
        let working_directory = std::env::current_dir()?;
        let directory = tempfile::tempdir_in(&working_directory)?;
        let binary = directory.path().join("widefleet");
        write_executable(&binary)?;
        let relative = binary
            .strip_prefix(&working_directory)
            .map_err(|error| Error::invalid(error.to_string()))?;
        for invocation in [binary.as_path(), relative] {
            assert_eq!(
                executable(missing_executable(), Some(invocation.as_os_str()), None)?,
                binary.canonicalize()?
            );
        }
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn path_fallback_skips_non_executables_and_resolves_the_first_executable_symlink() -> Result<()>
    {
        use std::os::unix::{fs::PermissionsExt, fs::symlink};
        let directory = tempfile::tempdir()?;
        let paths: Vec<_> = ["non-executable", "directory", "bin", "later"]
            .iter()
            .map(|name| directory.path().join(name))
            .collect();
        for path in &paths {
            fs::create_dir(path)?;
        }
        let blocked = paths[0].join("widefleet");
        fs::write(&blocked, "not executable")?;
        fs::set_permissions(blocked, fs::Permissions::from_mode(0o644))?;
        fs::create_dir(paths[1].join("widefleet"))?;
        let actual = directory.path().join("widefleet");
        write_executable(&actual)?;
        symlink("../widefleet", paths[2].join("widefleet"))?;
        write_executable(&paths[3].join("widefleet"))?;
        let search_path =
            std::env::join_paths(&paths).map_err(|error| Error::invalid(error.to_string()))?;
        assert_eq!(
            executable(
                missing_executable(),
                Some(OsStr::new("widefleet")),
                Some(&search_path)
            )?,
            actual.canonicalize()?
        );
        assert_eq!(
            executable(
                missing_executable(),
                Some(paths[2].join("widefleet").as_os_str()),
                None
            )?,
            actual.canonicalize()?
        );
        Ok(())
    }

    #[test]
    fn unresolved_invocations_report_the_original_error_and_recovery() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let binary = directory.path().join("widefleet");
        write_executable(&binary)?;
        let missing = directory.path().join("missing/widefleet");
        for (invocation, search_path) in [
            (None, Some(directory.path().as_os_str())),
            (Some(OsStr::new("")), Some(directory.path().as_os_str())),
            (Some(OsStr::new("widefleet")), None),
            // Explicit paths must not be replaced by a different binary on PATH.
            (
                Some(missing.as_os_str()),
                Some(directory.path().as_os_str()),
            ),
        ] {
            let result = executable(missing_executable(), invocation, search_path);
            let Err(error) = result else {
                panic!("An unresolved invocation must fail");
            };
            let message = error.to_string();
            assert!(message.contains("synthetic missing executable link"));
            assert!(message.contains("Invoke widefleet using its full path or a command on PATH"));
        }
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn path_fallback_matches_command_launch_permissions() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir()?;
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        fs::create_dir(&first)?;
        fs::create_dir(&second)?;
        let restricted = first.join("widefleet");
        let executable_path = second.join("widefleet");
        fs::write(&restricted, "#!/bin/sh\nexit 0\n")?;
        // An execute bit for other users does not let the owner execute this file.
        fs::set_permissions(&restricted, fs::Permissions::from_mode(0o645))?;
        write_executable(&executable_path)?;
        let search_path = std::env::join_paths([first, second])
            .map_err(|error| Error::invalid(error.to_string()))?;
        // Use the kernel's launch decision, including when tests run as root.
        let expected = match std::process::Command::new(&restricted).status() {
            Ok(status) => {
                assert!(status.success());
                restricted
            }
            Err(error) => {
                assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
                executable_path
            }
        };
        assert_eq!(
            executable(
                missing_executable(),
                Some(OsStr::new("widefleet")),
                Some(&search_path)
            )?,
            expected.canonicalize()?
        );
        Ok(())
    }

    #[test]
    fn project_names_are_valid_slugs() {
        assert_eq!(project_name(Path::new("My App")), "my-app");
        assert_eq!(project_name(Path::new("42-notes")), "app-42-notes");
        assert_eq!(project_name(Path::new("auth")), "app-auth");
        assert_eq!(project_name(Path::new("---")), "app");
        assert_eq!(project_name(Path::new(&"a".repeat(60))).len(), 48);
    }

    #[test]
    fn init_copies_hidden_files_and_never_overwrites_existing_work() -> Result<()> {
        let temporary = tempfile::tempdir()?;
        let template = temporary.path().join("template");
        fs::create_dir(&template)?;
        fs::write(template.join(".gitignore"), "node_modules/\n")?;
        fs::create_dir(template.join("src"))?;
        fs::write(template.join("src/app.ts"), "export const name = 'app';")?;
        let app = temporary.path().join("app");
        write_project(&template, &app)?;
        assert_eq!(fs::read(app.join(".gitignore"))?, b"node_modules/\n");
        fs::write(app.join("src/app.ts"), "existing work")?;
        assert!(write_project(&template, &app).is_err());
        assert_eq!(fs::read(app.join("src/app.ts"))?, b"existing work");
        Ok(())
    }
}
