use crate::auth;
use platform_core::{
    Error, Result,
    http::{Api, json},
    model::App,
};
use reqwest::Method;
use serde::Deserialize;
use std::path::Path;
use uuid::Uuid;

/// Resolve an existing app by explicit name/ID or project context, without creating one.
pub async fn resolve(
    api: &Api,
    credentials: &auth::Credentials,
    app: Option<&str>,
    config: &Path,
) -> Result<Uuid> {
    if let Some(id) = app.and_then(|value| Uuid::parse_str(value).ok()) {
        return Ok(id);
    }
    #[derive(Deserialize)]
    struct Project {
        name: String,
    }
    let name = match app {
        Some(name) => name.to_owned(),
        None => {
            let text = std::fs::read_to_string(config).map_err(|cause| Error::invalid(format!(
                "Choose --app NAME or run this command from an app project; could not read {}: {cause}", config.display()
            )))?;
            let project: Project =
                jsonc_parser::parse_to_serde_value(&text, &jsonc_parser::ParseOptions::default())
                    .map_err(|cause| Error::invalid(format!("Could not read app name: {cause}")))?;
            project.name
        }
    };
    if name.is_empty()
        || name.len() > 48
        || !name
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-')
    {
        return Err(Error::invalid(
            "Use the app's name from its project configuration".into(),
        ));
    }
    let token = auth::access_token(api, credentials).await?;
    let app: App = json(
        api.authenticated(Method::GET, &format!("/apps/by-name/{name}"), &token)
            .send()
            .await?,
    )
    .await?;
    Ok(app.id)
}
