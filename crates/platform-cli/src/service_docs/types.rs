use super::comments::documentation;
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};
use tsrs_ast as ast;
use tsrs_checker::{
    Checker, ObjectFlags, SignatureKind, Type, TypeFlags, TypeFormatFlags, VerbosityContext,
};
use tsrs_core::P;

pub struct Types {
    import_prefix: String,
    pending: VecDeque<P<Type>>,
    seen: HashSet<P<Type>>,
}

impl Types {
    pub fn new(project: &std::path::Path) -> Self {
        let path = tsrs_core::tspath::normalize_path(&project.to_string_lossy());
        let quoted = json!(path.trim_end_matches('/').to_owned() + "/").to_string();
        Self {
            import_prefix: format!("import({}", quoted.trim_end_matches('"')),
            pending: VecDeque::new(),
            seen: HashSet::new(),
        }
    }

    pub fn text(&mut self, checker: &mut Checker, value: P<Type>) -> String {
        self.pending.push_back(value);
        self.render(checker, value, None)
    }

    pub fn type_parameter(&mut self, checker: &mut Checker, parameter: P<Type>) -> String {
        let mut declaration = self.text(checker, parameter);
        if parameter.symbol().is_some_and(|symbol| {
            symbol.declarations().iter().any(|node| {
                node.modifiers().is_some_and(|modifiers| {
                    modifiers
                        .nodes()
                        .iter()
                        .any(|modifier| modifier.kind() == ast::Kind::ConstKeyword)
                })
            })
        }) {
            declaration.insert_str(0, "const ");
        }
        if let Some(constraint) = checker.get_constraint_of_type_parameter_exported(parameter) {
            declaration.push_str(" extends ");
            declaration.push_str(&self.text(checker, constraint));
        }
        if let Some(default) = checker.get_default_from_type_parameter_exported(parameter) {
            declaration.push_str(" = ");
            declaration.push_str(&self.text(checker, default));
        }
        declaration
    }

    fn render(
        &self,
        checker: &mut Checker,
        value: P<Type>,
        verbosity: Option<P<VerbosityContext>>,
    ) -> String {
        let flags = TypeFormatFlags::NoTruncation
            | TypeFormatFlags::UseFullyQualifiedType
            | if verbosity.is_some() {
                TypeFormatFlags::InTypeAlias | TypeFormatFlags::MultilineObjectLiterals
            } else {
                TypeFormatFlags::None
            };
        // Keep the compiler's module qualification, but never publish the author's absolute checkout path.
        checker
            .type_to_string_ex_exported(value, None, flags, verbosity)
            .replace(&self.import_prefix, "import(\"./")
    }

    pub fn definitions(&mut self, checker: &mut Checker) -> Option<Vec<Value>> {
        let mut definitions = Vec::new();
        while let Some(value) = self.pending.pop_front() {
            if !self.seen.insert(value) {
                continue;
            }
            // Bound the amount of supplemental metadata, never the app's type system.
            if self.seen.len() > 4096 || definitions.len() > 128 {
                return None;
            }
            if value.flags().intersects(TypeFlags::UnionOrIntersection) {
                self.pending.extend(value.types());
            }
            if value.flags().intersects(TypeFlags::Object)
                && value.object_flags().intersects(ObjectFlags::Reference)
            {
                self.pending
                    .extend(checker.get_type_arguments_exported(value));
            }
            if let Some(alias) = value.alias() {
                self.pending.extend(alias.type_arguments());
            }
            let symbol = value
                .alias()
                .and_then(|alias| alias.symbol())
                .or_else(|| value.symbol());
            let declaration = symbol.and_then(|symbol| symbol.declarations().first().copied());
            let local = declaration
                .and_then(ast::get_source_file_of_node)
                .is_some_and(|file| !tsrs_vfs::bundled::is_bundled(file.file_name()));
            if symbol.is_some() && !local {
                continue;
            }
            let properties = if value
                .flags()
                .intersects(TypeFlags::Object | TypeFlags::UnionOrIntersection)
            {
                checker.get_properties_of_type_exported(value)
            } else {
                &[]
            };
            if value
                .flags()
                .intersects(TypeFlags::Object | TypeFlags::UnionOrIntersection)
            {
                for &index in checker.get_index_infos_of_type_exported(value) {
                    self.pending.push_back(index.value_type());
                }
                for kind in [SignatureKind::Call, SignatureKind::Construct] {
                    for &signature in checker.get_signatures_of_type_exported(value, kind) {
                        self.pending
                            .push_back(checker.get_return_type_of_signature_exported(signature));
                        for &parameter in signature.parameters() {
                            self.pending
                                .push_back(checker.get_type_of_symbol_exported(parameter));
                        }
                    }
                }
            }
            for &property in properties {
                if let Some(node) = property
                    .value_declaration()
                    .or_else(|| property.declarations().first().copied())
                {
                    self.pending
                        .extend(checker.get_type_of_symbol_at_location(property, Some(node)));
                }
            }
            if let Some(node) = declaration.filter(|node| {
                matches!(
                    node.kind(),
                    ast::Kind::InterfaceDeclaration | ast::Kind::TypeAliasDeclaration
                )
            }) {
                let name = self.render(checker, value, None);
                let verbosity = P::new(VerbosityContext::default());
                verbosity.level.set(1);
                verbosity.max_truncation_length.set(32768);
                let mut definition = self.render(checker, value, Some(verbosity));
                if verbosity.truncated.get() {
                    return None;
                }
                for &property in properties {
                    if let Some(node) = property
                        .value_declaration()
                        .or_else(|| property.declarations().first().copied())
                    {
                        let comment = documentation(node).comment;
                        if !comment.summary.is_empty() {
                            definition.push_str(&format!(
                                "\n/** {}: {} */",
                                property.name(),
                                comment.summary.replace("*/", "* /")
                            ));
                        }
                    }
                }
                let mut entry = serde_json::to_value(documentation(node).comment).ok()?;
                entry["name"] = json!(name);
                entry["definition"] = json!(definition);
                definitions.push(entry);
            }
        }
        Some(definitions)
    }
}
