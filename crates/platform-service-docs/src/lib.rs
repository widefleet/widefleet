mod comments;
mod sources;
mod types;

use comments::documentation;
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};
use tsrs_ast::{self as ast, Kind, Node, Symbol, SymbolFlags};
use tsrs_checker::Checker;
use tsrs_compiler::Context;
use tsrs_core::P;
use tsrs_vfs::FS;
use types::Types;

pub use sources::compiler_path;

/// A documentation failure that prevents deployment.
#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn empty() -> Value {
    json!({"format": 3, "entrypoints": [], "types": []})
}

/// Documents the service entrypoints of a bundled Worker.
///
/// `fs` serves the project, its dependencies' declarations and the bundle at
/// `bundle`; `map` is the bundle's external source map. Native builds pass the
/// operating system's file system, WebAssembly builds a host file system.
///
/// Without `entry`, exports are read from the bundle and mapped back to their
/// original declarations through the source map, which also covers builds that
/// generate the entry module. With `entry`, the original entry module is checked
/// directly; the program then excludes the bundled dependencies, which keeps
/// memory use low enough for a Worker.
pub fn extract(
    fs: &'static dyn FS,
    project: &str,
    bundle: &str,
    map: &str,
    entry: Option<&str>,
    entrypoints: &[String],
) -> Result<Value> {
    if entrypoints.is_empty() {
        return Ok(empty());
    }
    let sources = sources::Sources::new(project, bundle, map)?;
    let program = sources.program(fs, project, entry);
    let module_file = entry.map_or_else(|| sources.bundle.clone(), compiler_path);
    let source = program
        .get_source_file(&module_file)
        .ok_or_else(|| Error("Cannot read bundled service exports".into()))?;
    let mut checker = program.get_type_checker(&Context::default());
    let module = checker
        .get_symbol_at_location_exported(source.as_node())
        .ok_or_else(|| Error("Cannot read bundled service exports".into()))?;
    let mut entries = Vec::new();
    let mut types = Types::new(project);
    let lookup = sources.map.generate_lookup_table();
    for symbol in checker.get_exports_of_module_exported(module) {
        if !entrypoints.iter().any(|name| name == symbol.name()) {
            continue;
        }
        let Some(compiled) = declaration(symbol, &mut checker) else {
            continue;
        };
        let original = if entry.is_some() {
            original_declaration(compiled, &mut checker)
                .filter(|node| app_source(*node, &sources.project))
        } else {
            sources.original(program, source, compiled, &lookup)
        };
        let Some(node) = original else {
            if ast::is_class_like(compiled) && entry.is_none() {
                eprintln!(
                    "Warning: Cannot recover source for service {}; preserve source maps in the app build.",
                    symbol.name()
                );
            }
            continue;
        };
        let class = ast::is_class_like(node);
        if class && !worker_class(node, &mut checker, &mut HashSet::new())
            || !class && symbol.name() != "default"
        {
            continue;
        }
        let instance = checker.get_type_at_location(node);
        let mut methods = Vec::new();
        let mut http = false;
        for &property in checker.get_properties_of_type_exported(instance) {
            let Some(member) = property
                .value_declaration()
                .or_else(|| property.declarations().first().copied())
            else {
                continue;
            };
            if ast::get_source_file_of_node(member).is_none_or(|file| file.is_declaration_file()) {
                continue;
            }
            if property.name() == "fetch" {
                http = true;
                continue;
            }
            if !rpc_method(property.name())
                || class && member.kind() != Kind::MethodDeclaration
                || member
                    .name()
                    .is_some_and(|name| name.kind() == Kind::PrivateIdentifier)
            {
                continue;
            }
            let handler = if member.kind() == Kind::MethodDeclaration {
                Some(member)
            } else {
                member.initializer().filter(|node| {
                    matches!(node.kind(), Kind::ArrowFunction | Kind::FunctionExpression)
                })
            };
            if !class && let Some(handler) = handler {
                let arity = handler
                    .parameters()
                    .iter()
                    .position(|node| {
                        node.initializer().is_some()
                            || node
                                .as_parameter_declaration()
                                .dot_dot_dot_token()
                                .is_some()
                    })
                    .unwrap_or(handler.parameters().len());
                if arity > 3 {
                    continue;
                }
            }
            let Some(callable_type) =
                checker.get_type_of_symbol_at_location(property, Some(member))
            else {
                continue;
            };
            let callable = checker.get_call_signatures(callable_type);
            if callable.is_empty() {
                continue;
            }
            if callable.len() > 16 {
                eprintln!(
                    "Warning: Only the first 16 overloads of {}.{} are documented; the remaining overloads are still callable.",
                    symbol.name(),
                    property.name()
                );
            }
            let doc = documentation(member);
            let mut signatures = Vec::new();
            for &signature in callable.iter().take(16) {
                types.start_signature();
                // Object handlers document only their input; the runtime passes the rest.
                let documented_parameters = if class { usize::MAX } else { 1 };
                types.declaration_references(
                    &mut checker,
                    signature.declaration().unwrap_or(member),
                    documented_parameters,
                );
                let signature_doc = documentation(signature.declaration().unwrap_or(member));
                let mut parameters = Vec::new();
                for &parameter in signature.parameters().iter().take(documented_parameters) {
                    let param = parameter.value_declaration().unwrap_or(member);
                    let parameter_type = checker
                        .get_type_of_symbol_at_location(parameter, Some(param))
                        .unwrap_or_else(|| checker.get_type_at_location(param));
                    parameters.push(json!({
                        "name": parameter.name(), "type": types.text(&mut checker, parameter_type),
                        "description": signature_doc.parameters.get(parameter.name()).map(String::as_str).unwrap_or(""),
                        "optional": param.kind() == Kind::Parameter && (param.question_token().is_some() || param.initializer().is_some()),
                        "rest": param.kind() == Kind::Parameter && param.as_parameter_declaration().dot_dot_dot_token().is_some()
                    }));
                }
                let result = checker.get_return_type_of_signature_exported(signature);
                let awaited = checker.get_awaited_type_exported(result).unwrap_or(result);
                let mut documented = json!({"parameters": parameters, "returns": {"type": format!("Promise<{}>", types.text(&mut checker, awaited)), "description": signature_doc.returns}});
                if !signature.type_parameters().is_empty() {
                    documented["typeParameters"] = json!(
                        signature
                            .type_parameters()
                            .iter()
                            .map(|&parameter| types.type_parameter(&mut checker, parameter))
                            .collect::<Vec<_>>()
                    );
                }
                signatures.push(documented);
            }
            let mut method = serde_json::to_value(doc.comment)?;
            method["name"] = json!(property.name());
            method["throws"] = json!(doc.throws);
            method["signatures"] = json!(signatures);
            methods.push(method);
        }
        if !methods.is_empty() || http {
            let mut entry = serde_json::to_value(documentation(node).comment)?;
            entry["name"] = json!(symbol.name());
            entry["http"] = json!(http);
            entry["methods"] = json!(methods);
            entries.push(entry);
        }
    }
    let Some(definitions) = types.definitions(&mut checker) else {
        eprintln!(
            "Warning: API documentation was omitted because it exceeds supported limits. Deployment continues."
        );
        return Ok(empty());
    };
    // Signatures were started in this order, so their uses line up.
    let mut uses = types.signature_uses().iter();
    for entry in &mut entries {
        for method in entry["methods"].as_array_mut().into_iter().flatten() {
            for signature in method["signatures"].as_array_mut().into_iter().flatten() {
                signature["uses"] = json!(uses.next().cloned().unwrap_or_default());
            }
        }
    }
    let result = json!({"format": 3, "entrypoints": entries, "types": definitions});
    if !within_limits("", &result) || serde_json::to_vec(&result)?.len() > MAX_BYTES {
        eprintln!(
            "Warning: API documentation was omitted because it exceeds supported limits. Deployment continues."
        );
        return Ok(empty());
    }
    Ok(result)
}

/// Whether a declaration belongs to the app's own sources, as the bundle mode
/// recovers only those through the source map.
fn app_source(node: P<Node>, project: &str) -> bool {
    ast::get_source_file_of_node(node).is_some_and(|file| {
        let path = Path::new(file.file_name());
        !file.is_declaration_file()
            && path.starts_with(project)
            && !path
                .components()
                .any(|part| part.as_os_str() == "node_modules")
    })
}

/// Entry mode: the class or object literal an export declares. Type assertions
/// a bundle would remove are unwrapped, and identifiers resolve to their
/// declarations, as in `export default (handler satisfies Handler)`.
fn original_declaration(mut node: P<Node>, checker: &mut Checker) -> Option<P<Node>> {
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(node) {
            return None;
        }
        if ast::is_class_like(node) || node.kind() == Kind::ObjectLiteralExpression {
            return Some(node);
        }
        node = match node.kind() {
            Kind::SatisfiesExpression | Kind::AsExpression | Kind::ParenthesizedExpression => {
                node.expression()?
            }
            Kind::Identifier => {
                let symbol = checker.get_symbol_at_location_exported(node)?;
                declaration(symbol, checker)?
            }
            _ => return None,
        };
    }
}

fn declaration(symbol: P<Symbol>, checker: &mut Checker) -> Option<P<Node>> {
    let target = if symbol.flags().intersects(SymbolFlags::Alias) {
        checker.get_aliased_symbol(symbol)
    } else {
        symbol
    };
    let node = target
        .value_declaration()
        .or_else(|| target.declarations().first().copied())?;
    match node.kind() {
        Kind::VariableDeclaration => node.initializer(),
        Kind::ExportAssignment => node.expression(),
        _ => Some(node),
    }
}

fn worker_class(node: P<Node>, checker: &mut Checker, seen: &mut HashSet<P<Node>>) -> bool {
    if !seen.insert(node) {
        return false;
    }
    let clauses = if node.kind() == Kind::ClassDeclaration {
        node.as_class_declaration().heritage_clauses()
    } else {
        node.as_class_expression().heritage_clauses()
    };
    for clause in clauses.into_iter().flat_map(|list| list.nodes()) {
        if clause.as_heritage_clause().token() != Kind::ExtendsKeyword {
            continue;
        }
        for &base in clause.as_heritage_clause().types().nodes() {
            if let Some(expression) = base.expression() {
                let imported = if expression.kind() == Kind::PropertyAccessExpression
                    && expression
                        .name()
                        .is_some_and(|name| name.text() == "WorkerEntrypoint")
                {
                    expression.expression()
                } else {
                    Some(expression)
                };
                if let Some(imported) =
                    imported.and_then(|node| checker.get_symbol_at_location_exported(node))
                {
                    for &declaration in imported.declarations() {
                        if declaration.kind() == Kind::ImportSpecifier {
                            let specifier = declaration.as_import_specifier();
                            if specifier.property_name().unwrap_or(specifier.name()).text()
                                != "WorkerEntrypoint"
                            {
                                continue;
                            }
                        } else if declaration.kind() != Kind::NamespaceImport {
                            continue;
                        }
                        let mut parent = declaration.parent();
                        while let Some(node) = parent {
                            if node.kind() == Kind::ImportDeclaration {
                                if node.as_import_declaration().module_specifier().text()
                                    == "cloudflare:workers"
                                {
                                    return true;
                                }
                                break;
                            }
                            parent = node.parent();
                        }
                    }
                }
            }
            let type_ = checker.get_type_at_location(base);
            if let Some(symbol) = type_.symbol() {
                for &declaration in symbol.declarations() {
                    if symbol.name() == "WorkerEntrypoint"
                        && ast::get_source_file_of_node(declaration)
                            .is_some_and(|file| file.is_declaration_file())
                    {
                        return true;
                    }
                    if ast::is_class_like(declaration) && worker_class(declaration, checker, seen) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn rpc_method(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        && !name.starts_with("WIDEFLEET_")
        && !matches!(
            name,
            "constructor"
                | "__proto__"
                | "prototype"
                | "then"
                | "catch"
                | "finally"
                | "fetch"
                | "connect"
                | "scheduled"
                | "queue"
                | "alarm"
                | "webSocketMessage"
                | "webSocketClose"
                | "webSocketError"
                | "toString"
                | "toLocaleString"
                | "valueOf"
                | "hasOwnProperty"
                | "isPrototypeOf"
                | "propertyIsEnumerable"
                | "__defineGetter__"
                | "__defineSetter__"
                | "__lookupGetter__"
                | "__lookupSetter__"
        )
}

// Keep these bounds equal to the service documentation contract the control plane enforces.
pub(crate) const MAX_TEXT: usize = 262144;
pub(crate) const MAX_TYPES: usize = 4096;
const MAX_BYTES: usize = 8 * 1024 * 1024;

fn within_limits(key: &str, value: &Value) -> bool {
    match value {
        Value::String(text) => {
            text.encode_utf16().count() <= if key == "name" { 128 } else { MAX_TEXT }
        }
        Value::Array(values) => {
            values.len()
                <= match key {
                    "entrypoints" | "parameters" | "typeParameters" => 32,
                    "methods" => 1024,
                    "types" | "uses" => MAX_TYPES,
                    _ => 16,
                }
                && values.iter().all(|value| within_limits("", value))
        }
        Value::Object(values) => values.iter().all(|(key, value)| within_limits(key, value)),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(files: &[(&str, &str)]) -> &'static dyn FS {
        Box::leak(Box::new(tsrs_vfs::vfstest::from_map(
            files.iter().map(|&(path, content)| (path, content)),
            true,
        )))
    }

    const MAP: &str = r#"{"version":3,"sources":[],"names":[],"mappings":""}"#;

    #[test]
    fn entry_mode_documents_the_original_entry_module() -> Result<()> {
        let fs = project(&[
            (
                "/app/tsconfig.json",
                r#"{"compilerOptions":{"strict":true}}"#,
            ),
            (
                "/app/src/app.ts",
                r#"import { label } from "./label.ts";
export default {
  /** Greet a person. @param name Who to greet. */
  async greet(name: string): Promise<string> {
    return label(name);
  },
} satisfies object;
"#,
            ),
            (
                "/app/src/label.ts",
                "export const label = (name: string) => `Hello ${name}`;\n",
            ),
        ]);
        let documentation = extract(
            fs,
            "/app",
            "/app/worker.js",
            MAP,
            Some("/app/src/app.ts"),
            &["default".into()],
        )?;
        let method = &documentation["entrypoints"][0]["methods"][0];
        assert_eq!(documentation["entrypoints"][0]["name"], "default");
        assert_eq!(method["name"], "greet");
        assert_eq!(method["summary"], "Greet a person.");
        let signature = &method["signatures"][0];
        assert_eq!(signature["parameters"][0]["name"], "name");
        assert_eq!(signature["parameters"][0]["type"], "string");
        assert_eq!(signature["parameters"][0]["description"], "Who to greet.");
        assert_eq!(signature["returns"]["type"], "Promise<string>");
        Ok(())
    }

    #[test]
    fn entry_mode_skips_services_declared_by_dependencies() -> Result<()> {
        let fs = project(&[
            ("/app/tsconfig.json", "{}"),
            ("/app/src/app.ts", "export { default } from \"service\";\n"),
            (
                "/app/node_modules/service/package.json",
                r#"{"name":"service","types":"index.ts"}"#,
            ),
            (
                "/app/node_modules/service/index.ts",
                "export default { async ping() { return \"pong\"; } };\n",
            ),
        ]);
        let documentation = extract(
            fs,
            "/app",
            "/app/worker.js",
            MAP,
            Some("/app/src/app.ts"),
            &["default".into()],
        )?;
        assert_eq!(documentation, empty());
        Ok(())
    }
}
