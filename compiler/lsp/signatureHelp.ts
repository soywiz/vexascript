import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType, type FunctionType, typeToString } from "compiler/analysis/types";
import type {
  AnnotationApplication,
  AnnotationStatement,
  CallExpression,
  Expr,
  ExportStatement,
  FunctionStatement,
  Identifier,
  MemberExpression,
  NewExpression,
  Node,
  Program,
  Statement
} from "compiler/ast/ast";
import { declarationIndexForStatements } from "compiler/analysis/declarationIndex";
import { bindingNameText } from "compiler/ast/bindingPatterns";
import { findMatchingTypeDelimiter, findTopLevelTypeCharacter, splitTopLevelDelimitedTypeText, splitTopLevelTypeText } from "compiler/analysis/typeNames";
import type { SignatureHelp, SignatureInformation } from "vscode-languageserver/node.js";
import {
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeProgram
} from "compiler/runtime/ecmascriptDeclarations";
import {
  formatParameterLabel,
  resolveCallableSignatures,
  resolveConstructorSignature,
  type ClassResolverOptions
} from "./classResolver";
import {
  readDocumentationForSymbol,
  readDocumentationFromNamedNode
} from "./documentation";
import { findBestMatch } from "./nodeSearch";
import { resolveCursorTarget, type CursorTarget } from "./navigation";
import { comparePosition, containsPosition, nodeRange, rangeSize, type NodeRange, type Position } from "./ranges";
import { collectAmbientFunctionStatements, detectAmbientExportEqualsName, findAmbientModuleReceiverCandidates, findAmbientNamespaceBody } from "./crossFileContext";

interface InvocationContext {
  callee: Expr;
  arguments: Expr[];
  range: NodeRange;
  activeParameter: number;
  isNewExpression: boolean;
}

interface AnnotationInvocationContext {
  annotation: AnnotationApplication;
  range: NodeRange;
  activeParameter: number;
}

function argumentIndexAtPosition(argumentsList: Expr[], position: Position): number {
  if (argumentsList.length === 0) {
    return 0;
  }

  let active = 0;
  for (let i = 0; i < argumentsList.length; i += 1) {
    const argument = argumentsList[i]!;
    const argStart = argument.firstToken
      ? {
          line: argument.firstToken.range.start.line,
          character: argument.firstToken.range.start.column
        }
      : undefined;
    const argEnd = argument.lastToken
      ? {
          line: argument.lastToken.range.end.line,
          character: argument.lastToken.range.end.column
        }
      : undefined;

    if (argStart && comparePosition(position, argStart) < 0) {
      return i;
    }

    if (argEnd && comparePosition(position, argEnd) <= 0) {
      return i;
    }

    active = i + 1;
  }

  return active;
}

function invocationContextForNode(
  position: Position,
  callee: Expr,
  argumentsList: Expr[],
  node: Node,
  isNewExpression: boolean
): InvocationContext | null {
  const range = nodeRange(node);
  if (!range || !containsPosition(range, position)) {
    return null;
  }

  if (callee.lastToken) {
    const calleeEnd: Position = {
      line: callee.lastToken.range.end.line,
      character: callee.lastToken.range.end.column
    };
    if (comparePosition(position, calleeEnd) <= 0) {
      return null;
    }
  }

  const closeToken = node.lastToken as {
    type?: string;
    value?: string;
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
  } | undefined;
  if (closeToken?.type === "symbol" && closeToken.value === ")") {
    const closeParenEnd: Position = {
      line: closeToken.range.end.line,
      character: closeToken.range.end.column
    };
    if (comparePosition(position, closeParenEnd) >= 0) {
      return null;
    }
  }

  return {
    callee,
    arguments: argumentsList,
    range,
    activeParameter: argumentIndexAtPosition(argumentsList, position),
    isNewExpression
  };
}

function findInvocationContext(program: Program, line: number, character: number): InvocationContext | null {
  const position: Position = { line, character };
  return findBestMatch(program, (node) => {
    if (node.kind !== "CallExpression" && node.kind !== "NewExpression") {
      return null;
    }
    const callLike = node as CallExpression | NewExpression;
    const context = invocationContextForNode(
      position,
      callLike.callee,
      callLike.arguments ?? [],
      node,
      node.kind === "NewExpression"
    );
    return context ? { size: rangeSize(context.range), value: context } : null;
  });
}

function findAnnotationInvocationContext(program: Program, line: number, character: number): AnnotationInvocationContext | null {
  const position: Position = { line, character };
  let best: AnnotationInvocationContext | null = null;
  for (const statement of program.body) {
    for (const annotation of statement.annotations ?? []) {
      const range = nodeRange(annotation);
      if (!range || !containsPosition(range, position)) {
        continue;
      }
      const candidate: AnnotationInvocationContext = {
        annotation,
        range,
        activeParameter: argumentIndexAtPosition(annotation.arguments, position)
      };
      if (!best || rangeSize(candidate.range) <= rangeSize(best.range)) {
        best = candidate;
      }
    }
  }
  return best;
}


function toFunctionType(type: AnalysisType | undefined): FunctionType | null {
  if (!type || type.kind !== "function") {
    return null;
  }
  return type;
}

function signatureInfosFromAnalysisType(
  name: string,
  type: AnalysisType | undefined,
  documentation?: string
): SignatureInformation[] {
  if (!type) {
    return [];
  }

  if (type.kind === "function") {
    return [signatureInfoFromResolved({
      name,
      parameters: type.parameters.map((parameter) => ({
        name: parameter.name,
        typeName: typeToString(parameter.type),
        optional: parameter.optional === true,
        rest: parameter.rest === true
      })),
      returnTypeName: typeToString(type.returnType),
      ...(documentation ? { documentation } : {})
    })];
  }

  if (type.kind === "union") {
    const signatures = type.types.flatMap((candidate) => signatureInfosFromAnalysisType(name, candidate, documentation));
    return signatures;
  }

  return [];
}

function signatureInfoFromResolved(resolved: { name: string; parameters: { name: string; typeName: string; optional?: boolean; rest?: boolean }[]; returnTypeName: string; documentation?: string }): SignatureInformation {
  const parameters = resolved.parameters.map((p) => ({ label: formatParameterLabel(p) }));
  const label = `${resolved.name}(${parameters.map((p) => p.label).join(", ")}): ${resolved.returnTypeName}`;
  return { label, parameters, ...(resolved.documentation ? { documentation: resolved.documentation } : {}) };
}

function ambientFunctionSignatureInfo(
  ownerStatement: Statement,
  fn: FunctionStatement
): SignatureInformation {
  const parameters = fn.parameters
    .filter((parameter) => parameter.thisParameter !== true)
    .map((parameter) => ({
      label: formatParameterLabel({
        name: parameter.name.kind === "Identifier" ? parameter.name.name : "arg",
        typeName: parameter.typeAnnotation?.name ?? "unknown",
        optional: parameter.optional === true || parameter.defaultValue !== undefined,
        rest: parameter.rest === true
      })
    }));
  const documentation = readDocumentationFromNamedNode({
    firstToken: ownerStatement.firstToken ?? fn.firstToken,
    name: fn.name
  });
  return {
    label: `${fn.name.name}(${parameters.map((parameter) => parameter.label).join(", ")}): ${fn.returnType?.name ?? "unknown"}`,
    parameters,
    ...(documentation ? { documentation } : {})
  };
}

function collectAmbientFunctionOverloads(
  statements: readonly Statement[],
  memberName: string
): SignatureInformation[] {
  // Use collectAmbientFunctionStatements for the filtering logic and map each
  // matched fn back to its owner statement (the ExportStatement wrapper, if
  // any) so ambientFunctionSignatureInfo can read leading documentation comments
  // from the export wrapper's first token.
  return collectAmbientFunctionStatements(statements, memberName).map((fn) => {
    const ownerStatement = statements.find((s) => {
      const candidate = s.kind === "ExportStatement"
        ? (s as ExportStatement).declaration ?? s
        : s;
      return candidate === fn;
    }) ?? fn;
    return ambientFunctionSignatureInfo(ownerStatement, fn);
  });
}

function ambientDefaultImportMemberSignatures(
  program: Program,
  callee: MemberExpression,
  options: ClassResolverOptions
): SignatureInformation[] {
  if (callee.object.kind !== "Identifier" || callee.property.kind !== "Identifier") {
    return [];
  }
  const ambientModuleDeclarations = options.ambientModuleDeclarations;
  if (!ambientModuleDeclarations) {
    return [];
  }

  const receiverName = (callee.object as Identifier).name;
  const memberName = (callee.property as Identifier).name;
  const moduleCandidates = findAmbientModuleReceiverCandidates(program, receiverName);
  if (!moduleCandidates) {
    return [];
  }

  for (const moduleName of moduleCandidates) {
    const declarations = ambientModuleDeclarations.get(moduleName);
    if (!declarations || declarations.length === 0) {
      continue;
    }

    const directSignatures = collectAmbientFunctionOverloads(declarations, memberName);
    if (directSignatures.length > 0) {
      return directSignatures;
    }

    const exportEqualsName = detectAmbientExportEqualsName(declarations);
    if (!exportEqualsName) {
      continue;
    }
    const namespaceBody = findAmbientNamespaceBody(declarations, exportEqualsName);
    if (!namespaceBody) {
      continue;
    }
    const namespaceSignatures = collectAmbientFunctionOverloads(namespaceBody, memberName);
    if (namespaceSignatures.length > 0) {
      return namespaceSignatures;
    }
  }

  return [];
}

function bestActiveSignature(signatures: SignatureInformation[], activeParameter: number, argumentCount: number): number {
  // Selects the best signature for display based on argument count.
  // The counterpart for definition navigation (jump-to-declaration) is
  // `findAmbientImportedOverloadRange` in `crossFileNavigation.ts`, which
  // uses the analysis-resolved overload index instead of argument count.
  if (argumentCount === 0) {
    const zeroParamIdx = signatures.findIndex((s) => (s.parameters?.length ?? 0) === 0);
    if (zeroParamIdx >= 0) return zeroParamIdx;
  }
  for (let i = 0; i < signatures.length; i++) {
    const paramCount = signatures[i]!.parameters?.length ?? 0;
    if (paramCount >= activeParameter + 1) return i;
  }
  return signatures.length - 1;
}

function signatureParameterIsVariadic(parameter: { label: string | [number, number] } | undefined): boolean {
  if (!parameter) {
    return false;
  }
  if (typeof parameter.label !== "string") {
    return false;
  }
  return parameter.label.trimStart().startsWith("...");
}

function activeParameterForSignature(signature: SignatureInformation | undefined, requestedActiveParameter: number): number {
  const parameterCount = signature?.parameters?.length ?? 0;
  if (parameterCount === 0) {
    return 0;
  }
  if (requestedActiveParameter < parameterCount) {
    return requestedActiveParameter;
  }
  const lastParameter = signature?.parameters?.[parameterCount - 1];
  if (signatureParameterIsVariadic(lastParameter)) {
    return parameterCount - 1;
  }
  return parameterCount - 1;
}

function parseDisplayFunctionSignatureText(
  name: string,
  signatureText: string,
  documentation?: string
): SignatureInformation | null {
  const trimmed = signatureText.trim();
  const parameterStart = findTopLevelTypeCharacter(trimmed, "(");
  if (parameterStart < 0) {
    return null;
  }
  const parameterEnd = findMatchingTypeDelimiter(trimmed, parameterStart, "(", ")");
  if (parameterEnd < 0) {
    return null;
  }
  const arrowIndex = trimmed.indexOf("=>", parameterEnd);
  if (arrowIndex < 0) {
    return null;
  }

  const parameterText = trimmed.slice(parameterStart + 1, parameterEnd).trim();
  const returnTypeName = trimmed.slice(arrowIndex + 2).trim();
  const parameterLabels = parameterText.length === 0 ? [] : splitTopLevelDelimitedTypeText(parameterText, new Set([","]));
  const parameters = parameterLabels.map((label) => ({ label }));
  const label = `${name}(${parameterLabels.join(", ")}): ${returnTypeName}`;
  return { label, parameters, ...(documentation ? { documentation } : {}) };
}

function signatureInfosFromDisplayFunctionType(
  name: string,
  displayType: string | undefined,
  documentation?: string
): SignatureInformation[] {
  if (!displayType) {
    return [];
  }
  return splitTopLevelTypeText(displayType, "|")
    .map((part) => parseDisplayFunctionSignatureText(name, part, documentation))
    .filter((signature): signature is SignatureInformation => signature !== null);
}

function resolveCalleeTarget(
  analysis: Analysis,
  program: Program,
  callee: Expr
): Extract<CursorTarget, { kind: "analysis" }> | null {
  if (!callee.firstToken) {
    return null;
  }
  const target = resolveCursorTarget(
    analysis,
    callee.firstToken.range.start.line,
    callee.firstToken.range.start.column,
    program
  );
  return target?.kind === "analysis" ? target : null;
}

async function buildSignaturesFromSymbol(
  context: InvocationContext,
  analysis: Analysis,
  program: Program,
  options: ClassResolverOptions
): Promise<SignatureInformation[]> {
  // Resolve the callee through the shared cursor-target pipeline so all
  // features use the same symbol identity instead of private analysis calls.
  const target = resolveCalleeTarget(analysis, program, context.callee);
  const symbolMatch = target?.symbolAt;

  // For identifier callees, prefer the display type string when available:
  // it preserves the original type alias names from ambient declarations
  // (e.g. `PathLike | FileHandle` rather than the expanded `string | Buffer | URL`).
  // When no display string is available, fall through to structured resolution.
  if (context.callee.kind === "Identifier" && symbolMatch?.symbol.valueType) {
    const documentation =
      symbolMatch.symbol.node.kind === "Identifier"
        ? readDocumentationForSymbol(program, symbolMatch.symbol.node as Identifier, {
            ambientModuleDeclarations: options.ambientModuleDeclarations
          })
        : undefined;
    const displaySignatures = signatureInfosFromDisplayFunctionType(
      symbolMatch.symbol.name,
      symbolMatch.symbol.valueType,
      documentation
    );
    if (displaySignatures.length > 0) {
      return displaySignatures;
    }
  }

  // Structured resolution: class/interface members, imported function types.
  const callables = await resolveCallableSignatures(context.callee, analysis, program, options);
  if (callables.length > 0) {
    return callables.map(signatureInfoFromResolved);
  }

  // Ambient default-import member signatures (e.g. `util.format`).
  if (context.callee.kind === "MemberExpression") {
    const ambientSignatures = ambientDefaultImportMemberSignatures(
      program,
      context.callee as MemberExpression,
      options
    );
    if (ambientSignatures.length > 0) {
      return ambientSignatures;
    }
  }

  if (!symbolMatch) {
    if (context.callee.kind === "MemberExpression") {
      const member = context.callee as MemberExpression;
      if (!member.computed && member.property.kind === "Identifier") {
        const memberName = (member.property as Identifier).name;
        const memberType = analysis.getExpressionTypes().get(context.callee);
        const signatures = signatureInfosFromAnalysisType(memberName, memberType);
        if (signatures.length > 0) {
          return signatures;
        }
      }
    }
    if (context.isNewExpression) {
      const constructorSignature = await resolveConstructorSignature(context.callee, analysis, program, options);
      if (!constructorSignature) {
        return [];
      }
      const parameters = constructorSignature.parameters.map((p) => ({ label: formatParameterLabel(p) }));
      const label = `new ${constructorSignature.className}(${parameters.map((p) => p.label).join(", ")})`;
      return [{ label, parameters }];
    }
    return [];
  }

  const documentation =
    symbolMatch.symbol.node.kind === "Identifier"
      ? readDocumentationForSymbol(program, symbolMatch.symbol.node as Identifier, {
          ambientModuleDeclarations: options.ambientModuleDeclarations
        })
      : undefined;

  // Structured type resolution via the analysis type system.
  const functionType = toFunctionType(symbolMatch.symbol.type);
  if (functionType) {
    return signatureInfosFromAnalysisType(symbolMatch.symbol.name, functionType, documentation);
  }

  // Display-string fallback: used when the analysis only has a display type
  // string (e.g. for imported function variables typed as `(a: T) => R` with
  // no structured AnalysisType registered).
  const displaySignatures = signatureInfosFromDisplayFunctionType(
    symbolMatch.symbol.name,
    symbolMatch.symbol.valueType,
    documentation
  );
  if (displaySignatures.length > 0) {
    return displaySignatures;
  }

  if (context.callee.kind === "MemberExpression") {
    const member = context.callee as MemberExpression;
    if (!member.computed && member.property.kind === "Identifier") {
      const memberName = (member.property as Identifier).name;
      const memberType = analysis.getExpressionTypes().get(context.callee);
      const signatures = signatureInfosFromAnalysisType(memberName, memberType);
      if (signatures.length > 0) {
        return signatures;
      }
    }
  }

  if (context.isNewExpression) {
    const constructorSignature = await resolveConstructorSignature(context.callee, analysis, program, options);
    if (!constructorSignature) {
      return [];
    }
    const parameters = constructorSignature.parameters.map((p) => ({ label: formatParameterLabel(p) }));
    const label = `new ${constructorSignature.className}(${parameters.map((p) => p.label).join(", ")})`;
    return [{ label, parameters }];
  }

  return [];
}

function findAnnotationDeclaration(program: Program, name: string): AnnotationStatement | null {
  for (const statement of declarationIndexForStatements(program.body).annotations) {
    if (statement.name.name === name) {
      return statement;
    }
  }
  for (const statement of declarationIndexForStatements(getVexaScriptRuntimeProgram().body).annotations) {
    if (statement.name.name === name) {
      return statement;
    }
  }
  for (const statement of declarationIndexForStatements(getEcmaScriptRuntimeProgram().body).annotations) {
    if (statement.name.name === name) {
      return statement;
    }
  }
  return null;
}

function annotationParameterLabel(parameter: AnnotationStatement["parameters"][number]): string {
  const name = bindingNameText(parameter.name);
  const prefix = parameter.accessModifier === "public" && parameter.readonly === true
    ? "val "
    : parameter.accessModifier === "public"
      ? "var "
      : "";
  return `${prefix}${name}: ${parameter.typeAnnotation?.name ?? "unknown"}`;
}

function buildAnnotationSignature(
  program: Program,
  context: AnnotationInvocationContext
): SignatureInformation | null {
  const declaration = findAnnotationDeclaration(program, context.annotation.name.name);
  if (!declaration) {
    return null;
  }
  const parameters = declaration.parameters.map((parameter) => ({
    label: annotationParameterLabel(parameter)
  }));
  return {
    label: `${declaration.name.name}(${parameters.map((parameter) => parameter.label).join(", ")})`,
    parameters
  };
}

export async function createSignatureHelp(
  program: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: ClassResolverOptions = {}
): Promise<SignatureHelp | null> {
  const annotationContext = findAnnotationInvocationContext(program, line, character);
  if (annotationContext) {
    const signature = buildAnnotationSignature(program, annotationContext);
    if (!signature) {
      return null;
    }
    return {
      signatures: [signature],
      activeSignature: 0,
      activeParameter: annotationContext.activeParameter
    };
  }
  const context = findInvocationContext(program, line, character);
  if (!context) {
    return null;
  }

  const signatures = await buildSignaturesFromSymbol(context, analysis, program, options);
  if (signatures.length === 0) {
    return null;
  }

  const activeSignature = bestActiveSignature(signatures, context.activeParameter, context.arguments.length);

  return {
    signatures,
    activeSignature,
    activeParameter: activeParameterForSignature(signatures[activeSignature], context.activeParameter)
  };
}
