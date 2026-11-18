/**
 * Compare the statically registered Express route operations with the
 * generated OpenAPI paths. Run with `pnpm check:route-spec` from server/.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const serverRoot = path.resolve(__dirname, "..");
const routesDir = path.join(serverRoot, "src/routes");
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
type Operation = `${string} ${string}`;

function parseSource(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function stringPaths(expression: ts.Expression | undefined, source: ts.SourceFile, line: number): string[] {
  if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) {
    return [expression.text];
  }
  if (expression && ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element) => {
      if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) return element.text;
      throw new Error(`Non-static path in ${source.fileName}:${line}`);
    });
  }
  throw new Error(`Non-static path in ${source.fileName}:${line}`);
}

function normalizePath(value: string): string {
  let normalized = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  normalized = normalized.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  if (normalized.length > 1) normalized = normalized.replace(/\/$/, "");
  return normalized;
}

function mountedPath(prefix: string, route: string): string {
  const joined = `${prefix.replace(/\/$/, "")}/${route.replace(/^\//, "")}`;
  return normalizePath(joined || "/");
}

function routerNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      const factory = declaration.initializer.expression;
      if (
        (ts.isIdentifier(factory) && factory.text === "Router") ||
        (ts.isPropertyAccessExpression(factory) && factory.name.text === "Router")
      ) {
        names.add(declaration.name.text);
      }
    }
  }
  return names;
}

function registeredRoutes(source: ts.SourceFile, mount: string, routers: Set<string>): Set<Operation> {
  const operations = new Set<Operation>();

  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;

    const method = node.expression.name.text.toLowerCase();
    let routePath: ts.Expression | undefined;
    const receiver = node.expression.expression;

    if (ts.isIdentifier(receiver) && routers.has(receiver.text)) {
      if (method === "use" || method === "route" || method === "all") return;
      if (!httpMethods.has(method)) return;
      routePath = node.arguments[0];
    } else if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
      const routeFactory = receiver.expression;
      if (
        routeFactory.name.text !== "route" ||
        !ts.isIdentifier(routeFactory.expression) ||
        !routers.has(routeFactory.expression.text) ||
        !httpMethods.has(method)
      ) return;
      routePath = receiver.arguments[0];
    } else {
      return;
    }

    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const localPath of stringPaths(routePath, source, line)) {
      // `all` is deliberately ignored above: in this repository it is used
      // only as an authorization middleware gate before method-specific routes.
      operations.add(`${method.toUpperCase()} ${mountedPath(mount, localPath)}`);
    }
  });

  return operations;
}

function collectRegisteredOperations(): Set<Operation> {
  const routeIndexPath = path.join(routesDir, "index.ts");
  const routeIndex = parseSource(routeIndexPath);
  const importedRouters = new Map<string, string>();
  for (const statement of routeIndex.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.name || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const modulePath = path.resolve(routesDir, `${statement.moduleSpecifier.text}.ts`);
    importedRouters.set(statement.importClause.name.text, modulePath);
  }

  const operations = new Set<Operation>();
  visit(routeIndex, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.expression.getText(routeIndex) !== "app" ||
      node.expression.name.text !== "use"
    ) return;

    const [prefix, router] = node.arguments;
    if (!prefix || !ts.isStringLiteral(prefix) || !router || !ts.isIdentifier(router)) return;
    const filePath = importedRouters.get(router.text);
    if (!filePath) return;

    const routerSource = parseSource(filePath);
    for (const operation of registeredRoutes(routerSource, prefix.text, routerNames(routerSource))) {
      operations.add(operation);
    }
  });

  // Liveness routes are registered directly on the Express app, outside
  // routes/index.ts, but are part of the same public OpenAPI contract.
  const appSource = parseSource(path.join(serverRoot, "src/index.ts"));
  visit(appSource, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.expression.getText(appSource) !== "app" ||
      !httpMethods.has(node.expression.name.text.toLowerCase())
    ) return;

    const line = appSource.getLineAndCharacterOfPosition(node.getStart(appSource)).line + 1;
    for (const route of stringPaths(node.arguments[0], appSource, line)) {
      // The wildcard OPTIONS handler terminates CORS preflights and is not an
      // API operation that belongs in the OpenAPI contract.
      if (node.expression.name.text.toLowerCase() === "options" && route === "*") continue;
      operations.add(`${node.expression.name.text.toUpperCase()} ${normalizePath(route)}`);
    }
  });

  return operations;
}

function main(): void {
  const specPath = path.join(serverRoot, "openapi.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const documented = new Set<Operation>();
  for (const [route, definition] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(definition)) {
      if (httpMethods.has(method.toLowerCase())) {
        documented.add(`${method.toUpperCase()} ${normalizePath(route)}`);
      }
    }
  }

  const registered = collectRegisteredOperations();
  const missing = [...registered].filter((operation) => !documented.has(operation)).sort();
  const stale = [...documented].filter((operation) => !registered.has(operation)).sort();

  if (missing.length || stale.length) {
    const sections = [
      "OpenAPI route coverage mismatch:",
      ...(missing.length ? ["Missing from server/openapi.json:", ...missing.map((entry) => `  + ${entry}`)] : []),
      ...(stale.length ? ["Not registered in server/src/routes/index.ts or server/src/index.ts:", ...stale.map((entry) => `  - ${entry}`)] : []),
    ];
    throw new Error(sections.join("\n"));
  }

  console.log(`OpenAPI route coverage passed (${registered.size} registered operations).`);
}

main();
