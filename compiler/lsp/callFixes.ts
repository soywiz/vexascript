import { BuiltinType, NamedType } from "../analysis/types";
import { NodeKind } from "compiler/ast/ast";
import { bindingElementPropertyName, bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import { splitOptionalTypeSuffix, splitTopLevelTypeText } from "compiler/analysis/typeNames";
import { findNode } from "compiler/ast/traversal";
import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType } from "compiler/analysis/types";
import type {
  ArrowFunctionExpression,
  CallExpression,
  FunctionExpression,
  FunctionStatement,
  Identifier,
  InterfaceMethodMember,
  InterfacePropertyMember,
  InterfaceStatement,
  JsxAttribute,
  JsxElement,
  ObjectBindingPattern,
  Program
} from "compiler/ast/ast";
import { tokenize, TokenType } from "compiler/parser/tokenizer";
import { type CodeAction, type Diagnostic, type Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { getCallDiagnosticKind } from "./diagnosticCodes";
import { findBestMatchAtPosition, type PositionMatchCandidate } from "./nodeSearch";
import { buildParameterTypeEdit, typeInsertionOffsetForParameter } from "./parameterTypeEdits";
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

interface RequiredPropSpec {
  name: string;
  typeName: string | undefined;
}

const MISSING_REQUIRED_ARGUMENT_PATTERN = /^Missing required argument for parameter '(.+)'$/;

function findCallArgumentAtPosition(program: Program, position: Position): CallArgumentMatch | null {
  return findBestMatchAtPosition(program, position, (node) => {
    if (node.kind !== NodeKind.CallExpression) {
      return null;
    }

    const call = node as CallExpression;
    const candidates: Array<PositionMatchCandidate<CallArgumentMatch>> = [];
    for (let index = 0; index < call.args.length; index += 1) {
      const range = nodeRange(call.args[index]!);
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
      node.kind === NodeKind.FunctionStatement && (node as FunctionStatement).name === nameNode
  );
}

function findJsxElementByReferencePosition(program: Program, position: Position): JsxElement | null {
  return findBestMatchAtPosition(program, position, (node) => {
    if (node.kind !== NodeKind.JsxElement) {
      return null;
    }
    const jsxElement = node as JsxElement;
    const referenceRange = jsxElement.reference ? nodeRange(jsxElement.reference) : null;
    if (!referenceRange) {
      return null;
    }
    return { range: referenceRange, build: () => jsxElement };
  });
}

function resolveVariableFunctionInitializer(
  program: Program,
  nameNode: Identifier
): ArrowFunctionExpression | FunctionExpression | null {
  const fromStatement = findNode(program, (node): node is import("compiler/ast/ast").VarStatement => {
    if (node.kind !== NodeKind.VarStatement) {
      return false;
    }
    const statement = node as import("compiler/ast/ast").VarStatement;
    if (bindingIdentifiers(statement.name).some((identifier) => identifier === nameNode)) {
      return statement.initializer?.kind === NodeKind.ArrowFunctionExpression || statement.initializer?.kind === NodeKind.FunctionExpression;
    }
    return !!statement.declarations?.some((declaration) =>
      bindingIdentifiers(declaration.name).some((identifier) => identifier === nameNode) &&
      (declaration.initializer?.kind === NodeKind.ArrowFunctionExpression || declaration.initializer?.kind === NodeKind.FunctionExpression)
    );
  });
  if (!fromStatement) {
    return null;
  }
  if (bindingIdentifiers(fromStatement.name).some((identifier) => identifier === nameNode)) {
    return (fromStatement.initializer as ArrowFunctionExpression | FunctionExpression | undefined) ?? null;
  }
  const declaration = fromStatement.declarations?.find((candidate) =>
    bindingIdentifiers(candidate.name).some((identifier) => identifier === nameNode)
  );
  return (declaration?.initializer as ArrowFunctionExpression | FunctionExpression | undefined) ?? null;
}

function resolveJsxComponentPropsParameter(
  program: Program,
  analysis: Analysis,
  jsxElement: JsxElement
): import("compiler/ast/ast").FunctionParameter | null {
  if (!jsxElement.reference?.firstToken) {
    return null;
  }
  const token = jsxElement.reference.firstToken;
  const symbolMatch = analysis.getSymbolAt(token.range.start.line, token.range.start.column);
  if (!symbolMatch || symbolMatch.symbol.node.kind !== NodeKind.Identifier) {
    return null;
  }
  const nameNode = symbolMatch.symbol.node as Identifier;
  if (symbolMatch.symbol.kind === "function") {
    return findFunctionDeclarationByNameNode(program, nameNode)?.parameters[0] ?? null;
  }
  if (symbolMatch.symbol.kind === "variable") {
    return resolveVariableFunctionInitializer(program, nameNode)?.parameters[0] ?? null;
  }
  return null;
}

function findInterfaceStatementByName(program: Program, name: string): InterfaceStatement | null {
  return findNode(
    program,
    (node): node is InterfaceStatement => node.kind === NodeKind.InterfaceStatement && (node as InterfaceStatement).name.name === name
  );
}

function renderInterfaceMethodType(member: InterfaceMethodMember): string {
  const parameters = member.parameters
    .filter((parameter) => parameter.thisParameter !== true)
    .map((parameter) => {
      const paramName = bindingIdentifiers(parameter.name)[0]?.name ?? "arg";
      const suffix = parameter.optional ? "?" : "";
      return `${paramName}${suffix}: ${parameter.typeAnnotation?.name ?? "unknown"}`;
    })
    .join(", ");
  return `(${parameters}) => ${member.returnType?.name ?? "void"}`;
}

function typeNameIsOptional(typeName: string | undefined): boolean {
  const normalized = typeName?.trim();
  if (!normalized) {
    return false;
  }
  if (splitOptionalTypeSuffix(normalized).optional) {
    return true;
  }
  return splitTopLevelTypeText(normalized, "|").some((part) => part.trim() === "undefined");
}

function requiredPropsFromObjectBinding(binding: ObjectBindingPattern): RequiredPropSpec[] {
  const props: RequiredPropSpec[] = [];
  for (const element of binding.elements) {
    if (element.rest === true || element.initializer) {
      continue;
    }
    const name = bindingElementPropertyName(element) ?? bindingIdentifiers(element.name)[0]?.name;
    if (!name || name === "children") {
      continue;
    }
    if (typeNameIsOptional(element.typeAnnotation?.name)) {
      continue;
    }
    props.push({ name, typeName: element.typeAnnotation?.name });
  }
  return props;
}

function requiredPropsFromInterface(program: Program, typeName: string): RequiredPropSpec[] {
  const interfaceStatement = findInterfaceStatementByName(program, typeName);
  if (!interfaceStatement) {
    return [];
  }
  const props: RequiredPropSpec[] = [];
  for (const member of interfaceStatement.members) {
    if (member.name.name === "children") {
      continue;
    }
    if (member.kind === NodeKind.InterfacePropertyMember) {
      const property = member as InterfacePropertyMember;
      if (property.optional || typeNameIsOptional(property.typeAnnotation?.name)) {
        continue;
      }
      props.push({ name: property.name.name, typeName: property.typeAnnotation?.name });
      continue;
    }
    const method = member as InterfaceMethodMember;
    if ((method as InterfaceMethodMember & { optional?: boolean }).optional) {
      continue;
    }
    props.push({ name: method.name.name, typeName: renderInterfaceMethodType(method) });
  }
  return props;
}

function requiredPropsForParameter(
  program: Program,
  parameter: import("compiler/ast/ast").FunctionParameter | null
): RequiredPropSpec[] {
  if (!parameter || parameter.thisParameter === true || parameter.rest === true) {
    return [];
  }
  if (parameter.name.kind === NodeKind.ObjectBindingPattern) {
    return requiredPropsFromObjectBinding(parameter.name as ObjectBindingPattern);
  }
  if (parameter.typeAnnotation) {
    return requiredPropsFromInterface(program, parameter.typeAnnotation.name);
  }
  return [];
}

function jsxAttributeValueText(typeName: string | undefined): string {
  const normalized = typeName?.trim();
  if (!normalized || normalized === "any" || normalized === "unknown") {
    return "={undefined}";
  }
  if (normalized === "string") {
    return '=""';
  }
  if (normalized === "boolean") {
    return "={false}";
  }
  if (normalized === "int" || normalized === "number" || normalized === "numeric") {
    return "={0}";
  }
  if (normalized === "bigint" || normalized === "long") {
    return "={0}";
  }
  if (normalized.includes("=>")) {
    return "={() => {}}";
  }
  if (normalized.startsWith("{")) {
    return "={{}}";
  }
  return "={undefined}";
}

function missingJsxPropsQuickFix(params: {
  uri: string;
  text: string;
  ast: Program;
  analysis: Analysis;
  diagnostics: Diagnostic[];
}): CodeAction[] {
  const { uri, text, ast, analysis, diagnostics } = params;
  const actions: CodeAction[] = [];
  const seen = new Set<string>();

  for (const diagnostic of diagnostics) {
    const missingMatch = MISSING_REQUIRED_ARGUMENT_PATTERN.exec(diagnostic.message);
    if (!missingMatch) {
      continue;
    }
    const position = diagnostic.range.start;
    const jsxElement = findJsxElementByReferencePosition(ast, position);
    if (!jsxElement) {
      continue;
    }
    const jsxKey = String(jsxElement.firstToken?.range.start.offset ?? `${position.line}:${position.character}`);
    if (seen.has(jsxKey)) {
      continue;
    }
    seen.add(jsxKey);

    const parameter = resolveJsxComponentPropsParameter(ast, analysis, jsxElement);
    const requiredProps = requiredPropsForParameter(ast, parameter);
    if (requiredProps.length === 0) {
      continue;
    }
    const provided = new Set<string>();
    for (const attribute of jsxElement.attributes) {
      if (attribute.kind !== NodeKind.JsxAttribute) {
        continue;
      }
      provided.add((attribute as JsxAttribute).name);
    }
    if (jsxElement.children.length > 0) {
      provided.add("children");
    }

    const missingProps = requiredProps.filter((prop) => !provided.has(prop.name));
    if (missingProps.length === 0) {
      continue;
    }

    const anchor = jsxElement.attributes.length > 0
      ? jsxElement.attributes[jsxElement.attributes.length - 1]?.lastToken?.range.end.offset
      : jsxElement.reference?.lastToken?.range.end.offset ?? jsxElement.firstToken?.range.end.offset;
    if (anchor === undefined) {
      continue;
    }

    const newText = missingProps
      .map((prop) => ` ${prop.name}${jsxAttributeValueText(prop.typeName)}`)
      .join("");

    actions.push({
      title: `Add missing props to '${jsxElement.tagName}'`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [
            {
              range: rangeAtOffset(text, anchor),
              newText
            },
          ]
        }
      }
    });
  }

  return actions;
}

function isFunctionCallDiagnostic(diagnostic: Diagnostic): boolean {
  return getCallDiagnosticKind(diagnostic) !== null || MISSING_REQUIRED_ARGUMENT_PATTERN.test(diagnostic.message);
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
  if (!symbolMatch || symbolMatch.symbol.kind !== "function" || symbolMatch.symbol.node.kind !== NodeKind.Identifier) {
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
  if (type instanceof BuiltinType) {
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
  if (type instanceof NamedType) {
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
      token.type === TokenType.SYMBOL &&
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
    if (token.type !== TokenType.SYMBOL) {
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
  if (call.args.length <= existingCount) {
    return null;
  }

  const expressionTypes = analysis.getExpressionTypes();
  const usedNames = new Set(functionDeclaration.parameters.flatMap((parameter) => bindingIdentifiers(parameter.name).map((identifier) => identifier.name)));
  const missingParts: string[] = [];

  for (let index = existingCount; index < call.args.length; index += 1) {
    const argument = call.args[index]!;
    const inferredType = toTypeAnnotation(expressionTypes.get(argument));
    const rawName =
      argument.kind === NodeKind.Identifier
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
  const argument = call.args[argumentIndex];
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

  const edit = buildParameterTypeEdit(parameter, text, annotation);
  if (!edit) {
    return null;
  }

  return {
    title: `Change parameter '${bindingNameText(parameter.name)}' type to '${annotation}'`,
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [uri]: [
          {
            range: edit.range,
            newText: edit.newText
          }
        ]
      }
    }
  };
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
  const provided = call.args;

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
        const rawName = argument.kind === NodeKind.Identifier ? (argument as Identifier).name : `arg${index + 1}`;
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
  actions.push(...missingJsxPropsQuickFix({
    uri,
    text,
    ast,
    analysis,
    diagnostics
  }));
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
