use oxc_sourcemap::SourceMap;
use platform_core::{Error, Result};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_compiler::{Program, ProgramOptions, new_compiler_host, new_program};
use tsrs_core::{ModuleKind, ModuleResolutionKind, P, ScriptTarget, Tristate, tspath};
use tsrs_tsoptions::{ParseConfigHost, ParsedCommandLine};
use tsrs_vfs::{FS, bundled, osvfs, wrapvfs};

struct ConfigHost {
    fs: Arc<dyn FS>,
    directory: String,
}
impl ParseConfigHost for ConfigHost {
    fn fs(&self) -> &dyn FS {
        self.fs.as_ref()
    }
    fn get_current_directory(&self) -> &str {
        &self.directory
    }
}

pub struct Sources<'a> {
    pub map: SourceMap<'a>,
    pub originals: Arc<BTreeMap<String, String>>,
    pub bundle: String,
}

impl<'a> Sources<'a> {
    pub fn new(project: &Path, bundle: &Path, map: &'a str) -> Result<Self> {
        let map = SourceMap::from_json_string(map)
            .map_err(|error| Error::invalid(format!("Cannot read API source map: {error}")))?;
        let project = compiler_path(&project.to_string_lossy());
        let bundle = compiler_path(&bundle.to_string_lossy());
        let mut originals = BTreeMap::new();
        for (source, content) in map.get_sources().zip(map.get_source_contents()) {
            if let (Some(source), Some(content)) = (source, content) {
                let file = source_path(&bundle, &map, source);
                if Path::new(&file).starts_with(&project)
                    && !Path::new(&file)
                        .components()
                        .any(|part| part.as_os_str() == "node_modules")
                {
                    originals.insert(file, content.into());
                }
            }
        }
        Ok(Self {
            map,
            originals: Arc::new(originals),
            bundle,
        })
    }

    pub fn program(&self, project: &Path) -> &'static Program {
        let reads = self.originals.clone();
        let exists = self.originals.clone();
        let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(wrapvfs::wrap(
            osvfs::fs(),
            wrapvfs::Replacements {
                read_file: Some(Box::new(move |file| {
                    reads
                        .get(&tspath::normalize_path(file))
                        .cloned()
                        .or_else(|| osvfs::fs().read_file(file))
                })),
                file_exists: Some(Box::new(move |file| {
                    exists.contains_key(&tspath::normalize_path(file))
                        || osvfs::fs().file_exists(file)
                })),
                ..Default::default()
            },
        )));
        let host = ConfigHost {
            fs: fs.clone(),
            directory: compiler_path(&project.to_string_lossy()),
        };
        let config_path = project
            .ancestors()
            .map(|directory| directory.join("tsconfig.json"))
            .find(|file| file.is_file());
        let mut config = if let Some(config_path) = config_path {
            tsrs_tsoptions::get_parsed_command_line_of_config_file(
                &compiler_path(&config_path.to_string_lossy()),
                None,
                None,
                &host,
                None,
            )
            .0
            .unwrap_or_else(ParsedCommandLine::empty)
        } else {
            ParsedCommandLine::empty()
        };
        let mut options = config
            .parsed_config
            .compiler_options
            .as_deref()
            .cloned()
            .unwrap_or_default();
        if options.target == ScriptTarget::NONE {
            options.target = ScriptTarget::ES2022;
        }
        if options.module == ModuleKind::NONE {
            options.module = ModuleKind::ES_NEXT;
        }
        if options.module_resolution == ModuleResolutionKind::UNKNOWN {
            options.module_resolution = ModuleResolutionKind::BUNDLER;
        }
        if options.strict == Tristate::Unknown {
            options.strict = Tristate::True;
        }
        options.allow_js = Tristate::True;
        options.check_js = Tristate::False;
        options.no_emit = Tristate::True;
        config.parsed_config.compiler_options = Some(P::new(options));
        config.parsed_config.file_names.push(self.bundle.clone());
        config
            .parsed_config
            .file_names
            .extend(self.originals.keys().cloned());
        config.parsed_config.file_names.sort();
        config.parsed_config.file_names.dedup();
        let compiler_host =
            new_compiler_host(&host.directory, fs, &bundled::lib_path(), None, None, None);
        let mut options = ProgramOptions::new(P::new(config), compiler_host);
        options.single_threaded = Tristate::True;
        new_program(options)
    }

    pub fn original(
        &self,
        program: &Program,
        bundle: P<SourceFile>,
        node: P<Node>,
        lookup: &[&[oxc_sourcemap::Token]],
    ) -> Option<P<Node>> {
        let anchor = if ast::is_class_like(node) {
            node.name().unwrap_or(node)
        } else {
            node
        };
        let position = tsrs_scanner::skip_trivia(bundle.text(), anchor.pos().source_offset()?);
        let (line, column) =
            tsrs_scanner::get_ecma_line_and_utf16_character_of_position(bundle.get(), position);
        let token = self
            .map
            .lookup_source_view_token(lookup, line as u32, column)?;
        let file = source_path(&self.bundle, &self.map, token.get_source()?);
        if !self.originals.contains_key(&file) {
            return None;
        }
        let source = program.get_source_file(&file)?;
        let starts = tsrs_scanner::get_ecma_line_starts(source.get());
        if token.get_src_line() as usize >= starts.len() {
            return None;
        }
        let position = tsrs_scanner::compute_position_of_line_and_utf16_character(
            starts,
            token.get_src_line() as usize,
            token.get_src_col(),
            source.text(),
            true,
        );
        let mut node = at_position(source.as_node(), position);
        loop {
            if ast::is_class_like(node) || node.kind() == Kind::ObjectLiteralExpression {
                return Some(node);
            }
            node = node.parent()?;
        }
    }
}

fn source_path(bundle: &str, map: &SourceMap<'_>, source: &str) -> String {
    if let Ok(url) = reqwest::Url::parse(source)
        && let Ok(file) = url.to_file_path()
    {
        return compiler_path(&file.to_string_lossy());
    }
    tspath::get_normalized_absolute_path(
        &compiler_path(source),
        &tspath::get_normalized_absolute_path(
            &compiler_path(map.get_source_root().unwrap_or("")),
            &tspath::get_directory_path(bundle),
        ),
    )
}

pub(super) fn compiler_path(path: &str) -> String {
    let path = tspath::normalize_slashes(path);
    // Rust canonicalizes local Windows paths as \\?\C:\..., which tsrs's
    // filesystem rejects as a device/network path. Preserve the local drive.
    let local = path
        .strip_prefix("//?/")
        .filter(|rest| matches!(rest.as_bytes(), [b'a'..=b'z' | b'A'..=b'Z', b':', b'/', ..]));
    tspath::normalize_path(local.unwrap_or(&path))
}

fn at_position(node: P<Node>, position: u32) -> P<Node> {
    for child in node.iter_children() {
        if child
            .pos()
            .source_offset()
            .is_some_and(|start| start <= position)
            && child
                .end()
                .source_offset()
                .is_some_and(|end| end > position)
        {
            return at_position(child, position);
        }
    }
    node
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_paths_keep_bundles_and_originals_in_the_same_project() -> Result<()> {
        let map = serde_json::json!({
            "version": 3,
            "sources": ["../app.ts", "../node_modules/dependency.ts", "../../outside.ts"],
            "sourcesContent": ["export class Service {}", "dependency", "outside"],
            "names": [],
            "mappings": ""
        })
        .to_string();
        for (project, bundle, expected) in [
            (
                "/apps/docs project",
                "/apps/docs project/build/worker.js",
                "/apps/docs project",
            ),
            (
                r"C:\apps\docs project",
                r"C:\apps\docs project\build\worker.js",
                "C:/apps/docs project",
            ),
            (
                r"\\?\C:\apps\docs project",
                r"\\?\C:\apps\docs project\build\worker.js",
                "C:/apps/docs project",
            ),
        ] {
            let sources = Sources::new(Path::new(project), Path::new(bundle), &map)?;
            assert_eq!(sources.bundle, format!("{expected}/build/worker.js"));
            assert!(!tspath::is_network_path(&sources.bundle));
            assert_eq!(sources.originals.len(), 1);
            assert_eq!(
                sources
                    .originals
                    .get(&format!("{expected}/app.ts"))
                    .map(String::as_str),
                Some("export class Service {}")
            );
        }
        Ok(())
    }
}
