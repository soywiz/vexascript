import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType, type FunctionType, typeToString } from "compiler/analysis/types";
import type {
  AnnotationApplication,
  AnnotationStatement,
  CallExpression,
  Expr,
  Identifier,
  NewExpression,
  Node,
  Program
} from "compiler/ast/ast";
import { declarationIndexForStatements } from "compiler/analysis/declarationIndex";
import { bindingNameText } from "compiler/ast/bindingPatterns";
import type { SignatureHelp, SignatureInformation } from "vscode-languageserver/node.js";
import {
  getEcmaScriptRuntimeProgram,
  getVexaScriptRuntimeProgram
} from "compiler/runtime/ecmascriptDeclarations";
import {
  resolveCallableSignatures,
  resolveConstructorSignature,
  type ClassResolverOptions
} from "./classResolver";
import { readDocumentationFromProgramDeclaration } from "./documentation";
import { findBestMatch } from "./nodeSearch";
import { comparePosition, containsPosition, nodeRange, rangeSize, type NodeRange, type Position } from "./ranges";

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
    if (comparePosition(position, calleeEnd) < 0) {
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

function symbolAtNode(analysis: Analysis, node: Node) {
  if (!node.firstToken) {
    return null;
  }
  return analysis.getSymbolAt(node.firstToken.range.start.line, node.firstToken.range.start.column);
}

function toFunctionType(type: AnalysisType | undefined): FunctionType | null {
  if (!type || type.kind !== "function") {
    return null;
  }
  return type;
}

function formatParameterLabel(parameter: {
  name: string;
  typeName: string;
  optional?: boolean;
  rest?: boolean;
}): string {
  return `${parameter.rest ? "..." : ""}${parameter.name}${parameter.optional === true && parameter.rest !== true ? "?" : ""}: ${parameter.typeName}`;
}

function signatureInfoFromResolved(resolved: { name: string; parameters: { name: string; typeName: string; optional?: boolean; rest?: boolean }[]; returnTypeName: string; documentation?: string }): SignatureInformation {
  const parameters = resolved.parameters.map((p) => ({ label: formatParameterLabel(p) }));
  const label = `${resolved.name}(${parameters.map((p) => p.label).join(", ")}): ${resolved.returnTypeName}`;
  return { label, parameters, ...(resolved.documentation ? { documentation: resolved.documentation } : {}) };
}

function bestActiveSignature(signatures: SignatureInformation[], activeParameter: number, argumentCount: number): number {
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

async function buildSignaturesFromSymbol(
  context: InvocationContext,
  analysis: Analysis,
  program: Program,
  options: ClassResolverOptions
): Promise<SignatureInformation[]> {
  const callables = await resolveCallableSignatures(context.callee, analysis, program, options);
  if (callables.length > 0) {
    return callables.map(signatureInfoFromResolved);
  }

  const symbolMatch = symbolAtNode(analysis, context.callee);
  if (!symbolMatch) {
    return [];
  }

  const functionType = toFunctionType(symbolMatch.symbol.type);
  if (functionType) {
    const documentation =
      symbolMatch.symbol.node.kind === "Identifier"
        ? readDocumentationFromProgramDeclaration(program, symbolMatch.symbol.node as Identifier)
        : undefined;
    return [signatureInfoFromResolved({
      name: symbolMatch.symbol.name,
      parameters: functionType.parameters.map((p) => ({
        name: p.name,
        typeName: typeToString(p.type),
        optional: p.optional === true,
        rest: p.rest === true
      })),
      returnTypeName: typeToString(functionType.returnType),
      ...(documentation ? { documentation } : {})
    })];
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

  return {
    signatures,
    activeSignature: bestActiveSignature(signatures, context.activeParameter, context.arguments.length),
    activeParameter: context.activeParameter
  };
}
