import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { appRpcMethod, serviceDocumentation } from "@platform/contracts";
import { documentation } from "./service-docs-comments.ts";

const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;

function inside(root: string, file: string) {
  const path = relative(root, file);

  return !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
}

function declaration(symbol: ts.Symbol, checker: ts.TypeChecker) {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  let node: ts.Node | undefined = target.valueDeclaration ?? target.declarations?.[0];

  if (node && (ts.isVariableDeclaration(node) || ts.isExportAssignment(node)))
    node = ts.isVariableDeclaration(node) ? node.initializer : node.expression;

  return node;
}

function container(
  node: ts.Node,
): ts.ClassLikeDeclaration | ts.ObjectLiteralExpression | undefined {
  if (ts.isClassLike(node) || ts.isObjectLiteralExpression(node)) return node;

  return node.parent && !ts.isSourceFile(node.parent) ? container(node.parent) : undefined;
}

function atPosition(node: ts.Node, position: number): ts.Node {
  return (
    ts.forEachChild(node, (child) =>
      child.getStart() <= position && child.end > position
        ? atPosition(child, position)
        : undefined,
    ) ?? node
  );
}

function workerClass(
  node: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);

  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;

    for (const base of clause.types) {
      if (
        ts.isPropertyAccessExpression(base.expression) &&
        base.expression.name.text === "WorkerEntrypoint"
      ) {
        const namespace = checker
          .getSymbolAtLocation(base.expression.expression)
          ?.declarations?.find(ts.isNamespaceImport);

        const statement = namespace?.parent.parent;

        if (
          statement &&
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === "cloudflare:workers"
        )
          return true;
      }

      const imported = checker
        .getSymbolAtLocation(base.expression)
        ?.declarations?.find(ts.isImportSpecifier);

      if (imported && (imported.propertyName ?? imported.name).text === "WorkerEntrypoint") {
        const statement = imported.parent.parent.parent;

        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === "cloudflare:workers"
        )
          return true;
      }

      const type = checker.getTypeAtLocation(base);
      const symbol = type.getSymbol();

      if (
        symbol?.name === "WorkerEntrypoint" &&
        symbol.declarations?.some((item) => item.getSourceFile().isDeclarationFile)
      )
        return true;
      const parent = symbol?.declarations?.find(ts.isClassDeclaration);

      if (parent && workerClass(parent, checker, seen)) return true;
    }
  }

  return false;
}

// The source map is produced by our final bundling pass. esbuild composes input
// maps, including framework output, so no framework-specific source entry is needed.
export function extractServiceDocumentation(
  project: string,
  bundle: string,
  entrypoints: string[],
) {
  project = resolve(project);
  bundle = resolve(bundle);
  const warnings: string[] = [];

  if (!entrypoints.length)
    return {
      documentation: serviceDocumentation.parse({ format: 1, entrypoints: [], types: [] }),
      warnings,
    };
  const originals = new Map<string, string>();
  const map = new TraceMap(readFileSync(`${bundle}.map`, "utf8"));

  for (const [index, source] of map.resolvedSources.entries()) {
    const file = source.startsWith("file:")
      ? fileURLToPath(source)
      : resolve(dirname(bundle), source);

    const content = map.sourcesContent?.[index];

    if (
      inside(project, file) &&
      !file.includes("node_modules") &&
      content !== null &&
      content !== undefined
    )
      originals.set(file, content);
  }

  const configPath = ts.findConfigFile(project, (file) => ts.sys.fileExists(file));

  const config = configPath
    ? ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            warnings.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
          },
        },
      )
    : undefined;

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    ...config?.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
  };

  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (file) => originals.get(resolve(file)) ?? read(file);
  const present = host.fileExists.bind(host);
  host.fileExists = (file) => originals.has(resolve(file)) || present(file);

  const program = ts.createProgram(
    [bundle, ...originals.keys(), ...(config?.fileNames ?? [])],
    options,
    host,
  );

  const checker = program.getTypeChecker();
  const source = program.getSourceFile(bundle);
  const module = source && checker.getSymbolAtLocation(source);

  if (!source || !module) throw new Error("Cannot read bundled service exports");
  const bundledSource = source;

  function original(node: ts.Node) {
    const anchor = ts.isClassLike(node) ? (node.name ?? node) : node;
    const location = bundledSource.getLineAndCharacterOfPosition(anchor.getStart());

    const mapped = originalPositionFor(map, {
      line: location.line + 1,
      column: location.character,
    });

    if (!mapped.source || mapped.line === null || mapped.column === null) return undefined;

    const file = mapped.source.startsWith("file:")
      ? fileURLToPath(mapped.source)
      : resolve(dirname(bundle), mapped.source);

    const originalSource = program.getSourceFile(file);

    if (!originalSource || !originals.has(file)) return undefined;
    const position = originalSource.getPositionOfLineAndCharacter(mapped.line - 1, mapped.column);

    return container(atPosition(originalSource, position));
  }

  const types = new Map<
    string,
    {
      name: string;
      definition: string;
      summary: string;
      remarks: string;
      examples: string[];
      deprecated: string | undefined;
    }
  >();

  const visiting = new Set<ts.Type>();

  function typeText(type: ts.Type, depth = 0): string {
    if (depth > 20) {
      warnings.push(
        "An API type exceeds 20 levels of nesting; its nested value is shown as unknown.",
      );

      return "unknown";
    }

    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);

      return constraint ? typeText(constraint, depth + 1) : "unknown";
    }

    if (type.flags & ts.TypeFlags.Any) {
      warnings.push(
        "Some API types could not be resolved and are shown as unknown. Install the app's dependencies and check its TypeScript types.",
      );

      return "unknown";
    }

    if (type.flags & ts.TypeFlags.Unknown) return "unknown";

    if (type.isUnionOrIntersection())
      return type.types
        .map((item) => {
          const value = typeText(item, depth + 1);

          return type.isIntersection() && item.isUnion() ? `(${value})` : value;
        })
        .join(type.isUnion() ? " | " : " & ");

    if (checker.isArrayType(type)) {
      const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);

      return `Array<${element ? typeText(element, depth + 1) : "unknown"}>`;
    }

    if (checker.isTupleType(type)) {
      // SAFETY: The compiler's isTupleType predicate identifies TupleTypeReference,
      // but its public declaration returns boolean rather than a type guard.
      const tuple = type as ts.TupleTypeReference;
      const arguments_ = checker.getTypeArguments(tuple);

      return `[${arguments_
        .map((item, index) => {
          const kind = tuple.target.elementFlags[index] ?? ts.ElementFlags.Required;
          const value = typeText(item, depth + 1);

          if (kind & ts.ElementFlags.Rest) return `...Array<${value}>`;

          if (kind & ts.ElementFlags.Variadic) return `...${value}`;

          return kind & ts.ElementFlags.Optional ? `(${value})?` : value;
        })
        .join(", ")}]`;
    }

    const symbol = type.aliasSymbol ?? type.getSymbol();

    const declared = symbol?.declarations?.find(
      (item) =>
        inside(project, item.getSourceFile().fileName) &&
        !item.getSourceFile().fileName.includes("node_modules"),
    );

    const properties = type.getProperties();
    const indexes = checker.getIndexInfosOfType(type);

    // Traverse standard containers too, so Map<string, Query> includes Query's
    // definition. Type arguments also distinguish generic interface instances.
    // SAFETY: Object types carrying a target are compiler type references; the
    // public Type interface omits their type arguments until narrowed here.
    const arguments_ =
      type.flags & ts.TypeFlags.Object && "target" in type
        ? checker.getTypeArguments(type as ts.TypeReference)
        : [];

    if (!declared && symbol && arguments_.length)
      return `${symbol.name}<${arguments_.map((item) => typeText(item, depth + 1)).join(", ")}>`;

    const generic = Boolean(type.aliasTypeArguments?.length || arguments_.length);

    if (
      type.flags & ts.TypeFlags.Object &&
      (properties.length || indexes.length) &&
      declared &&
      !ts.isClassDeclaration(declared)
    ) {
      const name =
        symbol &&
        !generic &&
        (ts.isInterfaceDeclaration(declared) || ts.isTypeAliasDeclaration(declared))
          ? symbol.name
          : undefined;

      if (visiting.has(type)) return name ?? "unknown";
      visiting.add(type);

      const fields = properties.map((property) => {
        const node = property.valueDeclaration ?? property.declarations?.[0] ?? declared;
        const doc = documentation(node, warnings).comment.summary;
        const prefix = doc ? `/** ${doc.replaceAll("*/", "* /")} */\n` : "";

        return `${prefix}${JSON.stringify(property.name)}${property.flags & ts.SymbolFlags.Optional ? "?" : ""}: ${typeText(checker.getTypeOfSymbolAtLocation(property, node), depth + 1)};`;
      });

      for (const index of indexes)
        fields.push(
          `[key: ${typeText(index.keyType, depth + 1)}]: ${typeText(index.type, depth + 1)};`,
        );

      const body = `{ ${fields.join(" ")} }`;
      visiting.delete(type);

      // Generic instantiations are expanded in place; they must not overwrite a
      // different instantiation with the same alias name.
      if (name) {
        const definition = `type ${name} = ${body};`;
        const previous = types.get(name);

        if (previous && previous.definition !== definition) {
          warnings.push(
            `Conflicting API type name ${name} is shown as unknown. Give public types distinct names.`,
          );

          return "unknown";
        }

        types.set(name, { name, definition, ...documentation(declared, warnings).comment });

        return name;
      }

      return body;
    }

    const printed = checker.typeToString(type, undefined, flags);

    if (printed.includes('import("') || printed.includes("import('")) {
      warnings.push(
        "An API type references an external implementation and is shown as unknown. Expose a portable data type in the service signature.",
      );

      return "unknown";
    }

    return printed;
  }

  const entries: ReturnType<typeof serviceDocumentation.parse>["entrypoints"] = [];

  for (const symbol of checker.getExportsOfModule(module)) {
    if (!entrypoints.includes(symbol.name)) continue;
    const compiled = declaration(symbol, checker);

    if (!compiled) continue;
    const node = original(compiled);

    if (!node) {
      if (ts.isClassLike(compiled))
        warnings.push(
          `Cannot recover source for service ${symbol.name}; preserve source maps in the app build.`,
        );
      continue;
    }

    const isClass = ts.isClassLike(node);

    if (isClass && !workerClass(node, checker)) continue;

    if (!isClass && symbol.name !== "default") continue;
    const type = checker.getTypeAtLocation(node);

    const methods: ReturnType<typeof serviceDocumentation.parse>["entrypoints"][number]["methods"] =
      [];

    let http = false;

    for (const property of type.getProperties()) {
      const member = property.valueDeclaration ?? property.declarations?.[0];

      if (!member || member.getSourceFile().isDeclarationFile) continue;

      if (property.name === "fetch") {
        http = true;
        continue;
      }

      if (!appRpcMethod.safeParse(property.name).success) continue;

      if (isClass && !ts.isMethodDeclaration(member)) continue;

      const handler = ts.isMethodDeclaration(member)
        ? member
        : ts.isPropertyAssignment(member) &&
            (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
          ? member.initializer
          : undefined;

      if (!isClass && handler) {
        const defaultParameter = handler.parameters.findIndex(
          (parameter) => parameter.initializer || parameter.dotDotDotToken,
        );

        if ((defaultParameter < 0 ? handler.parameters.length : defaultParameter) > 3) continue;
      }

      if (ts.isMethodDeclaration(member) && ts.isPrivateIdentifier(member.name)) continue;
      const callable = checker.getTypeOfSymbolAtLocation(property, member).getCallSignatures();

      if (!callable.length) continue;
      const doc = documentation(member, warnings);

      const signatures = callable.map((signature) => {
        const params = signature.getParameters();
        const signatureDoc = documentation(signature.declaration ?? member, warnings);

        const parameters = (isClass ? params : params.slice(0, 1)).map((parameter) => {
          const param = parameter.valueDeclaration;
          const parameterType = checker.getTypeOfSymbolAtLocation(parameter, param ?? member);

          return {
            name: parameter.name,
            type: typeText(parameterType),
            description: signatureDoc.parameters.get(parameter.name) ?? "",
            optional: Boolean(
              param && ts.isParameter(param) && (param.questionToken || param.initializer),
            ),
            rest: Boolean(param && ts.isParameter(param) && param.dotDotDotToken),
          };
        });

        return {
          parameters,
          returns: {
            type: `Promise<${typeText(checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType())}>`,
            description: signatureDoc.returns,
          },
        };
      });

      methods.push({ name: property.name, ...doc.comment, throws: doc.throws, signatures });
    }

    if (methods.length || http)
      entries.push({ name: symbol.name, ...documentation(node, warnings).comment, http, methods });
  }

  return {
    documentation: serviceDocumentation.parse({
      format: 1,
      entrypoints: entries,
      types: [...types.values()],
    }),
    warnings: [...new Set(warnings)],
  };
}
