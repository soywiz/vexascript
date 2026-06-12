import { bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import { findNode } from "compiler/ast/traversal";
import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType } from "compiler/analysis/types";
import type {
  CallExpression,
  FunctionParameter,
  FunctionStatement,
  Identifier,
  Program
} from "compiler/ast/ast";
import { tokenize } from "compiler/parser/tokenizer";
import { type CodeAction, type Diagnostic, type Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { getCallDiagnosticKind } from "./diagnosticCodes";
import { findBestMatchAtPosition, type PositionMatchCandidate } from "./nodeSearch";
import { nodeRange, offsetToPosition, type Position } from "./ranges";

interface CallArgumentMatch {
  call: CallExpression;
  argumentIndex: number;
}

interface CallFixContext {
  call: CallExpression;
  argumentIndex: number;
  functionDeclaration: FunctionStatement;
}

function findCallArgumentAtPosition(program: Program, position: Position): CallArgumentMatch | null {
  return findBestMatchAtPosition(program, position, (node) => {
    if (node.kind !== "CallExpression") {
      return null;
    }

    const call = node as CallExpression;
    const candidates: Array<PositionMatchCandidate<CallArgumentMatch>> = [];
    for (let index = 0; index < call.arguments.length; index += 1) {
      const range = nodeRange(call.arguments[index]!);
      if (range) {
        const argumentIndex = index;
        candidates.push({ range, build: () => ({ call, argumentIndex }) });
      }
    }
    return candidates;
  });
}

function findFunctionDeclarationByNameNode(
  program: Program,
  nameNode: Identifier
): FunctionStatement | null {
  return findNode(
    program,
    (node): node is FunctionStatement =>
      node.kind === "FunctionStatement" && (node as FunctionStatement).name === nameNode
  );
}

function isFunctionCallDiagnostic(diagnostic: Diagnostic): boolean {
  return getCallDiagnosticKind(diagnostic) !== null;
}

function resolveCallFixContext(
  ast: Program,
  analysis: Analysis,
  position: Position
): CallFixContext | null {
  const callArgumentMatch = findCallArgumentAtPosition(ast, position);
  if (!callArgumentMatch) {
    return null;
  }

  const calleeToken = callArgumentMatch.call.callee.firstToken;
  if (!calleeToken) {
    return null;
  }
  const symbolMatch = analysis.getSymbolAt(calleeToken.range.start.line, calleeToken.range.start.column);
  if (!symbolMatch || symbolMatch.symbol.kind !== "function" || symbolMatch.symbol.node.kind !== "Identifier") {
    return null;
  }

  const functionDeclaration = findFunctionDeclarationByNameNode(
    ast,
    symbolMatch.symbol.node as Identifier
  );
  if (!functionDeclaration) {
    return null;
  }

  return {
    call: callArgumentMatch.call,
    argumentIndex: callArgumentMatch.argumentIndex,
    functionDeclaration
  };
}

function toTypeAnnotation(type: AnalysisType | undefined): string | null {
  if (!type) {
    return null;
  }
  if (type.kind === "builtin") {
    if (
      type.name === "int" ||
      type.name === "number" ||
      type.name === "numeric" ||
      type.name === "string" ||
      type.name === "boolean" ||
      type.name === "bigint" ||
      type.name === "long"
    ) {
      return type.name;
    }
    return null;
  }
  if (type.kind === "named") {
    return type.name;
  }
  return null;
}

function findFunctionParens(functionStatement: FunctionStatement, text: string): {
  closeOffset: number;
} | null {
  const nameEnd = functionStatement.name.lastToken?.range.end.offset;
  if (nameEnd === undefined) {
    return null;
  }

  const bodyStart = functionStatement.body.firstToken?.range.start.offset ?? text.length;
  const tokens = tokenize(text);
  const startIndex = tokens.findIndex(
    (token) =>
      token.type === "symbol" &&
      token.value === "(" &&
      token.range.start.offset >= nameEnd &&
      token.range.start.offset <= bodyStart
  );
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.type !== "symbol") {
      continue;
    }
    if (token.value === "(") {
      depth += 1;
      continue;
    }
    if (token.value === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          closeOffset: token.range.start.offset
        };
      }
    }
  }

  return null;
}

function rangeAtOffset(text: string, offset: number): Range {
  const position = offsetToPosition(text, offset);
  return {
    start: position,
    end: position
  };
}

function uniqueParameterName(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function extraArgumentQuickFix(params: {
  uri: string;
  text: string;
  analysis: Analysis;
  call: CallExpression;
  functionDeclaration: FunctionStatement;
}): CodeAction | null {
  const { uri, text, analysis, call, functionDeclaration } = params;
  const existingCount = functionDeclaration.parameters.length;
  if (call.arguments.length <= existingCount) {
    return null;
  }

  const expressionTypes = analysis.getExpressionTypes();
  const usedNames = new Set(functionDeclaration.parameters.flatMap((parameter) => bindingIdentifiers(parameter.name).map((identifier) => identifier.name)));
  const missingParts: string[] = [];

  for (let index = existingCount; index < call.arguments.length; index += 1) {
    const argument = call.arguments[index]!;
    const inferredType = toTypeAnnotation(expressionTypes.get(argument));
    const rawName =
      argument.kind === "Identifier"
        ? (argument as Identifier).name
        : `arg${index + 1}`;
    const parameterName = uniqueParameterName(rawName, usedNames);
    if (inferredType) {
      missingParts.push(`${parameterName}: ${inferredType}`);
    } else {
      missingParts.push(parameterName);
    }
  }

  if (missingParts.length === 0) {
    return null;
  }

  const parens = findFunctionParens(functionDeclaration, text);
  if (!parens) {
    return null;
  }

  const insertRange = rangeAtOffset(text, parens.closeOffset);
  const prefix = existingCount > 0 ? ", " : "";
  const insertion = `${prefix}${missingParts.join(", ")}`;

  return {
    title: `Add missing parameters to '${functionDeclaration.name.name}'`,
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [uri]: [
          {
            range: insertRange,
            newText: insertion
          }
        ]
      }
    }
  };
}

function mismatchArgumentQuickFix(params: {
  uri: string;
  text: string;
  analysis: Analysis;
  call: CallExpression;
  argumentIndex: number;
  functionDeclaration: FunctionStatement;
}): CodeAction | null {
  const { uri, text, analysis, call, argumentIndex, functionDeclaration } = params;
  const parameter = functionDeclaration.parameters[argumentIndex];
  const argument = call.arguments[argumentIndex];
  if (!parameter || !argument) {
    return null;
  }

  const annotation = toTypeAnnotation(analysis.getExpressionTypes().get(argument));
  if (!annotation) {
    return null;
  }
  if (parameter.typeAnnotation?.name === annotation) {
    return null;
  }

  if (parameter.optional && !parameter.typeAnnotation) {
    return null;
  }

  let editRange: Range;
  let newText: string;

  if (parameter.typeAnnotation?.firstToken && parameter.typeAnnotation.lastToken) {
    editRange = {
      start: {
        line: parameter.typeAnnotation.firstToken.range.start.line,
        character: parameter.typeAnnotation.firstToken.range.start.column
      },
      end: {
        line: parameter.typeAnnotation.lastToken.range.end.line,
        character: parameter.typeAnnotation.lastToken.range.end.column
      }
    };
    newText = annotation;
  } else {
    const insertionOffset = parameter.name.lastToken?.range.end.offset;
    if (insertionOffset === undefined) {
      return null;
    }
    editRange = rangeAtOffset(text, insertionOffset);
    newText = `: ${annotation}`;
  }

  return {
    title: `Change parameter '${bindingNameText(parameter.name)}' type to '${annotation}'`,
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [uri]: [
          {
            range: editRange,
            newText
          }
        ]
      }
    }
  };
}

function typeInsertionOffsetForParameter(parameter: FunctionParameter, text: string): number | null {
  const nameEnd = parameter.name.lastToken?.range.end.offset;
  if (nameEnd === undefined) {
    return null;
  }
  if (parameter.optional && text[nameEnd] === "?") {
    return nameEnd + 1;
  }
  return nameEnd;
}

function changeSignatureQuickFix(params: {
  uri: string;
  text: string;
  analysis: Analysis;
  call: CallExpression;
  functionDeclaration: FunctionStatement;
}): CodeAction | null {
  const { uri, text, analysis, call, functionDeclaration } = params;
  const edits: Array<{ range: Range; newText: string }> = [];
  const expressionTypes = analysis.getExpressionTypes();
  const existing = functionDeclaration.parameters;
  const provided = call.arguments;

  for (let index = 0; index < existing.length; index += 1) {
    const parameter = existing[index]!;
    const argument = provided[index];
    const hasArgument = argument !== undefined;

    const shouldMakeOptional =
      !hasArgument && !parameter.optional && parameter.defaultValue === undefined;

    if (parameter.typeAnnotation) {
      if (hasArgument) {
        const inferred = toTypeAnnotation(expressionTypes.get(argument!));
        if (inferred && parameter.typeAnnotation.name !== inferred) {
          edits.push({
            range: {
              start: {
                line: parameter.typeAnnotation.firstToken!.range.start.line,
                character: parameter.typeAnnotation.firstToken!.range.start.column
              },
              end: {
                line: parameter.typeAnnotation.lastToken!.range.end.line,
                character: parameter.typeAnnotation.lastToken!.range.end.column
              }
            },
            newText: inferred
          });
        }
      }

      if (shouldMakeOptional) {
        const offset = parameter.name.lastToken?.range.end.offset;
        if (offset !== undefined) {
          edits.push({
            range: rangeAtOffset(text, offset),
            newText: "?"
          });
        }
      }
      continue;
    }

    const inferred = hasArgument ? toTypeAnnotation(expressionTypes.get(argument!)) : null;
    if (!shouldMakeOptional && !inferred) {
      continue;
    }

    const nameEnd = parameter.name.lastToken?.range.end.offset;
    if (nameEnd === undefined) {
      continue;
    }

    if (shouldMakeOptional && inferred) {
      edits.push({
        range: rangeAtOffset(text, nameEnd),
        newText: `?: ${inferred}`
      });
      continue;
    }

    if (shouldMakeOptional) {
      edits.push({
        range: rangeAtOffset(text, nameEnd),
        newText: "?"
      });
      continue;
    }

    if (inferred) {
      const typeOffset = typeInsertionOffsetForParameter(parameter, text);
      if (typeOffset !== null) {
        edits.push({
          range: rangeAtOffset(text, typeOffset),
          newText: `: ${inferred}`
        });
      }
    }
  }

  if (provided.length > existing.length) {
    const parens = findFunctionParens(functionDeclaration, text);
    if (parens) {
      const usedNames = new Set(existing.flatMap((parameter) => bindingIdentifiers(parameter.name).map((identifier) => identifier.name)));
      const additions: string[] = [];
      for (let index = existing.length; index < provided.length; index += 1) {
        const argument = provided[index]!;
        const rawName = argument.kind === "Identifier" ? (argument as Identifier).name : `arg${index + 1}`;
        const parameterName = uniqueParameterName(rawName, usedNames);
        const inferred = toTypeAnnotation(expressionTypes.get(argument));
        additions.push(inferred ? `${parameterName}?: ${inferred}` : `${parameterName}?`);
      }

      if (additions.length > 0) {
        edits.push({
          range: rangeAtOffset(text, parens.closeOffset),
          newText: `${existing.length > 0 ? ", " : ""}${additions.join(", ")}`
        });
      }
    }
  }

  if (edits.length === 0) {
    return null;
  }

  return {
    title: `Change signature of '${functionDeclaration.name.name}' to match this call`,
    kind: CodeActionKind.RefactorRewrite,
    edit: {
      changes: {
        [uri]: edits
      }
    }
  };
}

function dedupeActions(actions: CodeAction[]): CodeAction[] {
  const seen = new Set<string>();
  const deduped: CodeAction[] = [];

  for (const action of actions) {
    const changes = action.edit?.changes ?? {};
    const key = `${action.title}::${JSON.stringify(changes)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(action);
  }

  return deduped;
}

function shouldConsiderDiagnostic(diagnostic: Diagnostic): boolean {
  return isFunctionCallDiagnostic(diagnostic);
}

export function createCallFixCodeActions(params: {
  uri: string;
  text: string;
  ast: Program | null;
  analysis: Analysis | null;
  diagnostics: Diagnostic[];
}): CodeAction[] {
  const { uri, text, ast, analysis, diagnostics } = params;
  if (!ast || !analysis || diagnostics.length === 0) {
    return [];
  }

  const actions: CodeAction[] = [];
  const producedChangeSignatureKeys = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (!shouldConsiderDiagnostic(diagnostic)) {
      continue;
    }
    const diagnosticKind = getCallDiagnosticKind(diagnostic);
    if (!diagnosticKind) {
      continue;
    }

    const position = {
      line: diagnostic.range.start.line,
      character: diagnostic.range.start.character
    };
    const context = resolveCallFixContext(ast, analysis, position);
    if (!context) {
      continue;
    }

    const callStartOffset = context.call.firstToken?.range.start.offset ?? -1;
    const functionName = context.functionDeclaration.name.name;
    const signatureKey = `${callStartOffset}:${functionName}`;
    if (!producedChangeSignatureKeys.has(signatureKey)) {
      const changeSignature = changeSignatureQuickFix({
        uri,
        text,
        analysis,
        call: context.call,
        functionDeclaration: context.functionDeclaration
      });
      if (changeSignature) {
        actions.push(changeSignature);
      }
      producedChangeSignatureKeys.add(signatureKey);
    }

    if (diagnosticKind === "unexpectedArgument") {
      const action = extraArgumentQuickFix({
        uri,
        text,
        analysis,
        call: context.call,
        functionDeclaration: context.functionDeclaration
      });
      if (action) {
        actions.push(action);
      }
      continue;
    }

    if (diagnosticKind === "argumentTypeMismatch") {
      const action = mismatchArgumentQuickFix({
        uri,
        text,
        analysis,
        call: context.call,
        argumentIndex: context.argumentIndex,
        functionDeclaration: context.functionDeclaration
      });
      if (action) {
        actions.push(action);
      }
    }
  }

  return dedupeActions(actions);
}
