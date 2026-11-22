use super::comments::documentation;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use tsrs_ast as ast;
use tsrs_checker::{
    Checker, ObjectFlags, SignatureKind, Type, TypeFlags, TypeFormatFlags, VerbosityContext,
};
use tsrs_core::{P, tspath};

pub struct Types {
    project: String,
    external_imports: HashMap<String, String>,
    pending: VecDeque<P<Type>>,
    seen: HashSet<P<Type>>,
    /// Types each rendered signature names, in the order signatures were rendered.
    signatures: Vec<Vec<P<Type>>>,
    /// Types the traversal reached from each visited type.
    children: HashMap<P<Type>, Vec<P<Type>>>,
    signature_uses: Vec<Vec<String>>,
}

impl Types {
    pub fn new(project: &str) -> Self {
        Self {
            project: super::sources::compiler_path(project),
            external_imports: HashMap::new(),
            pending: VecDeque::new(),
            seen: HashSet::new(),
            signatures: Vec::new(),
            children: HashMap::new(),
            signature_uses: Vec::new(),
        }
    }

    /// Starts a signature; the types its texts name become its uses.
    pub fn start_signature(&mut self) {
        self.signatures.push(Vec::new());
    }

    /// Adds the types a signature declaration names in its documented parameters, return type
    /// and type parameters to the signature's uses. Its body is implementation, not interface.
    pub fn declaration_references(
        &mut self,
        checker: &mut Checker,
        node: P<ast::Node>,
        parameters: usize,
    ) {
        let annotations = node
            .parameters()
            .iter()
            .take(parameters)
            .chain(node.type_parameters())
            .copied()
            .chain(node.type_node())
            .collect::<Vec<_>>();
        for annotation in annotations {
            for value in referenced_declarations(checker, annotation) {
                self.pending.push_back(value);
                if let Some(roots) = self.signatures.last_mut() {
                    roots.push(value);
                }
            }
        }
    }

    pub fn text(&mut self, checker: &mut Checker, value: P<Type>) -> String {
        self.pending.push_back(value);
        if let Some(roots) = self.signatures.last_mut() {
            roots.push(value);
        }
        self.render(checker, value, None)
    }

    /// A signature's type parameter with its modifiers, constraint and default. The types it
    /// names become uses of the current signature.
    pub fn type_parameter(&mut self, checker: &mut Checker, parameter: P<Type>) -> String {
        self.type_parameter_text(checker, parameter, true)
    }

    fn type_parameter_text(
        &mut self,
        checker: &mut Checker,
        parameter: P<Type>,
        signature: bool,
    ) -> String {
        // A declaration's type parameters are printed while documenting it; the types they name
        // are already its uses through the declaration's references.
        let print = |types: &mut Self, checker: &mut Checker, value: P<Type>| {
            if signature {
                types.text(checker, value)
            } else {
                types.render(checker, value, None)
            }
        };
        let mut declaration = print(self, checker, parameter);
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
            declaration.push_str(&print(self, checker, constraint));
        }
        if let Some(default) = checker.get_default_from_type_parameter_exported(parameter) {
            declaration.push_str(" = ");
            declaration.push_str(&print(self, checker, default));
        }
        declaration
    }

    fn render(
        &mut self,
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
        self.relative_imports(checker.type_to_string_ex_exported(value, None, flags, verbosity))
    }

    fn relative_imports(&mut self, text: String) -> String {
        let mut scanner = tsrs_scanner::Scanner::new();
        scanner.set_text(tsrs_core::alloc_str(&text));
        let mut previous = (ast::Kind::Unknown, ast::Kind::Unknown);
        let mut braces = Vec::new();
        let mut result = String::with_capacity(text.len());
        let mut copied = 0;
        loop {
            let mut token = scanner.scan();
            match token {
                ast::Kind::EndOfFile => break,
                ast::Kind::TemplateHead => braces.push(true),
                ast::Kind::OpenBraceToken => braces.push(false),
                ast::Kind::CloseBraceToken if braces.pop() == Some(true) => {
                    token = scanner.re_scan_template_token(false);
                    if token == ast::Kind::TemplateMiddle {
                        braces.push(true);
                    }
                }
                _ => {}
            }
            // Only rewrite module specifiers, never string or template literal type values.
            if token == ast::Kind::StringLiteral
                && previous == (ast::Kind::ImportKeyword, ast::Kind::OpenParenToken)
            {
                let path = super::sources::compiler_path(scanner.token_value());
                if tspath::is_rooted_disk_path(&path) {
                    let mut relative = tspath::get_relative_path_from_directory(
                        &self.project,
                        &path,
                        &tspath::ComparePathsOptions {
                            use_case_sensitive_file_names: !cfg!(windows),
                            ..Default::default()
                        },
                    );
                    if tspath::is_rooted_disk_path(&relative) {
                        // Different Windows volumes have no relative path. Keep a unique
                        // documentation identity without exposing either volume's directories.
                        let next = self.external_imports.len() + 1;
                        relative = self
                            .external_imports
                            .entry(path)
                            .or_insert_with(|| format!("widefleet:external/{next}"))
                            .clone();
                    } else {
                        relative = tspath::ensure_path_is_non_module_name(&relative);
                    }
                    result.push_str(&text[copied..scanner.token_start() as usize]);
                    result.push_str(&json!(relative).to_string());
                    copied = scanner.token_end() as usize;
                }
            }
            previous = (previous.1, token);
        }
        result.push_str(&text[copied..]);
        result
    }

    pub fn definitions(&mut self, checker: &mut Checker) -> Option<Vec<Value>> {
        let mut definitions = Vec::new();
        let mut documented = HashMap::new();
        while let Some(value) = self.pending.pop_front() {
            if !self.seen.insert(value) {
                continue;
            }
            // Bound the amount of supplemental metadata, never the app's type system.
            if self.seen.len() > 16 * crate::MAX_TYPES || definitions.len() > crate::MAX_TYPES {
                return None;
            }
            let mut children = Vec::new();
            if value.flags().intersects(TypeFlags::UnionOrIntersection) {
                children.extend(value.types());
            }
            if value.flags().intersects(TypeFlags::Object)
                && value.object_flags().intersects(ObjectFlags::Reference)
            {
                children.extend(checker.get_type_arguments_exported(value));
            }
            if let Some(alias) = value.alias() {
                children.extend(alias.type_arguments());
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
                self.follow(value, children);
                continue;
            }
            // A generic interface or type alias is documented once, as its declaration with its
            // type parameters. Each instantiation passes its uses on to the declaration and to
            // its type arguments, which keep their names in signatures, such as `Page<Item>`.
            if let Some(symbol) = symbol.filter(|_| {
                declaration.is_some_and(|node| {
                    matches!(
                        node.kind(),
                        ast::Kind::InterfaceDeclaration | ast::Kind::TypeAliasDeclaration
                    )
                })
            }) && !checker
                .get_local_type_parameters_of_class_or_interface_or_type_alias_exported(symbol)
                .is_empty()
            {
                let declared = checker.get_declared_type_of_symbol_exported(symbol);
                if declared != value {
                    children.push(declared);
                    self.follow(value, children);
                    continue;
                }
            }
            let properties = if value
                .flags()
                .intersects(TypeFlags::Object | TypeFlags::UnionOrIntersection)
            {
                checker.get_properties_of_type_exported(value)
            } else {
                &[]
            };
            // Apparent primitive types and inherited members include standard-library
            // properties. Exclude those before collecting types or member comments.
            let properties = properties
                .iter()
                .filter_map(|&property| {
                    let node = property
                        .value_declaration()
                        .or_else(|| property.declarations().first().copied())?;
                    let file = ast::get_source_file_of_node(node)?;
                    (!tsrs_vfs::bundled::is_bundled(file.file_name())).then_some((property, node))
                })
                .collect::<Vec<_>>();
            if value
                .flags()
                .intersects(TypeFlags::Object | TypeFlags::UnionOrIntersection)
            {
                for &index in checker.get_index_infos_of_type_exported(value) {
                    children.push(index.value_type());
                }
                for kind in [SignatureKind::Call, SignatureKind::Construct] {
                    for &signature in checker.get_signatures_of_type_exported(value, kind) {
                        children.push(checker.get_return_type_of_signature_exported(signature));
                        for &parameter in signature.parameters() {
                            children.push(checker.get_type_of_symbol_exported(parameter));
                        }
                        // Constraints and defaults of the signature's own type parameters are
                        // rendered with the definition, so the types they name are used too.
                        for &parameter in signature.type_parameters() {
                            children.extend(
                                checker.get_constraint_of_type_parameter_exported(parameter),
                            );
                            children.extend(
                                checker.get_default_from_type_parameter_exported(parameter),
                            );
                        }
                    }
                }
            }
            for &(property, node) in &properties {
                children.extend(checker.get_type_of_symbol_at_location(property, Some(node)));
            }
            // Declarations name types the checker's types no longer carry: a generic's type
            // parameters hide its references, and `Alias | null` flattens the alias away.
            if let Some(node) = declaration.filter(|node| {
                matches!(
                    node.kind(),
                    ast::Kind::InterfaceDeclaration | ast::Kind::TypeAliasDeclaration
                )
            }) {
                children.extend(referenced_declarations(checker, node));
            }
            self.follow(value, children);
            if let Some(node) = declaration.filter(|node| {
                matches!(
                    node.kind(),
                    ast::Kind::InterfaceDeclaration | ast::Kind::TypeAliasDeclaration
                )
            }) {
                let name = self.render(checker, value, None);
                let generic = symbol.is_some_and(|symbol| {
                    !checker
                        .get_local_type_parameters_of_class_or_interface_or_type_alias_exported(
                            symbol,
                        )
                        .is_empty()
                });
                let verbosity = P::new(VerbosityContext::default());
                verbosity.level.set(1);
                verbosity.max_truncation_length.set(crate::MAX_TEXT);
                let mut definition = if generic && node.kind() == ast::Kind::TypeAliasDeclaration {
                    // A generic alias prints its own structure; references inside it, including
                    // to itself, keep their names, as a declaration file writes them.
                    self.relative_imports(checker.type_to_string_ex_exported(
                        value,
                        None,
                        TypeFormatFlags::NoTruncation
                            | TypeFormatFlags::UseFullyQualifiedType
                            | TypeFormatFlags::InTypeAlias
                            | TypeFormatFlags::MultilineObjectLiterals,
                        None,
                    ))
                } else {
                    self.render(checker, value, Some(verbosity))
                };
                if verbosity.truncated.get() {
                    return None;
                }
                for &(property, node) in &properties {
                    let comment = documentation(node).comment;
                    if !comment.summary.is_empty() {
                        definition.push_str(&format!(
                            "\n/** {}: {} */",
                            property.name(),
                            comment.summary.replace("*/", "* /")
                        ));
                    }
                }
                let mut entry = serde_json::to_value(documentation(node).comment).ok()?;
                entry["name"] = json!(name);
                entry["kind"] = json!(if node.kind() == ast::Kind::InterfaceDeclaration {
                    "interface"
                } else {
                    "type"
                });
                entry["definition"] = json!(definition);
                // The name shows the parameters, such as `Page<T>`; their constraints and
                // defaults are listed as declared, such as `T extends Item = Item`.
                if let Some(symbol) = symbol.filter(|_| generic) {
                    let parameters = checker
                        .get_local_type_parameters_of_class_or_interface_or_type_alias_exported(
                            symbol,
                        )
                        .to_vec();
                    entry["typeParameters"] = json!(
                        parameters
                            .into_iter()
                            .map(|parameter| self.type_parameter_text(checker, parameter, false))
                            .collect::<Vec<_>>()
                    );
                }
                documented.insert(value, (definitions.len(), name));
                definitions.push(entry);
            }
        }
        // Record the documented types each definition and signature uses directly. Undocumented
        // types in between, such as unions, arrays or library generics, pass their uses through.
        for (&value, (index, name)) in &documented {
            let mut uses = self.uses(&documented, self.children.get(&value).into_iter().flatten());
            uses.retain(|used| used != name);
            definitions[*index]["uses"] = json!(uses);
        }
        let signature_uses = self
            .signatures
            .iter()
            .map(|roots| self.uses(&documented, roots.iter()))
            .collect();
        self.signature_uses = signature_uses;
        Some(definitions)
    }

    /// The uses of each signature, in the order `start_signature` began them.
    pub fn signature_uses(&self) -> &[Vec<String>] {
        &self.signature_uses
    }

    fn follow(&mut self, value: P<Type>, children: Vec<P<Type>>) {
        self.pending.extend(children.iter().copied());
        self.children.insert(value, children);
    }

    fn uses<'a>(
        &self,
        documented: &HashMap<P<Type>, (usize, String)>,
        roots: impl Iterator<Item = &'a P<Type>>,
    ) -> Vec<String> {
        let mut uses = Vec::new();
        let mut visited = HashSet::new();
        let mut pending: Vec<P<Type>> = roots.copied().collect();
        while let Some(value) = pending.pop() {
            if !visited.insert(value) {
                continue;
            }
            if let Some((_, name)) = documented.get(&value) {
                if !uses.contains(name) {
                    uses.push(name.clone());
                }
                continue;
            }
            pending.extend(self.children.get(&value).into_iter().flatten().copied());
        }
        uses.sort();
        uses
    }
}

/// The declared types of the interfaces and type aliases a declaration names.
pub(crate) fn referenced_declarations(checker: &mut Checker, node: P<ast::Node>) -> Vec<P<Type>> {
    let mut names = Vec::new();
    type_reference_names(node, &mut names);
    names
        .into_iter()
        .filter_map(|name| {
            let mut symbol = checker.get_symbol_at_location_exported(name)?;
            if symbol.flags().intersects(ast::SymbolFlags::Alias) {
                symbol = checker.get_aliased_symbol(symbol);
            }
            symbol
                .flags()
                .intersects(ast::SymbolFlags::Interface | ast::SymbolFlags::TypeAlias)
                .then(|| checker.get_declared_type_of_symbol_exported(symbol))
        })
        .collect()
}

/// The names of the type references inside a declaration.
fn type_reference_names(node: P<ast::Node>, names: &mut Vec<P<ast::Node>>) {
    node.for_each_child(&mut |child| {
        if child.kind() == ast::Kind::TypeReference {
            names.push(child.as_type_reference_node().type_name());
        }
        type_reference_names(child, names);
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_paths_are_relative_inside_and_outside_the_project() {
        for (project, module, expected) in [
            ("/workspace/app", "/workspace/app/model", "./model"),
            (
                "/workspace/app",
                "/workspace/shared/model",
                "../shared/model",
            ),
            (
                "C:/workspace/app",
                "C:/workspace/shared/model",
                "../shared/model",
            ),
            (
                r"\\?\C:\workspace\app",
                r"C:\workspace\shared\model",
                "../shared/model",
            ),
            ("/workspace/app", "/workspace/quo\"ted/ö", "../quo\"ted/ö"),
        ] {
            let mut types = Types::new(project);
            assert_eq!(
                types.relative_imports(format!("import({}).Item", json!(module))),
                format!("import({}).Item", json!(expected))
            );
        }
    }

    #[test]
    fn imports_on_other_volumes_keep_distinct_repeatable_identities() {
        let mut types = Types::new("C:/workspace/app");
        let first = types.relative_imports(r#"import("D:/private/one/model").Item"#.into());
        let second = types.relative_imports(r#"import("D:/private/two/model").Item"#.into());
        assert_eq!(first, r#"import("widefleet:external/1").Item"#);
        assert_eq!(second, r#"import("widefleet:external/2").Item"#);
        assert_eq!(
            types.relative_imports(r#"import("D:/private/one/model").Item"#.into()),
            first
        );
    }

    #[test]
    fn import_rewriting_preserves_literal_types_and_package_names() {
        let mut types = Types::new("/workspace/app");
        let literal = r#"["import(\"/workspace/app/model\").Item", `import("/workspace/app/model").Item`, import("package").Item]"#;
        assert_eq!(types.relative_imports(literal.into()), literal);
        assert_eq!(
            types.relative_imports(
                r#"`before ${import("/workspace/shared/model").Text} import("/workspace/app/model").Item`"#.into()
            ),
            r#"`before ${import("../shared/model").Text} import("/workspace/app/model").Item`"#
        );
    }
}
