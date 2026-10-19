use platform_core::{Result, model::ModuleType};
use reqwest::multipart::{Form, Part};
use serde::Serialize;

pub(crate) fn worker<'a>(
    metadata: &impl Serialize,
    modules: impl IntoIterator<Item = (&'a str, &'a ModuleType, &'a [u8])>,
) -> Result<Form> {
    let mut form = Form::new().text("metadata", serde_json::to_string(metadata)?);
    for (name, kind, bytes) in modules {
        let mime = match kind {
            ModuleType::Esm => "application/javascript+module",
            ModuleType::Wasm => "application/wasm",
            ModuleType::Text => "text/plain",
            ModuleType::Data => "application/octet-stream",
            ModuleType::Sourcemap => "application/source-map+json",
        };
        form = form.part(
            name.to_owned(),
            Part::bytes(bytes.to_vec())
                .file_name(name.to_owned())
                .mime_str(mime)?,
        );
    }
    Ok(form)
}

pub(crate) async fn publish<T: serde::de::DeserializeOwned>(
    api: &platform_core::http::Api,
    credentials: &crate::auth::Credentials,
    path: &str,
    metadata: &impl Serialize,
    modules: &[(String, ModuleType, Vec<u8>)],
) -> Result<T> {
    let request_id = uuid::Uuid::new_v4();
    // Retrying a lost response must retain both the request identity and uploaded bytes.
    for attempt in 0..3 {
        let form = worker(
            metadata,
            modules
                .iter()
                .map(|(name, kind, bytes)| (name.as_str(), kind, bytes.as_slice())),
        )?;
        let token = crate::auth::access_token(api, credentials).await?;
        let sent = api
            .authenticated(reqwest::Method::PUT, path, &token)
            .header("idempotency-key", request_id.to_string())
            .multipart(form)
            .send()
            .await;
        match sent {
            Ok(response) if response.status().is_server_error() && attempt < 2 => {}
            Ok(response) => return platform_core::http::json(response).await,
            Err(_) if attempt < 2 => {}
            Err(error) => return Err(error.into()),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Err(platform_core::Error::invalid(
        "Deployment upload failed".into(),
    ))
}
