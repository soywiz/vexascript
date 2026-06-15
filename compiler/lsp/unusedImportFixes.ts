import type {
  Identifier,
  ImportSpecifier,
  ImportStatement,
  Program
} from "compiler/ast/ast";
import type { CodeAction, Diagnostic } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { offsetToPosition, nodeRange } from "./ranges";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";

function positionToOffset(text: string, position: { line: number; character: number }): number {
  let line = 0;
  let lineStart = 0;
  while (line < position.line && lineStart <= text.length) {
    const nextBreak = text.indexOf("\n", lineStart);
    if (nextBreak < 0) {
      return text.length;
    }
    line += 1;
    lineStart = nextBreak + 1;
  }
  return Math.min(text.length, lineStart + position.character);
}

function bindingName(specifier: ImportSpecifier): string {
  return specifier.local?.name ?? specifier.imported.name;
}

function importSpecifierText(specifier: ImportSpecifier): string {
  const prefix = specifier.typeOnly ? "type " : "";
  if (specifier.local && specifier.local.name !== specifier.imported.name) {
    return `${prefix}${specifier.imported.name} as ${specifier.local.name}`;
  }
  return `${prefix}${specifier.imported.name}`;
}

function renderImportStatement(statement: ImportStatement): string | null {
  if (statement.sideEffectOnly) {
    return `import "${statement.from.value}"`;
  }

  const head = `import ${statement.typeOnly ? "type " : ""}`;
  const parts: string[] = [];

  if (statement.defaultImport) {
    parts.push(statement.defaultImport.name);
  }

  if (statement.namespaceImport) {
    parts.push(`* as ${statement.namespaceImport.name}`);
  }

  if (statement.specifiers.length > 0) {
    parts.push(`{ ${statement.specifiers.map(importSpecifierText).join(", ")} }`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `${head}${parts.join(", ")} from "${statement.from.value}"`;
}

function importStatementAtRange(ast: Program, diagnostic: Diagnostic): {
  statement: ImportStatement;
  binding: Identifier;
} | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const candidates: Identifier[] = [];
    if (importStatement.defaultImport) {
      candidates.push(importStatement.defaultImport);
    }
    if (importStatement.namespaceImport) {
      candidates.push(importStatement.namespaceImport);
    }
    for (const specifier of importStatement.specifiers) {
      candidates.push(specifier.local ?? specifier.imported);
    }
    for (const binding of candidates) {
      const range = nodeRange(binding);
      if (
        range
        && range.start.line === diagnostic.range.start.line
        && range.start.character === diagnostic.range.start.character
        && range.end.line === diagnostic.range.end.line
        && range.end.character === diagnostic.range.end.character
      ) {
        return { statement: importStatement, binding };
      }
    }
  }
  return null;
}

function statementRemovalRange(text: string, statement: ImportStatement) {
  const range = nodeRange(statement);
  if (!range) {
    return null;
  }
  const startOffset = positionToOffset(text, range.start);
  let endOffset = positionToOffset(text, range.end);
  if (text[endOffset] === "\n") {
    endOffset += 1;
  }
  return {
    start: offsetToPosition(text, startOffset),
    end: offsetToPosition(text, endOffset)
  };
}

export function createUnusedImportCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  diagnostics: Diagnostic[];
}): CodeAction[] {
  const { uri, ast, text, diagnostics } = params;
  if (!ast) {
    return [];
  }

  const actions: CodeAction[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== VEXA_DIAGNOSTIC_CODES.STYLE_UNUSED_IMPORT) {
      continue;
    }

    const resolved = importStatementAtRange(ast, diagnostic);
    if (!resolved) {
      continue;
    }

    const { statement, binding } = resolved;
    const updatedStatement: ImportStatement = {
      kind: "ImportStatement",
      specifiers: statement.specifiers.filter((specifier) => bindingName(specifier) !== binding.name),
      from: statement.from,
      ...(statement.typeOnly ? { typeOnly: true } : {}),
      ...(statement.sideEffectOnly ? { sideEffectOnly: true } : {}),
      ...(statement.defaultImport && statement.defaultImport.name !== binding.name
        ? { defaultImport: statement.defaultImport }
        : {}),
      ...(statement.namespaceImport && statement.namespaceImport.name !== binding.name
        ? { namespaceImport: statement.namespaceImport }
        : {})
    };

    const statementRange = nodeRange(statement);
    if (!statementRange) {
      continue;
    }

    const replacement = renderImportStatement(updatedStatement);
    if (replacement === null) {
      const removalRange = statementRemovalRange(text, statement);
      if (!removalRange) {
        continue;
      }
      actions.push({
        title: `Remove unused import '${binding.name}'`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [uri]: [
              {
                range: removalRange,
                newText: ""
              }
            ]
          }
        }
      });
      continue;
    }

    actions.push({
      title: `Remove unused import '${binding.name}'`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [uri]: [
            {
              range: statementRange,
              newText: replacement
            }
          ]
        }
      }
    });
  }

  return actions;
}
