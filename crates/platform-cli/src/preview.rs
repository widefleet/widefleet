use crate::{apps, auth, deploy};
use clap::Args;
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::App,
};
use reqwest::{Method, StatusCode};
use serde_json::json as value;
use tokio::process::Command;
use uuid::Uuid;

#[derive(Args)]
pub struct Options {
    /// Parent app name or ID; otherwise use the current project's name.
    #[arg(long)]
    app: Option<String>,
    /// Preview name; otherwise use the current Git branch.
    #[arg(long)]
    name: Option<String>,
    #[command(flatten)]
    deployment: deploy::Options,
}

pub struct Target {
    parent: Uuid,
    slug: String,
    display_name: String,
    name: String,
    hostname: String,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 48
        && name.starts_with(|ch: char| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && name.ends_with(|ch: char| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && name
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-')
}

fn shorten_slug(slug: &str) -> String {
    if slug.len() <= 48 {
        return slug.to_owned();
    }
    format!(
        "{}-{}",
        slug[..39].trim_end_matches('-'),
        &platform_core::sha256(slug.as_bytes())[..8]
    )
}

fn branch_name(branch: &str) -> String {
    let normalized = branch
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    if normalized == branch {
        shorten_slug(branch)
    } else {
        let prefix = if normalized.is_empty() {
            "branch"
        } else {
            &normalized
        };
        shorten_slug(&format!(
            "{prefix}-{}",
            &platform_core::sha256(branch.as_bytes())[..8]
        ))
    }
}

pub async fn run(api: &Api, credentials: &auth::Credentials, options: Options) -> Result<()> {
    let name = match options.name {
        Some(name) => name,
        None => {
            let config = options.deployment.config.canonicalize()?;
            let project = config
                .parent()
                .ok_or_else(|| Error::invalid("Configuration has no parent directory".into()))?;
            let output = Command::new("git")
                .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
                .current_dir(project)
                .output()
                .await;
            let branch = output.ok().filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .filter(|branch| !branch.trim().is_empty())
                .ok_or_else(|| Error::invalid("Choose --name NAME when Git is unavailable, outside a Git repository, or on a detached HEAD".into()))?;
            branch_name(branch.trim())
        }
    };
    if !valid_name(&name) {
        return Err(Error::invalid(
            "Use a preview name with 1-48 lowercase letters, digits or internal hyphens".into(),
        ));
    }
    let parent_id = apps::resolve(
        api,
        credentials,
        options.app.as_deref(),
        &options.deployment.config,
    )
    .await?;
    let token = auth::access_token(api, credentials).await?;
    let parent: App = json(
        api.authenticated(Method::GET, &format!("/apps/{parent_id}"), &token)
            .send()
            .await?,
    )
    .await?;
    if parent.state == "deleting" {
        return Err(Error::invalid("The parent app is being deleted".into()));
    }
    if parent.parent_id.is_some() {
        return Err(Error::invalid(
            "Choose the original app as --app; a preview cannot be the parent of another preview"
                .into(),
        ));
    }
    let slug = shorten_slug(&format!("{}-{name}", parent.slug));
    eprintln!(
        "Preview: {name} of {} on {}",
        parent.slug,
        api.origin_text()
    );
    deploy::run(
        api,
        credentials,
        deploy::Target::Preview(Target {
            parent: parent.id,
            slug,
            display_name: format!("{} ({name})", parent.slug),
            hostname: format!("{name}.{}", parent.hostname),
            name,
        }),
        options.deployment,
    )
    .await
}

impl Target {
    // Called only after the local build, bundling and asset validation have succeeded.
    pub async fn resolve(self, api: &Api, credentials: &auth::Credentials) -> Result<Uuid> {
        let path = format!("/apps/by-name/{}", self.slug);
        let token = auth::access_token(api, credentials).await?;
        let response = api.authenticated(Method::GET, &path, &token).send().await?;
        let app: App = if response.status() == StatusCode::NOT_FOUND {
            let token = auth::access_token(api, credentials).await?;
            let response = api
                .authenticated(Method::POST, "/apps", &token)
                .json(&value!({
                    "slug": self.slug,
                    "displayName": self.display_name,
                    "parentId": self.parent,
                    "previewName": self.name,
                }))
                .send()
                .await?;
            if response.status() == StatusCode::CONFLICT {
                // Another invocation may have created this preview after the lookup.
                let token = auth::access_token(api, credentials).await?;
                let existing = api.authenticated(Method::GET, &path, &token).send().await?;
                if existing.status() == StatusCode::NOT_FOUND {
                    json(response).await?
                } else {
                    json(existing).await?
                }
            } else {
                json(response).await?
            }
        } else {
            json(response).await?
        };
        if app.parent_id != Some(self.parent) || app.id == self.parent || app.slug != self.slug {
            return Err(Error::invalid(format!(
                "The name {} belongs to a different app. Choose another --name; no code was uploaded",
                self.slug
            )));
        }
        if app.state == "deleting" {
            return Err(Error::invalid("The preview is being deleted".into()));
        }
        if app.hostname != self.hostname {
            return Err(Error::invalid(format!(
                "The preview does not use {}. Choose another --name for an existing legacy preview, or upgrade the management server; no code was uploaded",
                self.hostname
            )));
        }
        eprintln!("Deploying preview {} ({})", app.slug, app.id);
        Ok(app.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_explicit_names() {
        for name in ["review", "pr-42", "42", "feature-login"] {
            assert!(valid_name(name));
        }
        for name in [
            "",
            "Review",
            "feature/login",
            "-review",
            "review-",
            "a.b",
            "ümlaut",
        ] {
            assert!(!valid_name(name));
        }
        assert!(!valid_name(&"a".repeat(49)));
    }

    #[test]
    fn branch_names_are_stable_and_do_not_merge_after_normalization() {
        assert_eq!(branch_name("review"), "review");
        for branch in ["feature/login", "Feature-Login", "ä", &"x".repeat(100)] {
            assert!(valid_name(&branch_name(branch)));
        }
        assert_ne!(branch_name("feature/login"), branch_name("feature-login"));
        assert_ne!(branch_name("feature/login"), branch_name("feature_login"));
    }

    #[test]
    fn long_app_names_keep_a_stable_distinct_preview_identity() {
        let parent = "a".repeat(48);
        let first = shorten_slug(&format!("{parent}-review"));
        let second = shorten_slug(&format!("{parent}-other"));
        assert!(valid_name(&first));
        assert_eq!(first.len(), 48);
        assert_ne!(first, parent);
        assert_ne!(first, second);
    }
}
