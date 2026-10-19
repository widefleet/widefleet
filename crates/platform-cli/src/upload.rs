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
