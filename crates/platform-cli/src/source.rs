use crate::{apps, auth};
use clap::{Args, Subcommand};
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::{App, AppSource, SourceRepository, SourceRevision},
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::json as value;
use std::{
    io::{BufRead, IsTerminal, Write},
    path::{Path, PathBuf},
    process::Output,
};
use tokio::process::Command;
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    #[command(subcommand)]
    pub command: Action,
}

#[derive(Subcommand)]
pub enum Action {
    /// Show repository availability, branch head and deployed source.
    Status {
        #[command(flatten)]
        target: Target,
    },
    /// Clone an app's saved source using your Widefleet login.
    Clone {
        app: String,
        directory: PathBuf,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        read_only: bool,
    },
    /// Add a Widefleet remote to the current Git repository.
    Connect {
        #[command(flatten)]
        target: Target,
        #[arg(long, default_value = "widefleet")]
        remote: String,
    },
    #[command(hide = true)]
    Credential {
        #[arg(long)]
        app: Uuid,
        #[arg(long)]
        read_only: bool,
        #[arg(long)]
        repository_url: String,
        operation: String,
    },
}

#[derive(Args)]
pub struct Target {
    #[arg(long)]
    app: Option<String>,
    #[arg(long, default_value = "wrangler.jsonc")]
    config: PathBuf,
}

pub async fn read(api: &Api, credentials: &auth::Credentials, app: Uuid) -> Result<AppSource> {
    let token = auth::access_token(api, credentials).await?;
    json(
        api.authenticated(Method::GET, &format!("/apps/{app}/source"), &token)
            .send()
            .await?,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preparation {
    organization_id: String,
    repository: Option<SourceRepository>,
    preview: bool,
}

async fn prepare(api: &Api, credentials: &auth::Credentials, app: Uuid) -> Result<Preparation> {
    let token = auth::access_token(api, credentials).await?;
    json(
        api.authenticated(Method::POST, &format!("/apps/{app}/source/prepare"), &token)
            .json(&value!({}))
            .send()
            .await?,
    )
    .await
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn helper(
    api: &Api,
    credentials: &auth::Credentials,
    app: Uuid,
    organization: &str,
    url: &str,
    read_only: bool,
) -> Result<String> {
    let executable = std::env::current_exe()?;
    let mut command = format!(
        "!{} --url {} --organization {}",
        quote(&executable.to_string_lossy()),
        quote(&api.origin_text()),
        quote(organization)
    );
    if let Some(path) = credentials.session_path() {
        command.push_str(&format!(
            " --session-file {}",
            quote(&path.canonicalize()?.to_string_lossy())
        ));
    }
    command.push_str(&format!(
        " source credential --app {} --repository-url {}{}",
        app,
        quote(url),
        if read_only { " --read-only" } else { "" }
    ));
    Ok(command)
}

fn git(project: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(project).env("GIT_TERMINAL_PROMPT", "0");
    command
}

async fn output(command: &mut Command) -> Result<String> {
    let Output {
        status,
        stdout,
        stderr,
    } = command.output().await.map_err(|cause| {
        Error::invalid(format!(
            "Could not run Git; install Git to use source storage: {cause}"
        ))
    })?;
    if !status.success() {
        return Err(Error::invalid(format!(
            "Git failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        )));
    }
    String::from_utf8(stdout)
        .map(|text| text.trim_end().to_owned())
        .map_err(|cause| Error::invalid(format!("Invalid Git response: {cause}")))
}

fn remote_git(project: &Path, url: &str, helper: &str) -> Command {
    let mut command = git(project);
    command.args([
        "-c",
        &format!("credential.{url}.helper="),
        "-c",
        &format!("credential.{url}.helper={helper}"),
        "-c",
        "credential.useHttpPath=true",
        "-c",
        "http.followRedirects=false",
    ]);
    command
}

fn validate_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|cause| Error::invalid(cause.to_string()))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::invalid(
            "The source repository must have an HTTPS URL without credentials".into(),
        ));
    }
    Ok(url)
}

async fn configure(project: &Path, url: &str, helper: &str) -> Result<()> {
    output(git(project).args([
        "config",
        "--local",
        "--replace-all",
        &format!("credential.{url}.helper"),
        "",
    ]))
    .await?;
    output(git(project).args([
        "config",
        "--local",
        "--add",
        &format!("credential.{url}.helper"),
        helper,
    ]))
    .await?;
    output(git(project).args([
        "config",
        "--local",
        &format!("credential.{url}.useHttpPath"),
        "true",
    ]))
    .await?;
    Ok(())
}

async fn root(project: &Path) -> Result<PathBuf> {
    let probe = git(project)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .await?;
    if probe.status.success() {
        return Ok(
            PathBuf::from(String::from_utf8_lossy(&probe.stdout).trim_end()).canonicalize()?,
        );
    }
    output(git(project).args(["init", "--initial-branch=main"])).await?;
    Ok(project.canonicalize()?)
}

async fn revision(project: &Path, reference: &str) -> Result<Option<String>> {
    let result = git(project)
        .args(["rev-parse", "--verify", "--quiet", reference])
        .output()
        .await?;
    if result.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&result.stdout).trim().to_owned(),
        ));
    }
    if result.status.code() == Some(1) {
        return Ok(None);
    }
    Err(Error::invalid(format!(
        "Could not read Git revision: {}",
        String::from_utf8_lossy(&result.stderr)
    )))
}

async fn is_ancestor(project: &Path, ancestor: &str, descendant: &str) -> Result<bool> {
    let result = git(project)
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .output()
        .await?;
    match result.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(Error::invalid(format!(
            "Could not compare Git history: {}",
            String::from_utf8_lossy(&result.stderr)
        ))),
    }
}

fn copy_index(source: &Path, destination: &Path) -> std::io::Result<()> {
    // Git uses the index mtime to decide whether cached file stats are racy.
    // Giving a copied index a newer timestamp can hide same-size source edits.
    let modified = std::fs::metadata(source)?.modified()?;
    std::fs::copy(source, destination)?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(destination)?
        .set_times(std::fs::FileTimes::new().set_modified(modified))
}

// An alternate index checks all files Git would add, without changing the user's staging area.
async fn tree(project: &Path) -> Result<String> {
    let temporary = tempfile::tempdir()?;
    let index = temporary.path().join("index");
    let local_index =
        output(git(project).args(["rev-parse", "--path-format=absolute", "--git-path", "index"]))
            .await?;
    if Path::new(&local_index).exists() {
        copy_index(Path::new(&local_index), &index)?;
    }
    output(
        git(project)
            .env("GIT_INDEX_FILE", &index)
            .args(["add", "--all", "--", "."]),
    )
    .await?;
    output(git(project).env("GIT_INDEX_FILE", &index).arg("write-tree")).await
}

pub async fn snapshot(project: &Path) -> Result<String> {
    let probe = git(project)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .await?;
    if probe.status.success() {
        let root = PathBuf::from(String::from_utf8_lossy(&probe.stdout).trim_end());
        return tree(&root).await;
    }

    // Check Git's file selection without initializing the project before a build
    // succeeds or requiring source storage on the target installation.
    let temporary = tempfile::tempdir()?;
    output(git(project).args(["init", "--bare"]).arg(temporary.path())).await?;
    output(
        git(project)
            .env("GIT_DIR", temporary.path())
            .env("GIT_WORK_TREE", project)
            .args(["add", "--all", "--", "."]),
    )
    .await?;
    output(
        git(project)
            .env("GIT_DIR", temporary.path())
            .env("GIT_WORK_TREE", project)
            .arg("write-tree"),
    )
    .await
}

async fn commit_all(project: &Path, branch: &str) -> Result<String> {
    let index =
        output(git(project).args(["rev-parse", "--path-format=absolute", "--git-path", "index"]))
            .await?;
    // Hold Git's normal index lock while committing with a separate index. Failed
    // hooks/signing leave the real index untouched; other Git writers cannot race
    // the successful replacement. Hooks inherit the separate index as usual.
    let lock_path = format!("{index}.lock");
    std::fs::File::create_new(&lock_path).map_err(|cause| {
        Error::invalid(format!(
            "Could not lock the Git index at {lock_path}: {cause}"
        ))
    })?;
    let lock = tempfile::TempPath::try_from_path(lock_path)?;
    let temporary = tempfile::tempdir()?;
    let pending = temporary.path().join("index");
    match copy_index(Path::new(&index), &pending) {
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    output(
        git(project)
            .env("GIT_INDEX_FILE", &pending)
            .args(["add", "--all", "--", "."]),
    )
    .await?;
    let mut command = git(project);
    command.env("GIT_INDEX_FILE", &pending);
    // A new agent workspace may not have a Git author configured yet.
    for (key, fallback) in [
        ("user.name", "Widefleet"),
        ("user.email", "noreply@widefleet.app"),
    ] {
        if !git(project)
            .args(["config", "--get", key])
            .output()
            .await?
            .status
            .success()
        {
            command.args(["-c", &format!("{key}={fallback}")]);
        }
    }
    output(command.args([
        "commit",
        "--allow-empty",
        "-m",
        &format!("Save source for {branch}"),
    ]))
    .await?;
    copy_index(&pending, &lock)?;
    lock.persist(&index).map_err(std::io::Error::from)?;
    revision(project, "HEAD")
        .await?
        .ok_or_else(|| Error::invalid("Git did not create a source commit".into()))
}

pub async fn confirm_deployment_branch(
    api: &Api,
    credentials: &auth::Credentials,
    project: &Path,
    target: &serde_json::Value,
    requested_branch: Option<&str>,
    allow_mismatch: bool,
) -> Result<bool> {
    #[derive(Deserialize)]
    struct Target {
        supported: bool,
        branch: String,
        preview: bool,
    }
    let token = auth::access_token(api, credentials).await?;
    let target: Target = json(
        api.authenticated(Method::POST, "/apps/source-target", &token)
            .json(target)
            .send()
            .await?,
    )
    .await?;
    if !target.supported {
        if requested_branch.is_some() {
            return Err(Error::invalid(
                "This installation does not provide Git repositories".into(),
            ));
        }
        return Ok(false);
    }
    if target.preview {
        let branch = require_preview_branch(project, requested_branch).await?;
        if branch != target.branch {
            return Err(Error::invalid(format!(
                "This preview is linked to branch {}. Switch to that branch or deploy a separate preview",
                target.branch
            )));
        }
        return Ok(true);
    }
    if requested_branch.is_some() {
        return Err(Error::invalid(
            "Use --source-branch only for Git previews. The main app saves source to main".into(),
        ));
    }
    let branch = &target.branch;
    let local = deployment_branch(project).await?;
    if local.as_deref() == Some(branch.as_str()) {
        return Ok(true);
    }
    let message = format!(
        "You are on {}. This deploy updates branch {branch} in Widefleet Git and publishes the code as the main app.",
        local.map_or_else(
            || "detached HEAD".into(),
            |name| format!("local branch {name}")
        ),
    );
    if allow_mismatch {
        eprintln!("{message}");
        return Ok(true);
    }
    let stdin = std::io::stdin();
    let stderr = std::io::stderr();
    if !stdin.is_terminal() || !stderr.is_terminal() {
        return Err(Error::invalid(format!(
            "{message} Switch to {branch}, or pass --allow-branch-mismatch to confirm this deployment"
        )));
    }
    confirm_branch(&message, &mut stdin.lock(), &mut stderr.lock())?;
    Ok(true)
}

async fn deployment_branch(project: &Path) -> Result<Option<String>> {
    let probe = git(project)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .await?;
    if !probe.status.success() {
        // Source saving initializes a new local repository on main.
        return Ok(Some("main".into()));
    }
    let head = git(project)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .await?;
    if head.status.code() == Some(1) {
        return Ok(None);
    }
    if !head.status.success() {
        return Err(Error::invalid(
            "Could not read the checked-out Git branch".into(),
        ));
    }
    Ok(Some(
        String::from_utf8(head.stdout)
            .map_err(|_| Error::invalid("Git branch name is not UTF-8".into()))?
            .trim()
            .to_owned(),
    ))
}

fn confirm_branch(message: &str, input: &mut impl BufRead, output: &mut impl Write) -> Result<()> {
    write!(output, "{message}\nContinue? [y/N] ")?;
    output.flush()?;
    let mut answer = String::new();
    input.read_line(&mut answer)?;
    if matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        Ok(())
    } else {
        Err(Error::invalid(
            "Deployment cancelled; no source was committed or pushed".into(),
        ))
    }
}

pub async fn require_preview_branch(
    project: &Path,
    requested_branch: Option<&str>,
) -> Result<String> {
    let head = git(project)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .await?;
    let branch = if head.status.success() {
        String::from_utf8(head.stdout)
            .map_err(|_| Error::invalid("Git branch name is not UTF-8".into()))?
            .trim()
            .to_owned()
    } else if head.status.code() == Some(1)
        && let Some(branch) = requested_branch
    {
        branch.to_owned()
    } else {
        return Err(Error::invalid(
            "A preview with source storage requires a Git work branch. For a detached CI checkout, pass --source-branch BRANCH".into(),
        ));
    };
    if branch == "main" {
        return Err(Error::invalid(
            "Create or switch to a work branch before deploying a preview. The main app uses main; no source was committed".into()
        ));
    }
    if requested_branch == Some("main") {
        return Err(Error::invalid(
            "A preview cannot save source to the main app's branch main. Choose a work branch"
                .into(),
        ));
    }
    if requested_branch.is_some_and(|requested| requested != branch) {
        return Err(Error::invalid(format!(
            "Preview source must use the checked-out branch {branch}. Switch branches before deploying another preview"
        )));
    }
    Ok(branch)
}

pub async fn save(
    api: &Api,
    credentials: &auth::Credentials,
    app: Uuid,
    project: &Path,
    branch: Option<&str>,
    before_build: &str,
) -> Result<Option<SourceRevision>> {
    let prepared = prepare(api, credentials, app).await?;
    let Some(repository) = prepared.repository else {
        if branch.is_some() {
            return Err(Error::invalid(
                "This installation does not provide Git repositories".into(),
            ));
        }
        return Ok(None);
    };
    if prepared.preview {
        let current = require_preview_branch(project, branch).await?;
        if current != repository.branch {
            return Err(Error::invalid(format!(
                "This preview is linked to branch {}. Switch to that branch or use widefleet preview to deploy {current} separately",
                repository.branch
            )));
        }
    }
    validate_url(&repository.url)?;
    let helper = helper(
        api,
        credentials,
        app,
        &prepared.organization_id,
        &repository.url,
        false,
    )?;
    Ok(Some(
        save_repository(project, repository, &helper, before_build).await?,
    ))
}

async fn save_repository(
    project: &Path,
    repository: SourceRepository,
    helper: &str,
    before_build: &str,
) -> Result<SourceRevision> {
    let project = project.canonicalize()?;
    let root = root(&project).await?;
    let source_tree = tree(&root).await?;
    if source_tree != before_build {
        return Err(Error::invalid(
            "Project files changed during the build. Review the changes and retry the deployment"
                .into(),
        ));
    }
    let reference = format!("refs/heads/{}", repository.branch);
    let remote = output(remote_git(&root, &repository.url, helper).args([
        "ls-remote",
        "--refs",
        &repository.url,
        &reference,
    ]))
    .await?;
    let remote_commit = remote.split_whitespace().next();
    if let Some(remote_commit) = remote_commit {
        output(remote_git(&root, &repository.url, helper).args([
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            &repository.url,
            &reference,
        ]))
        .await?;
        let head = revision(&root, "HEAD").await?;
        if !match head {
            Some(head) => is_ancestor(&root, remote_commit, &head).await?,
            None => false,
        } {
            return Err(Error::invalid(format!(
                "The {} branch contains changes missing from this checkout. Fetch and merge them before deploying; no source was overwritten",
                repository.branch
            )));
        }
    }
    let head = revision(&root, "HEAD").await?;
    let saved_commit = if let Some(head) = head
        && output(git(&root).args(["rev-parse", "HEAD^{tree}"])).await? == source_tree
    {
        head
    } else {
        commit_all(&root, &repository.branch).await?
    };
    let committed_tree =
        output(git(&root).args(["rev-parse", &format!("{saved_commit}^{{tree}}")])).await?;
    if committed_tree != source_tree {
        return Err(Error::invalid("Git changed project files while creating the commit. Retry the deployment to rebuild the committed source".into()));
    }
    // A normal push rejects a concurrently advanced remote; never force a source save.
    output(remote_git(&root, &repository.url, helper).args([
        "push",
        &repository.url,
        &format!("{saved_commit}:{reference}"),
    ]))
    .await?;
    let directory = project
        .strip_prefix(&root)
        .map_err(|cause| Error::invalid(cause.to_string()))?;
    let directory = if directory.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        directory.to_string_lossy().replace('\\', "/")
    };
    eprintln!("Source saved: {} at {}", repository.branch, saved_commit);
    Ok(SourceRevision {
        branch: repository.branch,
        commit: saved_commit,
        directory,
    })
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    match options.command {
        Action::Status { target } => {
            let id = apps::resolve(api, credentials, target.app.as_deref(), &target.config).await?;
            crate::print_json(&read(api, credentials, id).await?)
        }
        Action::Clone {
            app,
            directory,
            branch,
            read_only,
        } => {
            let id =
                apps::resolve(api, credentials, Some(&app), Path::new("wrangler.jsonc")).await?;
            let token = auth::access_token(api, credentials).await?;
            let app: App = json(
                api.authenticated(Method::GET, &format!("/apps/{id}"), &token)
                    .send()
                    .await?,
            )
            .await?;
            let source = read(api, credentials, id).await?;
            if let Some(error) = source.error {
                return Err(Error::invalid(error));
            }
            let repository = source
                .repository
                .ok_or_else(|| Error::invalid("This app has no saved source repository".into()))?;
            validate_url(&repository.url)?;
            let branch = branch.unwrap_or(repository.branch);
            let helper = helper(
                api,
                credentials,
                id,
                &app.organization_id,
                &repository.url,
                read_only,
            )?;
            output(
                remote_git(&std::env::current_dir()?, &repository.url, &helper)
                    .args([
                        "clone",
                        "--origin",
                        "widefleet",
                        "--branch",
                        &branch,
                        "--",
                        &repository.url,
                    ])
                    .arg(&directory),
            )
            .await?;
            configure(&directory, &repository.url, &helper).await?;
            crate::print_json(
                &value!({ "directory": directory, "branch": branch, "source": source.deployed }),
            )
        }
        Action::Connect { target, remote } => {
            let id = apps::resolve(api, credentials, target.app.as_deref(), &target.config).await?;
            let prepared = prepare(api, credentials, id).await?;
            let repository = prepared.repository.ok_or_else(|| {
                Error::invalid("This installation does not provide Git repositories".into())
            })?;
            validate_url(&repository.url)?;
            let path = target.config.canonicalize()?;
            let project =
                root(path.parent().ok_or_else(|| {
                    Error::invalid("Configuration has no parent directory".into())
                })?)
                .await?;
            let existing = git(&project)
                .args(["remote", "get-url", "--", &remote])
                .output()
                .await?;
            if existing.status.success() {
                if String::from_utf8_lossy(&existing.stdout).trim() != repository.url {
                    return Err(Error::invalid(format!(
                        "Remote {remote} already points elsewhere. Choose --remote NAME"
                    )));
                }
            } else {
                output(git(&project).args(["remote", "add", "--", &remote, &repository.url]))
                    .await?;
            }
            configure(
                &project,
                &repository.url,
                &helper(
                    api,
                    credentials,
                    id,
                    &prepared.organization_id,
                    &repository.url,
                    false,
                )?,
            )
            .await?;
            crate::print_json(&repository)
        }
        Action::Credential {
            app,
            read_only,
            repository_url,
            operation,
        } => {
            if operation != "get" {
                return Ok(());
            }
            let mut fields = std::collections::BTreeMap::new();
            for line in std::io::stdin().lock().lines() {
                let line = line?;
                if line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once('=') {
                    fields.insert(name.to_owned(), value.to_owned());
                }
            }
            let url = validate_url(&repository_url)?;
            let expected_host = match url.port() {
                Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
                None => url.host_str().unwrap_or_default().to_owned(),
            };
            if fields.get("protocol").map(String::as_str) != Some("https")
                || fields.get("host") != Some(&expected_host)
                || fields.get("path").map(String::as_str)
                    != Some(url.path().trim_start_matches('/'))
            {
                return Ok(());
            }
            #[derive(Deserialize)]
            struct Credential {
                url: String,
                username: String,
                password: String,
            }
            let token = auth::access_token(api, credentials).await?;
            let scope = if read_only { "read" } else { "write" };
            let credential: Credential = json(
                api.authenticated(
                    Method::POST,
                    &format!("/apps/{app}/source/{scope}-credential"),
                    &token,
                )
                .json(&value!({}))
                .send()
                .await?,
            )
            .await?;
            if credential.url != repository_url
                || credential.username.contains(['\r', '\n'])
                || credential.password.contains(['\r', '\n'])
            {
                return Err(Error::invalid("Invalid Git credential response".into()));
            }
            println!(
                "username={}\npassword={}\n",
                credential.username, credential.password
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_confirmation_requires_an_explicit_yes() {
        for answer in ["", "\n", "n\n", "no\n", "maybe\n"] {
            let mut prompt = Vec::new();
            assert!(
                confirm_branch(
                    "Deploy feature to main",
                    &mut answer.as_bytes(),
                    &mut prompt
                )
                .is_err()
            );
            assert!(String::from_utf8_lossy(&prompt).ends_with("Continue? [y/N] "));
        }
        for answer in ["y\n", "Y\n", "yes\n", "YES\n"] {
            assert!(
                confirm_branch(
                    "Deploy feature to main",
                    &mut answer.as_bytes(),
                    &mut Vec::new()
                )
                .is_ok()
            );
        }
    }

    #[tokio::test]
    async fn reads_branch_without_initializing_or_changing_the_checkout() -> Result<()> {
        let fixture = Fixture::new().await?;
        assert_eq!(
            deployment_branch(&fixture.project).await?,
            Some("main".into())
        );
        assert!(!fixture.project.join(".git").exists());
        output(git(&fixture.project).args(["init", "--initial-branch=feature"])).await?;
        assert_eq!(
            deployment_branch(&fixture.project).await?,
            Some("feature".into())
        );
        commit_all(&fixture.project, "feature").await?;
        output(git(&fixture.project).args(["checkout", "--detach", "HEAD"])).await?;
        assert_eq!(deployment_branch(&fixture.project).await?, None);
        Ok(())
    }

    struct Fixture {
        _temporary: tempfile::TempDir,
        project: PathBuf,
        remote: PathBuf,
    }

    impl Fixture {
        async fn new() -> Result<Self> {
            let temporary = tempfile::tempdir()?;
            let project = temporary.path().join("app");
            let remote = temporary.path().join("source.git");
            std::fs::create_dir(&project)?;
            output(
                git(temporary.path())
                    .args(["init", "--bare", "--initial-branch=main"])
                    .arg(&remote),
            )
            .await?;
            Ok(Self {
                _temporary: temporary,
                project,
                remote,
            })
        }
        fn repository(&self, branch: &str) -> SourceRepository {
            SourceRepository {
                url: self.remote.to_string_lossy().into_owned(),
                branch: branch.into(),
                commit: None,
            }
        }
        async fn save(&self, branch: &str) -> Result<SourceRevision> {
            save_repository(
                &self.project,
                self.repository(branch),
                "",
                &snapshot(&self.project).await?,
            )
            .await
        }
        async fn clone(&self, name: &str) -> Result<PathBuf> {
            let path = self._temporary.path().join(name);
            output(
                git(self._temporary.path())
                    .arg("clone")
                    .arg(&self.remote)
                    .arg(&path),
            )
            .await?;
            Ok(path)
        }
    }

    #[tokio::test]
    async fn saves_git_selection_without_extra_filters_and_reuses_clean_commits() -> Result<()> {
        let fixture = Fixture::new().await?;
        std::fs::write(
            fixture.project.join(".gitignore"),
            "ignored/\n*.local\n!keep.local\n",
        )?;
        std::fs::create_dir(fixture.project.join("ignored"))?;
        std::fs::write(fixture.project.join("ignored/skip.txt"), "ignored")?;
        for file in [".env", "keep.local", "skip.local", "app.ts"] {
            std::fs::write(fixture.project.join(file), file)?;
        }
        let first = fixture.save("main").await?;
        let files =
            output(git(&fixture.remote).args(["ls-tree", "-r", "--name-only", "main"])).await?;
        assert_eq!(files, ".env\n.gitignore\napp.ts\nkeep.local");
        assert_eq!(fixture.save("main").await?.commit, first.commit);
        std::fs::write(fixture.project.join("app.ts"), "second")?;
        let second = fixture.save("main").await?;
        assert_ne!(second.commit, first.commit);
        assert!(
            output(git(&fixture.project).args(["status", "--porcelain"]))
                .await?
                .is_empty()
        );
        assert!(is_ancestor(&fixture.project, &first.commit, &second.commit).await?);
        let clone = fixture.clone("next-session").await?;
        assert_eq!(std::fs::read_to_string(clone.join("app.ts"))?, "second");
        assert!(!clone.join("skip.local").exists());
        Ok(())
    }

    #[tokio::test]
    async fn captures_same_size_edits_with_racy_index_timestamps() -> Result<()> {
        let fixture = Fixture::new().await?;
        let app = fixture.project.join("app.ts");
        let timestamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let times = std::fs::FileTimes::new().set_modified(timestamp);
        std::fs::write(&app, "first!")?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&app)?
            .set_times(times)?;
        fixture.save("main").await?;
        output(git(&fixture.project).args(["config", "core.trustctime", "false"])).await?;
        let before = snapshot(&fixture.project).await?;
        let index = fixture.project.join(".git/index");
        std::fs::write(&app, "second")?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&app)?
            .set_times(times)?;
        // Simulate an edit within the index timestamp's resolution. Git must
        // rehash the contents even though size and cached mtime still match.
        std::fs::OpenOptions::new()
            .write(true)
            .open(&index)?
            .set_times(times)?;
        let staging = std::fs::read(&index)?;
        let after = snapshot(&fixture.project).await?;
        assert_ne!(after, before);
        assert_eq!(std::fs::read(&index)?, staging);
        let saved =
            save_repository(&fixture.project, fixture.repository("main"), "", &after).await?;
        assert_eq!(
            output(git(&fixture.project).args(["show", &format!("{}:app.ts", saved.commit)]))
                .await?,
            "second"
        );
        Ok(())
    }

    #[tokio::test]
    async fn tracks_ignored_files_already_in_git_and_records_deletions() -> Result<()> {
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("tracked.local"), "first")?;
        fixture.save("main").await?;
        std::fs::write(fixture.project.join(".gitignore"), "*.local\n")?;
        std::fs::write(fixture.project.join("tracked.local"), "changed")?;
        std::fs::write(fixture.project.join("new.local"), "ignored")?;
        fixture.save("main").await?;
        assert_eq!(
            output(git(&fixture.remote).args(["show", "main:tracked.local"])).await?,
            "changed"
        );
        std::fs::remove_file(fixture.project.join("tracked.local"))?;
        fixture.save("main").await?;
        assert_eq!(
            output(git(&fixture.remote).args(["ls-tree", "--name-only", "main"])).await?,
            ".gitignore"
        );
        Ok(())
    }

    #[tokio::test]
    async fn keeps_external_remote_and_preview_branch_independent() -> Result<()> {
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "main")?;
        let main = fixture.save("main").await?;
        output(git(&fixture.project).args([
            "remote",
            "add",
            "origin",
            "https://example.test/company/app.git",
        ]))
        .await?;
        std::fs::write(fixture.project.join("app.ts"), "preview")?;
        let preview = fixture.save("preview/search").await?;
        assert_eq!(revision(&fixture.remote, "main").await?, Some(main.commit));
        assert_eq!(
            revision(&fixture.remote, "preview/search").await?,
            Some(preview.commit)
        );
        assert_eq!(
            output(git(&fixture.project).args(["remote", "get-url", "origin"])).await?,
            "https://example.test/company/app.git"
        );
        Ok(())
    }

    #[tokio::test]
    async fn refuses_stale_checkout_without_overwriting_remote_or_local_changes() -> Result<()> {
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "first")?;
        fixture.save("main").await?;
        let other = fixture.clone("other").await?;
        std::fs::write(other.join("app.ts"), "newer remote")?;
        let saved = save_repository(
            &other,
            fixture.repository("main"),
            "",
            &snapshot(&other).await?,
        )
        .await?;
        std::fs::write(fixture.project.join("app.ts"), "local work")?;
        let before = revision(&fixture.project, "HEAD").await?;
        let failure = fixture
            .save("main")
            .await
            .err()
            .ok_or_else(|| Error::invalid("Expected conflict".into()))?;
        assert!(
            failure
                .to_string()
                .contains("changes missing from this checkout")
        );
        assert_eq!(revision(&fixture.remote, "main").await?, Some(saved.commit));
        assert_eq!(revision(&fixture.project, "HEAD").await?, before);
        assert_eq!(
            std::fs::read_to_string(fixture.project.join("app.ts"))?,
            "local work"
        );
        Ok(())
    }

    #[tokio::test]
    async fn rejects_source_changes_during_build_before_committing_or_pushing() -> Result<()> {
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "before build")?;
        let before = snapshot(&fixture.project).await?;
        assert!(!fixture.project.join(".git").exists());
        std::fs::write(fixture.project.join("app.ts"), "after build")?;
        let error = save_repository(&fixture.project, fixture.repository("main"), "", &before)
            .await
            .err()
            .ok_or_else(|| Error::invalid("Expected changed source to fail".into()))?;
        assert!(error.to_string().contains("changed during the build"));
        assert_eq!(revision(&fixture.project, "HEAD").await?, None);
        assert_eq!(revision(&fixture.remote, "main").await?, None);
        assert_eq!(
            std::fs::read_to_string(fixture.project.join("app.ts"))?,
            "after build"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preserves_partial_staging_when_a_commit_hook_rejects_the_save() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "committed")?;
        let first = fixture.save("main").await?;
        std::fs::write(fixture.project.join("app.ts"), "staged")?;
        output(git(&fixture.project).args(["add", "app.ts"])).await?;
        std::fs::write(fixture.project.join("app.ts"), "unstaged")?;
        std::fs::write(fixture.project.join("new.ts"), "untracked")?;
        let index = fixture.project.join(".git/index");
        let before = std::fs::read(&index)?;
        let hook = fixture.project.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n")?;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700))?;
        assert!(fixture.save("main").await.is_err());
        assert_eq!(std::fs::read(&index)?, before);
        assert_eq!(
            output(git(&fixture.project).args(["show", ":app.ts"])).await?,
            "staged"
        );
        assert_eq!(
            output(git(&fixture.project).args(["ls-files", "new.ts"])).await?,
            ""
        );
        assert_eq!(
            std::fs::read_to_string(fixture.project.join("app.ts"))?,
            "unstaged"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.project.join("new.ts"))?,
            "untracked"
        );
        assert_eq!(
            revision(&fixture.project, "HEAD").await?,
            Some(first.commit.clone())
        );
        assert_eq!(revision(&fixture.remote, "main").await?, Some(first.commit));
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn locks_out_other_staging_until_a_failed_commit_finishes() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "committed")?;
        let first = fixture.save("main").await?;
        std::fs::write(fixture.project.join("app.ts"), "staged")?;
        output(git(&fixture.project).args(["add", "app.ts"])).await?;
        std::fs::write(fixture.project.join("app.ts"), "unstaged")?;
        let index = fixture.project.join(".git/index");
        let before = std::fs::read(&index)?;
        let hook = fixture.project.join(".git/hooks/pre-commit");
        std::fs::write(
            &hook,
            "#!/bin/sh\nprintf concurrent > app.ts\nGIT_INDEX_FILE=\"$PWD/.git/index\" git add app.ts 2> .git/writer-error\nexit 1\n",
        )?;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700))?;
        assert!(fixture.save("main").await.is_err());
        assert!(
            std::fs::read_to_string(fixture.project.join(".git/writer-error"))?
                .contains("index.lock")
        );
        assert_eq!(std::fs::read(&index)?, before);
        assert_eq!(
            output(git(&fixture.project).args(["show", ":app.ts"])).await?,
            "staged"
        );
        assert_eq!(
            revision(&fixture.project, "HEAD").await?,
            Some(first.commit.clone())
        );
        assert_eq!(revision(&fixture.remote, "main").await?, Some(first.commit));
        assert!(!fixture.project.join(".git/index.lock").exists());
        output(git(&fixture.project).args(["add", "app.ts"])).await?;
        assert_eq!(
            output(git(&fixture.project).args(["show", ":app.ts"])).await?,
            "concurrent"
        );
        Ok(())
    }

    #[tokio::test]
    async fn leaves_an_existing_index_lock_and_staging_untouched() -> Result<()> {
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "committed")?;
        let first = fixture.save("main").await?;
        std::fs::write(fixture.project.join("app.ts"), "staged")?;
        output(git(&fixture.project).args(["add", "app.ts"])).await?;
        std::fs::write(fixture.project.join("app.ts"), "unstaged")?;
        let index = fixture.project.join(".git/index");
        let before = std::fs::read(&index)?;
        let lock = fixture.project.join(".git/index.lock");
        std::fs::write(&lock, "another Git operation")?;
        assert!(fixture.save("main").await.is_err());
        assert_eq!(std::fs::read_to_string(&lock)?, "another Git operation");
        assert_eq!(std::fs::read(&index)?, before);
        assert_eq!(
            revision(&fixture.project, "HEAD").await?,
            Some(first.commit.clone())
        );
        assert_eq!(revision(&fixture.remote, "main").await?, Some(first.commit));
        Ok(())
    }

    #[tokio::test]
    async fn saves_existing_monorepo_and_reports_app_directory() -> Result<()> {
        let fixture = Fixture::new().await?;
        root(&fixture.project).await?;
        let app = fixture.project.join("apps/mail");
        std::fs::create_dir_all(&app)?;
        std::fs::write(app.join("app.ts"), "source")?;
        std::fs::write(fixture.project.join("package.json"), "{}")?;
        let saved =
            save_repository(&app, fixture.repository("main"), "", &snapshot(&app).await?).await?;
        assert_eq!(saved.directory, "apps/mail");
        assert_eq!(
            output(git(&fixture.remote).args(["ls-tree", "-r", "--name-only", "main"])).await?,
            "apps/mail/app.ts\npackage.json"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn saves_projects_accessed_through_a_symlink() -> Result<()> {
        let fixture = Fixture::new().await?;
        root(&fixture.project).await?;
        let app = fixture.project.join("apps/mail");
        std::fs::create_dir_all(&app)?;
        std::fs::write(app.join("app.ts"), "source")?;
        let alias = fixture._temporary.path().join("linked-project");
        std::os::unix::fs::symlink(&fixture.project, &alias)?;
        let saved = save_repository(
            &alias.join("apps/mail"),
            fixture.repository("main"),
            "",
            &snapshot(&alias).await?,
        )
        .await?;
        assert_eq!(saved.directory, "apps/mail");
        assert_eq!(
            output(git(&fixture.remote).args(["show", "main:apps/mail/app.ts"])).await?,
            "source"
        );
        let saved_root = save_repository(
            &alias,
            fixture.repository("main"),
            "",
            &snapshot(&alias).await?,
        )
        .await?;
        assert_eq!(saved_root.directory, ".");
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_source_changed_by_commit_hooks_until_it_is_rebuilt() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "first")?;
        let first = fixture.save("main").await?;
        let hook = fixture.project.join(".git/hooks/pre-commit");
        std::fs::write(
            &hook,
            "#!/bin/sh\nprintf formatted > app.ts\ngit add app.ts\n",
        )?;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700))?;
        std::fs::write(fixture.project.join("app.ts"), "changed")?;
        let error =
            fixture.save("main").await.err().ok_or_else(|| {
                Error::invalid("Expected source change to stop deployment".into())
            })?;
        assert!(
            error
                .to_string()
                .contains("Retry the deployment to rebuild")
        );
        assert_eq!(revision(&fixture.remote, "main").await?, Some(first.commit));
        let retried = fixture.save("main").await?;
        assert_eq!(
            revision(&fixture.remote, "main").await?,
            Some(retried.commit)
        );
        assert_eq!(
            output(git(&fixture.remote).args(["show", "main:app.ts"])).await?,
            "formatted"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn saves_the_built_source_when_working_files_change_after_the_commit() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "first")?;
        fixture.save("main").await?;
        let hook = fixture.project.join(".git/hooks/post-commit");
        std::fs::write(&hook, "#!/bin/sh\nprintf 'next edit' > app.ts\n")?;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700))?;
        std::fs::write(fixture.project.join("app.ts"), "built source")?;
        let saved = fixture.save("main").await?;
        assert_eq!(
            revision(&fixture.remote, "main").await?,
            Some(saved.commit.clone())
        );
        assert_eq!(
            output(git(&fixture.remote).args(["show", &format!("{}:app.ts", saved.commit)]))
                .await?,
            "built source"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.project.join("app.ts"))?,
            "next edit"
        );
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_a_remote_update_between_fetch_and_push() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new().await?;
        std::fs::write(fixture.project.join("app.ts"), "first")?;
        fixture.save("main").await?;
        let other = fixture.clone("concurrent").await?;
        std::fs::write(other.join("app.ts"), "concurrent change")?;
        output(git(&other).args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-am",
            "Concurrent change",
        ]))
        .await?;
        let concurrent = output(git(&other).args(["rev-parse", "HEAD"])).await?;
        let hook = fixture.project.join(".git/hooks/pre-push");
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\ngit --git-dir={} --work-tree={} push {} {}:refs/heads/main\n",
                quote(&other.join(".git").to_string_lossy()),
                quote(&other.to_string_lossy()),
                quote(&fixture.remote.to_string_lossy()),
                concurrent
            ),
        )?;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700))?;
        std::fs::write(fixture.project.join("app.ts"), "local change")?;
        assert!(fixture.save("main").await.is_err());
        assert_eq!(revision(&fixture.remote, "main").await?, Some(concurrent));
        Ok(())
    }
}
