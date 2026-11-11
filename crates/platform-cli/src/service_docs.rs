mod comments;
mod sources;
mod types;

use comments::documentation;
use platform_core::{Error, Result};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};
use tsrs_ast::{self as ast, Kind, Node, Symbol, SymbolFlags};
use tsrs_checker::Checker;
use tsrs_compiler::Context;
use tsrs_core::P;
use types::Types;

pub fn extract(project: &Path, output: &Path, entrypoints: &[String]) -> Result<Value> {
    let empty = || json!({"format": 1, "entrypoints": [], "types": []});
    if entrypoints.is_empty() {
        return Ok(empty());
    }
    let bundle = output.join("worker.js");
    let map = std::fs::read_to_string(output.join("worker.js.map"))?;
    let sources = sources::Sources::new(project, &bundle, &map)?;
    let program = sources.program(project);
    let source = program
        .get_source_file(&sources.bundle)
        .ok_or_else(|| Error::invalid("Cannot read bundled service exports".into()))?;
    let mut checker = program.get_type_checker(&Context::default());
    let module = checker
        .get_symbol_at_location_exported(source.as_node())
        .ok_or_else(|| Error::invalid("Cannot read bundled service exports".into()))?;
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
        let Some(node) = sources.original(program, source, compiled, &lookup) else {
            if ast::is_class_like(compiled) {
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
                let signature_doc = documentation(signature.declaration().unwrap_or(member));
                let mut parameters = Vec::new();
                for &parameter in
                    signature
                        .parameters()
                        .iter()
                        .take(if class { usize::MAX } else { 1 })
                {
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
                signatures.push(json!({"parameters": parameters, "returns": {"type": format!("Promise<{}>", types.text(&mut checker, awaited)), "description": signature_doc.returns}}));
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
    let Some(types) = types.definitions(&mut checker) else {
        eprintln!(
            "Warning: API documentation was omitted because it exceeds supported limits. Deployment continues."
        );
        return Ok(empty());
    };
    let result = json!({"format": 1, "entrypoints": entries, "types": types});
    if !within_limits("", &result) || serde_json::to_vec(&result)?.len() > 262144 {
        eprintln!(
            "Warning: API documentation was omitted because it exceeds supported limits. Deployment continues."
        );
        return Ok(empty());
    }
    Ok(result)
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

fn within_limits(key: &str, value: &Value) -> bool {
    match value {
        Value::String(text) => {
            text.encode_utf16().count() <= if key == "name" { 128 } else { 32768 }
        }
        Value::Array(values) => {
            values.len()
                <= match key {
                    "entrypoints" | "parameters" => 32,
                    "methods" | "types" => 128,
                    _ => 16,
                }
                && values.iter().all(|value| within_limits("", value))
        }
        Value::Object(values) => values.iter().all(|(key, value)| within_limits(key, value)),
        _ => true,
    }
}
