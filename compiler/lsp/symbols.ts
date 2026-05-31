import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ClassStatement, FunctionStatement, Program, VarStatement } from "compiler/ast/ast";
import { compileSource } from "compiler/pipeline/compile";
import type {
  DocumentSymbol,
  Location,
  SymbolInformation
} from "vscode-languageserver/node.js";
import { SymbolKind } from "vscode-languageserver/node.js";
import { pathToUri } from "./importFixes";

interface NodeWithTokens {
  firstToken?: { range: { start: { line: number; column: number } } };
  lastToken?: { range: { end: { line: number; column: number } } };
}

function nodeToRange(node: NodeWithTokens) {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return {
    start: {
      line: node.firstToken.range.start.line,
      character: node.firstToken.range.start.column
    },
    end: {
      line: node.lastToken.range.end.line,
      character: node.lastToken.range.end.column
    }
  };
}

function symbolKindForTopLevel(kind: "class" | "function" | "variable"): SymbolKind {
  if (kind === "class") {
    return SymbolKind.Class;
  }
  if (kind === "function") {
    return SymbolKind.Function;
  }
  return SymbolKind.Variable;
}

function scanMyFiles(sourceRoots: string[]): string[] {
  const files: string[] = [];
  const stack = [...sourceRoots];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (!existsSync(current)) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".my") {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function collectDocumentSymbols(program: Program): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];

  for (const statement of program.body) {
    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      const classRange = nodeToRange(statement);
      const nameRange = nodeToRange(classStatement.name);
      if (!classRange || !nameRange) {
        continue;
      }

      const children: DocumentSymbol[] = [];
      for (const member of classStatement.members) {
        if (member.kind === "ClassFieldMember") {
          const memberRange = nodeToRange(member);
          const memberNameRange = nodeToRange(member.name);
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

        const methodRange = nodeToRange(member);
        const methodNameRange = nodeToRange(member.name);
        if (!methodRange || !methodNameRange) {
          continue;
        }
        children.push({
          name: member.name.name,
          kind: SymbolKind.Method,
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
      const functionRange = nodeToRange(statement);
      const functionNameRange = nodeToRange(functionStatement.name);
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
          const declarationRange = nodeToRange(declaration);
          const nameRange = nodeToRange(declaration.name);
          if (!declarationRange || !nameRange) {
            continue;
          }
          symbols.push({
            name: declaration.name.name,
            kind: SymbolKind.Variable,
            range: declarationRange,
            selectionRange: nameRange
          });
        }
      } else {
        const declarationRange = nodeToRange(statement);
        const nameRange = nodeToRange(variableStatement.name);
        if (!declarationRange || !nameRange) {
          continue;
        }
        symbols.push({
          name: variableStatement.name.name,
          kind: SymbolKind.Variable,
          range: declarationRange,
          selectionRange: nameRange
        });
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
    locationNode: NodeWithTokens,
    containerName?: string
  ) => {
    if (!matches(name)) {
      return;
    }
    const range = nodeToRange(locationNode);
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

  for (const statement of program.body) {
    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      push(classStatement.name.name, "class", classStatement.name);
      for (const member of classStatement.members) {
        if (member.kind === "ClassFieldMember") {
          push(member.name.name, "variable", member.name, classStatement.name.name);
        } else {
          push(member.name.name, "function", member.name, classStatement.name.name);
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
          push(declaration.name.name, "variable", declaration.name);
        }
      } else {
        push(variableStatement.name.name, "variable", variableStatement.name);
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
  for (const filePath of scanMyFiles(sourceRoots)) {
    const source = readFileSync(filePath, "utf8");
    const artifacts = compileSource(source);
    if (!artifacts.ast) {
      continue;
    }
    symbols.push(...collectTopLevelSymbolInformation(artifacts.ast, filePath, query));
  }

  return symbols;
}
