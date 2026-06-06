import type {
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
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import {
  getProjectSessionForFilePath,
  scanProjectMyFiles,
  type ProjectContext
} from "./projectAnalysis";

export type NamedTopLevelDeclaration =
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
  const declaration = unwrapExportedDeclaration(statement);
  if (!declaration) {
    return [];
  }

  switch (declaration.kind) {
    case "ClassStatement":
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
    const declaration = unwrapExportedDeclaration(statement);
    if (!declaration || !predicate(declaration)) {
      continue;
    }
    if (topLevelDeclarationNames(declaration).includes(name)) {
      return declaration;
    }
  }
  return null;
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

export function resolveTopLevelDeclarationAcrossFiles<T extends Statement>(
  options: ResolveTopLevelDeclarationOptions<T>
): ResolvedTopLevelDeclaration<T> | null {
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
      const targetFilePath = resolveImportTargetFilePath(
        options.currentFilePath,
        importStatement.from.value
      );
      if (!targetFilePath) {
        continue;
      }
      const targetSession = getProjectSessionForFilePath(targetFilePath, options);
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
    const runtimeDeclaration = findTopLevelDeclarationInProgram(
      getEcmaScriptRuntimeProgram(),
      options.name,
      options.predicate
    );
    if (runtimeDeclaration) {
      return {
        declaration: runtimeDeclaration,
        filePath: ""
      };
    }
  }

  for (const filePath of scanProjectMyFiles(options.sourceRoots ?? [])) {
    const targetSession = getProjectSessionForFilePath(filePath, options);
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
