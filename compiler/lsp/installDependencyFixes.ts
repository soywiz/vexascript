import type { CodeAction, Diagnostic } from "vscode-languageserver/node.js";
import { ImportStatement, type Program } from "compiler/ast/ast";
import { dirname, resolve } from "compiler/utils/path";
import { vfs } from "compiler/vfs";
import { CodeActionKind } from "./codeActionKinds";
import { diagnosticHasCode, VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";
import { uriToFilePath } from "./importFixes";

export interface DependencyInstallTarget {
  packageRoot: string;
  packageName: string;
}

interface CreateInstallDependencyCodeActionsParams {
  uri: string;
  ast: Program;
  diagnostics: readonly Diagnostic[];
  commandName: string;
}

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
] as const;

export function packageJsonDeclaresDependency(value: unknown, packageName: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const packageJson = value as Record<string, unknown>;
  return DEPENDENCY_SECTIONS.some((section) => {
    const dependencies = packageJson[section];
    return Boolean(
      dependencies
      && typeof dependencies === "object"
      && !Array.isArray(dependencies)
      && Object.prototype.hasOwnProperty.call(dependencies, packageName)
    );
  });
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.length === 0
    || specifier.startsWith(".")
    || specifier.startsWith("/")
    || specifier.startsWith("node:")
  ) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 && parts[0] && parts[1]
      ? `${parts[0]}/${parts[1]}`
      : null;
  }
  return parts[0] || null;
}

async function dependencyPackageRoot(
  importerFilePath: string,
  packageName: string
): Promise<string | null> {
  let directory = dirname(importerFilePath);
  while (true) {
    try {
      const source = await vfs().readFile(resolve(directory, "package.json"));
      if (packageJsonDeclaresDependency(JSON.parse(source) as unknown, packageName)) {
        return directory;
      }
    } catch {
      // Keep walking: a parent package.json may own a nested workspace source file.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function diagnosticMatchesImport(diagnostic: Diagnostic, statement: ImportStatement): boolean {
  if (!diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.IMPORT_MODULE_NOT_FOUND)) {
    return false;
  }
  const start = statement.from.firstToken?.range.start;
  const end = statement.from.lastToken?.range.end;
  return Boolean(
    start
    && end
    && diagnostic.range.start.line === start.line
    && diagnostic.range.start.character === start.column
    && diagnostic.range.end.line === end.line
    && diagnostic.range.end.character === end.column
  );
}

export async function createInstallDependencyCodeActions(
  params: CreateInstallDependencyCodeActionsParams
): Promise<CodeAction[]> {
  const importerFilePath = uriToFilePath(params.uri);
  if (!importerFilePath) {
    return [];
  }

  const actions: CodeAction[] = [];
  const seenTargets = new Set<string>();
  for (const statement of params.ast.body) {
    if (!(statement instanceof ImportStatement)) {
      continue;
    }
    const diagnostic = params.diagnostics.find((candidate) => diagnosticMatchesImport(candidate, statement));
    if (!diagnostic) {
      continue;
    }
    const packageName = packageNameFromSpecifier(statement.from.value);
    if (!packageName) {
      continue;
    }
    const packageRoot = await dependencyPackageRoot(importerFilePath, packageName);
    if (!packageRoot) {
      continue;
    }
    const targetKey = `${packageRoot}\0${packageName}`;
    if (seenTargets.has(targetKey)) {
      continue;
    }
    seenTargets.add(targetKey);
    const title = `Run 'npm install' for '${packageName}'`;
    const target: DependencyInstallTarget = { packageRoot, packageName };
    actions.push({
      title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      command: {
        title,
        command: params.commandName,
        arguments: [target]
      }
    });
  }
  return actions;
}
