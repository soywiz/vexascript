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
  resolveCallableSignature,
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

async function buildSignatureFromSymbol(
  context: InvocationContext,
  analysis: Analysis,
  program: Program,
  options: ClassResolverOptions
): Promise<SignatureInformation | null> {
  const callable = await resolveCallableSignature(context.callee, analysis, program, options);
  if (callable) {
    const parameters = callable.parameters.map((parameter) => ({
      label: formatParameterLabel(parameter)
    }));
    const label = `${callable.name}(${parameters.map((parameter) => parameter.label).join(", ")}): ${callable.returnTypeName}`;
    return {
      label,
      parameters,
      ...(callable.documentation ? { documentation: callable.documentation } : {})
    };
  }

  const symbolMatch = symbolAtNode(analysis, context.callee);
  if (!symbolMatch) {
    return null;
  }

  const functionType = toFunctionType(symbolMatch.symbol.type);
  if (functionType) {
    const parameters = functionType.parameters.map((parameter) => ({
      label: formatParameterLabel({
        name: parameter.name,
        typeName: typeToString(parameter.type),
        optional: parameter.optional === true,
        rest: parameter.rest === true
      })
    }));
    const label = `${symbolMatch.symbol.name}(${parameters.map((parameter) => parameter.label).join(", ")}): ${typeToString(functionType.returnType)}`;
    const documentation =
      symbolMatch.symbol.node.kind === "Identifier"
        ? readDocumentationFromProgramDeclaration(program, symbolMatch.symbol.node as Identifier)
        : undefined;
    return {
      label,
      parameters,
      ...(documentation ? { documentation } : {})
    };
  }

  if (context.isNewExpression) {
    const constructorSignature = await resolveConstructorSignature(context.callee, analysis, program, options);
    if (!constructorSignature) {
      return null;
    }
    const parameters = constructorSignature.parameters.map((parameter) => ({
      label: formatParameterLabel(parameter)
    }));
    const label = `new ${constructorSignature.className}(${parameters.map((parameter) => parameter.label).join(", ")})`;
    return {
      label,
      parameters
    };
  }

  return null;
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

  const signature = await buildSignatureFromSymbol(context, analysis, program, options);
  if (!signature) {
    return null;
  }

  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter: context.activeParameter
  };
}
