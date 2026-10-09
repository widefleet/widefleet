use platform_core::{Error, Result};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub(super) struct SessionFile(pub PathBuf);

impl SessionFile {
    #[cfg(unix)]
    fn path(&self) -> Result<PathBuf> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        let absolute = std::path::absolute(&self.0)?;
        let parent = absolute.parent().ok_or_else(|| {
            Error::credentials("Choose a session file in a private directory".into())
        })?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        let parent = parent.canonicalize()?;
        if std::fs::metadata(&parent)?.permissions().mode() & 0o077 != 0 {
            return Err(Error::credentials(
                "The session file directory must be accessible only to its owner (chmod 700)"
                    .into(),
            ));
        }
        let name = absolute
            .file_name()
            .ok_or_else(|| Error::credentials("Choose a session file, not a directory".into()))?;
        Ok(parent.join(name))
    }

    #[cfg(not(unix))]
    fn path(&self) -> Result<PathBuf> {
        Err(Error::credentials(
            "Session files require Unix file permissions; use the operating system credential store or PLATFORM_ACCESS_TOKEN on this platform".into(),
        ))
    }

    #[cfg(unix)]
    fn open(path: &Path, writable: bool) -> Result<File> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(Error::credentials(
                "Session and lock files must be regular files without symbolic or hard links"
                    .into(),
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(Error::credentials(
                "Session and lock files must be accessible only to their owner (chmod 600)".into(),
            ));
        }
        let file = OpenOptions::new().read(true).write(writable).open(path)?;
        let opened = file.metadata()?;
        if (metadata.dev(), metadata.ino()) != (opened.dev(), opened.ino()) {
            return Err(Error::credentials(
                "The session file changed while opening it; retry the command".into(),
            ));
        }
        Ok(file)
    }

    #[cfg(not(unix))]
    fn open(_path: &Path, _writable: bool) -> Result<File> {
        Err(Error::credentials(
            "Session files require Unix file permissions".into(),
        ))
    }

    pub fn lock(&self) -> Result<File> {
        let path = self.path()?;
        let mut name = path.as_os_str().to_owned();
        name.push(".lock");
        let path = PathBuf::from(name);
        let mut options = OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = match options.open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Self::open(&path, true)?
            }
            Err(error) => return Err(error.into()),
        };
        file.lock()?;
        // The lock file is stable across atomic replacements and is never unlinked.
        Ok(file)
    }

    pub fn read(&self) -> Result<Option<Vec<u8>>> {
        let path = self.path()?;
        let mut file = match Self::open(&path, false) {
            Ok(file) => file,
            Err(error) if matches!(error.kind(), platform_core::ErrorKind::Io(cause) if cause.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }

    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let path = self.path()?;
        let parent = path.parent().ok_or_else(|| {
            Error::credentials("Choose a session file in a private directory".into())
        })?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        // NamedTempFile creates the file with mode 0600, before any secrets are written.
        temporary.write_all(bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&path)
            .map_err(|error| Error::from(error.error))?;
        File::open(parent)?.sync_all()?;
        Ok(())
    }

    pub fn delete(&self) -> Result<()> {
        let path = self.path()?;
        Self::open(&path, false)?;
        std::fs::remove_file(path)?;
        Ok(())
    }
}
