import { baseTypeName } from "compiler/analysis/typeNames";
import {
  AnnotationStatement,
  CallExpression,
  ClassMethodMember,
  ClassStatement,
  FunctionStatement,
  Identifier,
  InterfaceMethodMember,
  InterfaceStatement,
  NamedArgument,
  NewExpression
} from "compiler/ast/ast";
import type { ClassPrimaryConstructorParameter, FunctionParameter, Program } from "compiler/ast/ast";
import { bindingNameText } from "compiler/ast/bindingPatterns";
import { walkAst } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";
import { extname } from "compiler/utils/path";
import type { Location } from "vscode-languageserver/node.js";
import { resolveConstructorSignature } from "./classResolver";
import { pathToUri, uriToFilePath } from "./importFixes";
import { readDocumentationInfoFromNamedNode } from "./documentation";
import { readTextDocument, type ResolveContext } from "./crossFileContext";
import { resolveTypeDefinitionAcrossFiles } from "./crossFileTypeResolution";
import { containsPosition, nodeRange, rangeSize } from "./ranges";

export type ParameterDeclaration = FunctionParameter | ClassPrimaryConstructorParameter;

export interface ResolvedNamedArgumentParameter {
  argumentRange: NonNullable<ReturnType<typeof nodeRange>>;
  declaration: ParameterDeclaration;
  location: Location;
}

export interface ResolvedConstructorCall {
  callRange: NonNullable<ReturnType<typeof nodeRange>>;
  location: Location;
  label: string;
  documentation?: string;
}

function smallestCallAt(
  ast: Program,
  predicate: (call: CallExpression | NewExpression) => boolean
): CallExpression | NewExpression | null {
  let best: CallExpression | NewExpression | null = null;
  let bestSize: number | null = null;
  walkAst(ast, (node) => {
    if (!(node instanceof CallExpression) && !(node instanceof NewExpression)) {
      return;
    }
    const range = nodeRange(node);
    if (!range || !predicate(node)) {
      return;
    }
    const size = rangeSize(range);
    if (bestSize === null || size <= bestSize) {
      best = node;
      bestSize = size;
    }
  });
  return best;
}

function namedArgumentAtPosition(
  ast: Program,
  line: number,
  character: number
): { argument: NamedArgument; callee: CallExpression["callee"] } | null {
  const position = { line, character };
  const containsArgument = (candidate: CallExpression | NewExpression) =>
    (candidate.args ?? []).some((item) => {
      const range = item instanceof NamedArgument ? nodeRange(item.name) : null;
      return range !== null && containsPosition(range, position);
    });
  const call = smallestCallAt(ast, containsArgument);
  const argument = call?.args?.find((item): item is NamedArgument => {
    const range = item instanceof NamedArgument ? nodeRange(item.name) : null;
    return range !== null && containsPosition(range, position);
  });
  return call && argument ? { argument, callee: call.callee } : null;
}

function parameterNamed(
  parameters: readonly ParameterDeclaration[],
  name: string
): ParameterDeclaration | null {
  return parameters.find((parameter) => bindingNameText(parameter.name) === name) ?? null;
}

function parameterAtDefinition(
  ast: Program,
  position: Location["range"]["start"],
  name: string
): ParameterDeclaration | null {
  let result: ParameterDeclaration | null = null;
  walkAst(ast, (node) => {
    if (result) return;
    if (
      node instanceof FunctionStatement ||
      node instanceof ClassMethodMember ||
      node instanceof InterfaceMethodMember ||
      node instanceof AnnotationStatement
    ) {
      const range = nodeRange(node.name);
      if (range && containsPosition(range, position)) {
        result = parameterNamed(node.parameters, name);
      }
      return;
    }
    if (!(node instanceof ClassStatement)) return;
    const range = nodeRange(node.name);
    if (!range || !containsPosition(range, position)) return;
    const constructor = node.members.find(
      (member): member is ClassMethodMember =>
        member instanceof ClassMethodMember && member.name.name === "constructor"
    );
    result = parameterNamed(constructor?.parameters ?? node.primaryConstructorParameters ?? [], name);
  });
  return result;
}

async function programForLocation(context: ResolveContext, location: Location): Promise<Program | null> {
  if (location.uri === context.uri) return context.session.ast;
  const filePath = uriToFilePath(location.uri);
  if (!filePath) return null;
  const session = await context.getSessionForFilePath?.(filePath);
  if (session?.ast) return session.ast;
  const source = await readTextDocument(context, filePath);
  if (source === null) return null;
  const extension = extname(filePath).toLowerCase();
  const typescript = [".ts", ".tsx", ".js", ".jsx"].includes(extension);
  return parseSource(source, typescript
    ? { language: "typescript", jsx: extension === ".tsx" || extension === ".jsx" }
    : {}).ast;
}

export async function resolveNamedArgumentParameter(
  context: ResolveContext,
  character: number,
  resolveCalleeDefinition: (context: ResolveContext) => Promise<Location | null>
): Promise<ResolvedNamedArgumentParameter | null> {
  if (!context.session.ast) return null;
  const target = namedArgumentAtPosition(context.session.ast, context.line, character);
  const argumentRange = target ? nodeRange(target.argument.name) : null;
  const calleeRange = target ? nodeRange(target.callee) : null;
  if (!target || !argumentRange || !calleeRange) return null;
  const calleeLocation = await resolveCalleeDefinition({
    ...context,
    line: calleeRange.start.line,
    character: calleeRange.start.character
  });
  if (!calleeLocation) return null;
  const declarationProgram = await programForLocation(context, calleeLocation);
  const declaration = declarationProgram
    ? parameterAtDefinition(declarationProgram, calleeLocation.range.start, target.argument.name.name)
    : null;
  const declarationRange = declaration?.name instanceof Identifier ? nodeRange(declaration.name) : null;
  return declaration && declarationRange
    ? {
        argumentRange,
        declaration,
        location: { uri: calleeLocation.uri, range: declarationRange }
      }
    : null;
}

function constructorMemberForSignature(
  declaration: InterfaceStatement,
  parameters: readonly { name: string; typeName: string }[]
): InterfaceMethodMember | null {
  const constructors = declaration.members.filter(
    (member): member is InterfaceMethodMember =>
      member instanceof InterfaceMethodMember && member.name.name === "constructor"
  );
  return constructors.find((member) =>
    member.parameters.length === parameters.length &&
    member.parameters.every((parameter, index) => {
      const resolved = parameters[index];
      return resolved !== undefined &&
        bindingNameText(parameter.name) === resolved.name &&
        (parameter.typeAnnotation?.name ?? "unknown") === resolved.typeName;
    })
  ) ?? constructors[constructors.length - 1] ?? null;
}

export async function resolveConstructorCall(
  context: ResolveContext,
  character: number
): Promise<ResolvedConstructorCall | null> {
  const { ast, analysis } = context.session;
  if (!ast || !analysis) return null;
  const position = { line: context.line, character };
  const call = smallestCallAt(ast, (candidate) => {
    const range = nodeRange(candidate.callee);
    return range !== null && containsPosition(range, position);
  });
  if (!call || !(call.callee instanceof Identifier)) return null;
  const calleeRange = nodeRange(call.callee);
  if (!calleeRange) return null;
  const signature = await resolveConstructorSignature(call.callee, analysis, ast, {
    uri: context.uri,
    sourceRoots: context.sourceRoots,
    ...(context.getSessionForFilePath ? { getSessionForFilePath: context.getSessionForFilePath } : {}),
    ...(context.session.ambientDeclarations ? { ambientDeclarations: context.session.ambientDeclarations } : {}),
    ...(context.session.ambientModuleDeclarations ? { ambientModuleDeclarations: context.session.ambientModuleDeclarations } : {}),
    ...(context.session.externalDeclarations ? { externalDeclarations: context.session.externalDeclarations } : {})
  }, call);
  if (!signature) return null;

  const symbol = analysis.getSymbolAt(calleeRange.start.line, calleeRange.start.character)?.symbol;
  const typeNames = [symbol?.valueType ? baseTypeName(symbol.valueType) : null, signature.className]
    .filter((name): name is string => Boolean(name));
  for (const typeName of typeNames) {
    const resolved = await resolveTypeDefinitionAcrossFiles(context, typeName);
    if (!resolved) continue;
    let declaration: ClassStatement | ClassMethodMember | InterfaceMethodMember;
    if (resolved.declaration instanceof InterfaceStatement) {
      const constructor = constructorMemberForSignature(resolved.declaration, signature.parameters);
      if (!constructor) continue;
      declaration = constructor;
    } else if (resolved.declaration instanceof ClassStatement) {
      declaration = resolved.declaration.members.find(
        (member): member is ClassMethodMember =>
          member instanceof ClassMethodMember && member.name.name === "constructor"
      ) ?? resolved.declaration;
    } else {
      continue;
    }
    const declarationRange = nodeRange(declaration.name);
    if (!declarationRange) continue;
    const returnTypeName = declaration instanceof InterfaceMethodMember
      ? declaration.returnType?.name ?? call.callee.name
      : call.callee.name;
    const parameterText = signature.parameters.map((parameter) =>
      `${parameter.rest ? "..." : ""}${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.typeName}`
    ).join(", ");
    const documentation = readDocumentationInfoFromNamedNode(declaration)?.text;
    return {
      callRange: calleeRange,
      location: { uri: pathToUri(resolved.filePath), range: declarationRange },
      label: `new ${call.callee.name}(${parameterText}): ${returnTypeName}`,
      ...(documentation ? { documentation } : {})
    };
  }
  return null;
}
