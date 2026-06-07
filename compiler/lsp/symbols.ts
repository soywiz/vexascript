import type { ClassStatement, ExportStatement, FunctionStatement, Program, Statement, VarStatement } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import type {
  DocumentSymbol,
  Location,
  SymbolInformation
} from "vscode-languageserver/node.js";
import { getProjectIndex, getProjectSessionForFilePath } from "./projectAnalysis";
import { pathToUri } from "./importFixes";
import { nodeRange, type TokenBackedNode } from "./ranges";

const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26
} as const;

function symbolKindForTopLevel(kind: "class" | "function" | "variable"): SymbolInformation["kind"] {
  if (kind === "class") {
    return SymbolKind.Class;
  }
  if (kind === "function") {
    return SymbolKind.Function;
  }
  return SymbolKind.Variable;
}

function topLevelSymbolStatement(statement: Statement): Statement {
  if (statement.kind === "ExportStatement") {
    return (statement as ExportStatement).declaration ?? statement;
  }
  return statement;
}

function collectDocumentSymbols(program: Program): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];

  for (const originalStatement of program.body) {
    const statement = topLevelSymbolStatement(originalStatement);
    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      const classRange = nodeRange(statement);
      const nameRange = nodeRange(classStatement.name);
      if (!classRange || !nameRange) {
        continue;
      }

      const children: DocumentSymbol[] = [];
      for (const member of classStatement.members) {
        if (member.kind === "ClassFieldMember") {
          const memberRange = nodeRange(member);
          const memberNameRange = nodeRange(member.name);
          if (!memberRange || !memberNameRange) {
            continue;
          }
          children.push({
            name: member.name.name,
            kind: SymbolKind.Field,
            range: memberRange,
            selectionRange: memberNameRange
          });
          continue;
        }

        const methodRange = nodeRange(member);
        const methodNameRange = nodeRange(member.name);
        if (!methodRange || !methodNameRange) {
          continue;
        }
        children.push({
          name: member.name.name,
          kind: member.accessorKind ? SymbolKind.Property : SymbolKind.Method,
          range: methodRange,
          selectionRange: methodNameRange
        });
      }

      symbols.push({
        name: classStatement.name.name,
        kind: SymbolKind.Class,
        range: classRange,
        selectionRange: nameRange,
        children
      });
      continue;
    }

    if (statement.kind === "FunctionStatement") {
      const functionStatement = statement as FunctionStatement;
      const functionRange = nodeRange(statement);
      const functionNameRange = nodeRange(functionStatement.name);
      if (!functionRange || !functionNameRange) {
        continue;
      }
      symbols.push({
        name: functionStatement.name.name,
        kind: SymbolKind.Function,
        range: functionRange,
        selectionRange: functionNameRange
      });
      continue;
    }

    if (statement.kind === "VarStatement") {
      const variableStatement = statement as VarStatement;
      if (variableStatement.declarations && variableStatement.declarations.length > 0) {
        for (const declaration of variableStatement.declarations) {
          const declarationRange = nodeRange(declaration);
          for (const identifier of bindingIdentifiers(declaration.name)) {
            const nameRange = nodeRange(identifier);
            if (declarationRange && nameRange) symbols.push({ name: identifier.name, kind: SymbolKind.Variable, range: declarationRange, selectionRange: nameRange });
          }
        }
      } else {
        const declarationRange = nodeRange(statement);
        for (const identifier of bindingIdentifiers(variableStatement.name)) {
          const nameRange = nodeRange(identifier);
          if (declarationRange && nameRange) symbols.push({ name: identifier.name, kind: SymbolKind.Variable, range: declarationRange, selectionRange: nameRange });
        }
      }
    }
  }

  return symbols;
}

function collectTopLevelSymbolInformation(
  program: Program,
  filePath: string,
  query: string
): SymbolInformation[] {
  const matches = (name: string): boolean =>
    query.length === 0 || name.toLowerCase().includes(query.toLowerCase());

  const symbols: SymbolInformation[] = [];
  const uri = pathToUri(filePath);
  const push = (
    name: string,
    kind: "class" | "function" | "variable",
    locationNode: TokenBackedNode,
    containerName?: string
  ) => {
    if (!matches(name)) {
      return;
    }
    const range = nodeRange(locationNode);
    if (!range) {
      return;
    }
    const location: Location = { uri, range };
    const symbolInfo: SymbolInformation = {
      name,
      kind: symbolKindForTopLevel(kind),
      location
    };
    if (containerName) {
      symbolInfo.containerName = containerName;
    }
    symbols.push(symbolInfo);
  };

  for (const originalStatement of program.body) {
    const statement = topLevelSymbolStatement(originalStatement);
    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      push(classStatement.name.name, "class", classStatement.name);
      for (const member of classStatement.members) {
        if (member.kind === "ClassFieldMember") {
          push(member.name.name, "variable", member.name, classStatement.name.name);
        } else {
          push(member.name.name, member.accessorKind ? "variable" : "function", member.name, classStatement.name.name);
        }
      }
      continue;
    }

    if (statement.kind === "FunctionStatement") {
      const functionStatement = statement as FunctionStatement;
      push(functionStatement.name.name, "function", functionStatement.name);
      continue;
    }

    if (statement.kind === "VarStatement") {
      const variableStatement = statement as VarStatement;
      if (variableStatement.declarations && variableStatement.declarations.length > 0) {
        for (const declaration of variableStatement.declarations) {
          for (const identifier of bindingIdentifiers(declaration.name)) push(identifier.name, "variable", identifier);
        }
      } else {
        for (const identifier of bindingIdentifiers(variableStatement.name)) push(identifier.name, "variable", identifier);
      }
    }
  }

  return symbols;
}

export function createDocumentSymbols(program: Program): DocumentSymbol[] {
  return collectDocumentSymbols(program);
}

export function createWorkspaceSymbols(params: {
  sourceRoots: string[];
  query: string;
}): SymbolInformation[] {
  const { sourceRoots, query } = params;
  if (sourceRoots.length === 0) {
    return [];
  }

  const symbols: SymbolInformation[] = [];
  const projectIndex = getProjectIndex(sourceRoots);
  for (const filePath of projectIndex.scanMyFiles()) {
    const session = getProjectSessionForFilePath(filePath, { sourceRoots });
    if (!session?.ast) {
      continue;
    }
    symbols.push(...collectTopLevelSymbolInformation(session.ast, filePath, query));
  }

  return symbols;
}
