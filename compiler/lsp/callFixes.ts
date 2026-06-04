import { bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType } from "compiler/analysis/types";
import type {
  ArrayLiteral,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionParameter,
  FunctionStatement,
  Identifier,
  IfStatement,
  LabeledStatement,
  MemberExpression,
  NewExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import { tokenize } from "compiler/parser/tokenizer";
import { CodeActionKind, type CodeAction, type Diagnostic, type Range } from "vscode-languageserver/node.js";
import { getCallDiagnosticKind } from "./diagnosticCodes";

interface Position {
  line: number;
  character: number;
}

interface NodeRange {
  start: Position;
  end: Position;
}

interface CallArgumentMatch {
  call: CallExpression;
  argumentIndex: number;
}

interface CallFixContext {
  call: CallExpression;
  argumentIndex: number;
  functionDeclaration: FunctionStatement;
}

function nodeRange(node: {
  firstToken?: { range: { start: { line: number; column: number } } };
  lastToken?: { range: { end: { line: number; column: number } } };
}): NodeRange | null {
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

function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

function containsPosition(range: NodeRange, position: Position): boolean {
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0;
}

function findCallArgumentAtPosition(program: Program, position: Position): CallArgumentMatch | null {
  let best: { match: CallArgumentMatch; size: number } | undefined;

  const registerMatch = (call: CallExpression): void => {
    for (let index = 0; index < call.arguments.length; index += 1) {
      const argument = call.arguments[index]!;
      const range = nodeRange(argument);
      if (!range || !containsPosition(range, position)) {
        continue;
      }
      const size = (range.end.line - range.start.line) * 100_000 + (range.end.character - range.start.character);
      if (!best || size <= best.size) {
        best = { match: { call, argumentIndex: index }, size };
      }
    }
  };

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "CallExpression": {
        const call = expression as CallExpression;
        visitExpression(call.callee);
        for (const argument of call.arguments) {
          visitExpression(argument);
        }
        registerMatch(call);
        return;
      }
      case "NewExpression": {
        const node = expression as NewExpression;
        visitExpression(node.callee);
        for (const argument of node.arguments ?? []) {
          visitExpression(argument);
        }
        return;
      }
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression":
        visitExpression((expression as AsExpression).expression);
        return;
      case "BinaryExpression":
        visitExpression((expression as BinaryExpression).left);
        visitExpression((expression as BinaryExpression).right);
        return;
      case "RangeExpression":
        visitExpression((expression as RangeExpression).start);
        visitExpression((expression as RangeExpression).end);
        return;
      case "AssignmentExpression":
        visitExpression((expression as AssignmentExpression).left);
        visitExpression((expression as AssignmentExpression).right);
        return;
      case "ConditionalExpression":
        visitExpression((expression as ConditionalExpression).test);
        visitExpression((expression as ConditionalExpression).consequent);
        visitExpression((expression as ConditionalExpression).alternate);
        return;
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        visitExpression((expression as MemberExpression).property);
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        visitExpression((expression as UnaryExpression | UpdateExpression).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          if (property.kind === "ObjectSpreadProperty") {
            visitExpression(property.argument);
          } else {
            visitExpression(property.value);
          }
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement":
        if ((statement as VarStatement).declarations && (statement as VarStatement).declarations!.length > 0) {
          for (const declaration of (statement as VarStatement).declarations!) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if ((statement as VarStatement).initializer) {
          visitExpression((statement as VarStatement).initializer!);
        }
        return;
      case "ExprStatement":
        visitExpression((statement as ExprStatement).expression);
        return;
      case "ReturnStatement":
        if ((statement as ReturnStatement).expression) {
          visitExpression((statement as ReturnStatement).expression!);
        }
        return;
      case "ThrowStatement":
        visitExpression((statement as ThrowStatement).expression);
        return;
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          visitStatement(child);
        }
        return;
      case "FunctionStatement":
        for (const child of (statement as FunctionStatement).body.body) {
          visitStatement(child);
        }
        return;
      case "ClassStatement":
        for (const member of (statement as ClassStatement).members) {
          if (member.kind === "ClassFieldMember") {
            if (member.initializer) {
              visitExpression(member.initializer);
            }
            continue;
          }
          for (const child of member.body.body) {
            visitStatement(child);
          }
        }
        return;
      case "IfStatement":
        visitExpression((statement as IfStatement).condition);
        visitStatement((statement as IfStatement).thenBranch);
        if ((statement as IfStatement).elseBranch) {
          visitStatement((statement as IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
        visitExpression((statement as WhileStatement).condition);
        visitStatement((statement as WhileStatement).body);
        return;
      case "WithStatement":
        visitExpression((statement as WithStatement).object);
        visitStatement((statement as WithStatement).body);
        return;
      case "LabeledStatement":
        visitStatement((statement as LabeledStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind === "VarStatement") {
          visitStatement((statement as ForStatement).initializer as Statement);
        } else if ((statement as ForStatement).initializer) {
          visitExpression((statement as ForStatement).initializer as Expr);
        }
        if ((statement as ForStatement).iterator && (statement as ForStatement).iterator!.kind === "VarStatement") {
          visitStatement((statement as ForStatement).iterator as Statement);
        } else if ((statement as ForStatement).iterator) {
          visitExpression((statement as ForStatement).iterator as Expr);
        }
        if ((statement as ForStatement).iterable) {
          visitExpression((statement as ForStatement).iterable!);
        }
        if ((statement as ForStatement).condition) {
          visitExpression((statement as ForStatement).condition!);
        }
        if ((statement as ForStatement).update) {
          visitExpression((statement as ForStatement).update!);
        }
        visitStatement((statement as ForStatement).body);
        return;
      case "SwitchStatement":
        visitExpression((statement as SwitchStatement).discriminant);
        for (const switchCase of (statement as SwitchStatement).cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const child of switchCase.consequent) {
            visitStatement(child);
          }
        }
        return;
      case "TryStatement":
        for (const child of (statement as TryStatement).tryBlock.body) {
          visitStatement(child);
        }
        if ((statement as TryStatement).catchClause) {
          for (const child of (statement as TryStatement).catchClause!.body.body) {
            visitStatement(child);
          }
        }
        if ((statement as TryStatement).finallyBlock) {
          for (const child of (statement as TryStatement).finallyBlock!.body) {
            visitStatement(child);
          }
        }
        return;
      default:
        return;
    }
  };

  for (const statement of program.body) {
    visitStatement(statement);
  }

  return best ? best.match : null;
}

function findFunctionDeclarationByNameNode(
  program: Program,
  nameNode: Identifier
): FunctionStatement | null {
  const visitStatement = (statement: Statement): FunctionStatement | null => {
    if (statement.kind === "FunctionStatement") {
      const fn = statement as FunctionStatement;
      if (fn.name === nameNode) {
        return fn;
      }
      for (const child of fn.body.body) {
        const nested = visitStatement(child);
        if (nested) {
          return nested;
        }
      }
      return null;
    }

    if (statement.kind === "BlockStatement") {
      for (const child of (statement as BlockStatement).body) {
        const nested = visitStatement(child);
        if (nested) {
          return nested;
        }
      }
      return null;
    }

    if (statement.kind === "IfStatement") {
      const ifStatement = statement as IfStatement;
      const thenMatch = visitStatement(ifStatement.thenBranch);
      if (thenMatch) {
        return thenMatch;
      }
      if (ifStatement.elseBranch) {
        return visitStatement(ifStatement.elseBranch);
      }
      return null;
    }

    if (statement.kind === "WhileStatement") {
      return visitStatement((statement as WhileStatement).body);
    }

    if (statement.kind === "WithStatement") {
      return visitStatement((statement as WithStatement).body);
    }

    if (statement.kind === "LabeledStatement") {
      return visitStatement((statement as LabeledStatement).body);
    }

    if (statement.kind === "DoWhileStatement") {
      return visitStatement((statement as DoWhileStatement).body);
    }

    if (statement.kind === "ForStatement") {
      return visitStatement((statement as ForStatement).body);
    }

    if (statement.kind === "SwitchStatement") {
      for (const switchCase of (statement as SwitchStatement).cases) {
        for (const child of switchCase.consequent) {
          const nested = visitStatement(child);
          if (nested) {
            return nested;
          }
        }
      }
      return null;
    }

    if (statement.kind === "TryStatement") {
      const tryStatement = statement as TryStatement;
      for (const child of tryStatement.tryBlock.body) {
        const nested = visitStatement(child);
        if (nested) {
          return nested;
        }
      }
      if (tryStatement.catchClause) {
        for (const child of tryStatement.catchClause.body.body) {
          const nested = visitStatement(child);
          if (nested) {
            return nested;
          }
        }
      }
      if (tryStatement.finallyBlock) {
        for (const child of tryStatement.finallyBlock.body) {
          const nested = visitStatement(child);
          if (nested) {
            return nested;
          }
        }
      }
      return null;
    }

    if (statement.kind === "ClassStatement") {
      for (const member of (statement as ClassStatement).members) {
        if (member.kind !== "ClassMethodMember") {
          continue;
        }
        for (const child of member.body.body) {
          const nested = visitStatement(child);
          if (nested) {
            return nested;
          }
        }
      }
      return null;
    }

    return null;
  };

  for (const statement of program.body) {
    const match = visitStatement(statement);
    if (match) {
      return match;
    }
  }
  return null;
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

function offsetToPosition(text: string, offset: number): Position {
  let line = 0;
  let character = 0;
  const clampedOffset = Math.max(0, Math.min(offset, text.length));
  for (let index = 0; index < clampedOffset; index += 1) {
    const ch = text[index];
    if (ch === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
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
