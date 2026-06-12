import type {
  AnnotationStatement,
  ClassStatement,
  EnumStatement,
  FunctionStatement,
  ImportStatement,
  InterfaceStatement,
  Program,
  Statement,
  TypeAliasStatement,
  VarStatement
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import {
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeDeclarationFilePath,
  getVexaScriptRuntimeProgram
} from "compiler/runtime/ecmascriptDeclarations";
import { ensureDomProgram, getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { loadProject } from "compiler/project";
import {
  getProjectSessionForFilePath,
  scanProjectMyFiles,
  type ProjectContext
} from "./projectAnalysis";

export type NamedTopLevelDeclaration =
  | AnnotationStatement
  | ClassStatement
  | InterfaceStatement
  | EnumStatement
  | TypeAliasStatement
  | FunctionStatement;

export type ResolvedTopLevelDeclaration<T extends Statement = Statement> = {
  declaration: T;
  filePath: string;
};

export type TopLevelDeclarationPredicate<T extends Statement> = (statement: Statement) => statement is T;

export interface ResolveTopLevelDeclarationOptions<T extends Statement> extends ProjectContext {
  ast: Program;
  name: string;
  currentFilePath: string | null;
  predicate: TopLevelDeclarationPredicate<T>;
  includeRuntime?: boolean;
  sourceRoots?: string[];
}

export function isClassStatement(statement: Statement): statement is ClassStatement {
  return statement.kind === "ClassStatement";
}

export function isInterfaceStatement(statement: Statement): statement is InterfaceStatement {
  return statement.kind === "InterfaceStatement";
}

export function topLevelDeclarationNames(statement: Statement): string[] {
  if (statement.kind === "FunctionStatement") {
    const functionStatement = statement as FunctionStatement;
    if (functionStatement.receiverType && functionStatement.operator) {
      return [functionStatement.name.name];
    }
  }
  const declaration = unwrapExportedDeclaration(statement);
  if (!declaration) {
    return [];
  }

  switch (declaration.kind) {
    case "ClassStatement":
    case "AnnotationStatement":
    case "InterfaceStatement":
    case "EnumStatement":
    case "TypeAliasStatement":
    case "FunctionStatement":
      return [(declaration as NamedTopLevelDeclaration).name.name];
    case "VarStatement": {
      const variableStatement = declaration as VarStatement;
      return [
        ...bindingIdentifiers(variableStatement.name),
        ...(variableStatement.declarations ?? []).flatMap((item) => bindingIdentifiers(item.name))
      ].map((identifier) => identifier.name);
    }
    default:
      return [];
  }
}

export function findTopLevelDeclarationInProgram<T extends Statement>(
  ast: Program,
  name: string,
  predicate: TopLevelDeclarationPredicate<T>
): T | null {
  for (const statement of ast.body) {
    const directMatch = statement.kind === "FunctionStatement"
      ? statement as FunctionStatement
      : null;
    if (directMatch?.receiverType && directMatch.operator && predicate(directMatch) && topLevelDeclarationNames(directMatch).includes(name)) {
      return directMatch;
    }
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration && predicate(declaration) && topLevelDeclarationNames(declaration).includes(name)) {
      return declaration;
    }
  }
  return null;
}

async function runtimeDeclarationsForCurrentFile(currentFilePath: string | null): Promise<Array<{
  ast: Program;
  filePath: string;
}>> {
  const runtimeDeclarations = [{
    ast: getVexaScriptRuntimeProgram(),
    filePath: getVexaScriptRuntimeDeclarationFilePath()
  }, {
    ast: getEcmaScriptRuntimeProgram(),
    filePath: ""
  }];

  if (!currentFilePath) {
    return runtimeDeclarations;
  }

  const project = await loadProject(currentFilePath);
  const requested = new Set((project?.libs ?? []).map((lib) => lib.toLowerCase()));
  if (!requested.has("dom")) {
    return runtimeDeclarations;
  }

  runtimeDeclarations.push({
    ast: await ensureDomProgram(),
    filePath: getDomDeclarationFilePath()
  });
  return runtimeDeclarations;
}

function importSpecifierName(
  importStatement: ImportStatement,
  localName: string
): string | null {
  const matchingSpecifier = importStatement.specifiers.find((specifier) =>
    (specifier.local ?? specifier.imported).name === localName
  );
  return matchingSpecifier?.imported.name ?? null;
}

export async function resolveTopLevelDeclarationAcrossFiles<T extends Statement>(
  options: ResolveTopLevelDeclarationOptions<T>
): Promise<ResolvedTopLevelDeclaration<T> | null> {
  const local = findTopLevelDeclarationInProgram(options.ast, options.name, options.predicate);
  if (local) {
    return {
      declaration: local,
      filePath: options.currentFilePath ?? ""
    };
  }

  if (options.currentFilePath) {
    for (const statement of options.ast.body) {
      if (statement.kind !== "ImportStatement") {
        continue;
      }
      const importStatement = statement as ImportStatement;
      const importedName = importSpecifierName(importStatement, options.name);
      if (!importedName) {
        continue;
      }
      const targetFilePath = await resolveImportTargetFilePath(
        options.currentFilePath,
        importStatement.from.value,
        {
          vfs: options.vfs,
          ...(options.getSessionForFilePath
            ? { getSessionForFilePath: options.getSessionForFilePath }
            : {})
        }
      );
      if (!targetFilePath) {
        continue;
      }
      const targetSession = await getProjectSessionForFilePath(targetFilePath, options);
      if (!targetSession?.ast) {
        continue;
      }
      const targetDeclaration = findTopLevelDeclarationInProgram(
        targetSession.ast,
        importedName,
        options.predicate
      );
      if (targetDeclaration) {
        return {
          declaration: targetDeclaration,
          filePath: targetFilePath
        };
      }
    }
  }

  if (options.includeRuntime) {
    for (const runtime of await runtimeDeclarationsForCurrentFile(options.currentFilePath)) {
      const runtimeDeclaration = findTopLevelDeclarationInProgram(
        runtime.ast,
        options.name,
        options.predicate
      );
      if (runtimeDeclaration) {
        return {
          declaration: runtimeDeclaration,
          filePath: runtime.filePath
        };
      }
    }
  }

  for (const filePath of await scanProjectMyFiles(options.sourceRoots ?? [], options.vfs)) {
    const targetSession = await getProjectSessionForFilePath(filePath, options);
    if (!targetSession?.ast) {
      continue;
    }
    const targetDeclaration = findTopLevelDeclarationInProgram(
      targetSession.ast,
      options.name,
      options.predicate
    );
    if (targetDeclaration) {
      return {
        declaration: targetDeclaration,
        filePath
      };
    }
  }

  return null;
}
