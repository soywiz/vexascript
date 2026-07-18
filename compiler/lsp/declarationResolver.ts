import { NodeKind } from "compiler/ast/ast";
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
import { extname } from "compiler/utils/path";
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
import { getNodeModuleTypings } from "./nodeModulesTypings";

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
  return statement.kind === NodeKind.ClassStatement;
}

export function isInterfaceStatement(statement: Statement): statement is InterfaceStatement {
  return statement.kind === NodeKind.InterfaceStatement;
}

export function topLevelDeclarationNames(statement: Statement): string[] {
  if (statement.kind === NodeKind.VarStatement) {
    const varStatement = statement as VarStatement;
    if (varStatement.receiverType) {
      return bindingIdentifiers(varStatement.name).map((identifier) => identifier.name);
    }
  }
  if (statement.kind === NodeKind.FunctionStatement) {
    const functionStatement = statement as FunctionStatement;
    if (functionStatement.receiverType) {
      return [functionStatement.name.name];
    }
  }
  const declaration = unwrapExportedDeclaration(statement);
  if (!declaration) {
    return [];
  }

  switch (declaration.kind) {
    case NodeKind.ClassStatement:
    case NodeKind.AnnotationStatement:
    case NodeKind.InterfaceStatement:
    case NodeKind.EnumStatement:
    case NodeKind.TypeAliasStatement:
    case NodeKind.FunctionStatement:
      return [(declaration as NamedTopLevelDeclaration).name.name];
    case NodeKind.VarStatement: {
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

function directTopLevelDeclarationNames(statement: Statement): string[] {
  if ((statement as { declared?: boolean }).declared) {
    return [];
  }
  switch (statement.kind) {
    case NodeKind.ClassStatement:
    case NodeKind.AnnotationStatement:
    case NodeKind.InterfaceStatement:
    case NodeKind.EnumStatement:
    case NodeKind.TypeAliasStatement:
    case NodeKind.FunctionStatement:
      return [(statement as NamedTopLevelDeclaration).name.name];
    case NodeKind.VarStatement: {
      const variableStatement = statement as VarStatement;
      return [
        ...bindingIdentifiers(variableStatement.name),
        ...(variableStatement.declarations ?? []).flatMap((item) => bindingIdentifiers(item.name))
      ].map((identifier) => identifier.name);
    }
    default:
      return [];
  }
}

export function importableTopLevelDeclarationNames(statement: Statement, filePath: string): string[] {
  const explicitNames = topLevelDeclarationNames(statement);
  if (explicitNames.length > 0 || extname(filePath).toLowerCase() !== ".vx") {
    return explicitNames;
  }
  return directTopLevelDeclarationNames(statement);
}

export function findTopLevelDeclarationInProgram<T extends Statement>(
  ast: Program,
  name: string,
  predicate: TopLevelDeclarationPredicate<T>
): T | null {
  for (const statement of ast.body) {
    const directExtensionProperty = statement.kind === NodeKind.VarStatement
      ? statement as VarStatement
      : null;
    if (directExtensionProperty?.receiverType && predicate(directExtensionProperty) && topLevelDeclarationNames(directExtensionProperty).includes(name)) {
      return directExtensionProperty;
    }
    const directMatch = statement.kind === NodeKind.FunctionStatement
      ? statement as FunctionStatement
      : null;
    if (directMatch?.receiverType && predicate(directMatch) && topLevelDeclarationNames(directMatch).includes(name)) {
      return directMatch;
    }
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration && predicate(declaration) && topLevelDeclarationNames(declaration).includes(name)) {
      return declaration;
    }
  }
  return null;
}

function findImportableTopLevelDeclarationInProgram<T extends Statement>(
  ast: Program,
  name: string,
  filePath: string,
  predicate: TopLevelDeclarationPredicate<T>
): T | null {
  for (const statement of ast.body) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    if (predicate(declaration) && importableTopLevelDeclarationNames(statement, filePath).includes(name)) {
      return declaration;
    }
  }
  return null;
}

function findImportableTopLevelDeclarationInTypings<T extends Statement>(
  declarations: Array<{ statement: Statement; typingsPath: string }>,
  name: string,
  predicate: TopLevelDeclarationPredicate<T>
): ResolvedTopLevelDeclaration<T> | null {
  for (const entry of declarations) {
    const declaration = unwrapExportedDeclaration(entry.statement) ?? entry.statement;
    if (!predicate(declaration)) {
      continue;
    }
    if (!importableTopLevelDeclarationNames(entry.statement, entry.typingsPath).includes(name)) {
      continue;
    }
    return {
      declaration,
      filePath: entry.typingsPath
    };
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
      if (statement.kind !== NodeKind.ImportStatement) {
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
      if (targetFilePath) {
        const targetSession = await getProjectSessionForFilePath(targetFilePath, options);
        if (!targetSession?.ast) {
          continue;
        }
        const targetDeclaration = findImportableTopLevelDeclarationInProgram(
          targetSession.ast,
          importedName,
          targetFilePath,
          options.predicate
        );
        if (targetDeclaration) {
          return {
            declaration: targetDeclaration,
            filePath: targetFilePath
          };
        }
      }

      if (importStatement.from.value.startsWith(".") || importStatement.from.value.startsWith("/")) {
        continue;
      }

      const typings = await getNodeModuleTypings(options.currentFilePath, importStatement.from.value, {
        vfs: options.vfs
      });
      if (!typings) {
        continue;
      }
      const targetDeclaration = findImportableTopLevelDeclarationInTypings(
        typings.declarationEntries,
        importedName,
        options.predicate
      );
      if (targetDeclaration) {
        return targetDeclaration;
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
