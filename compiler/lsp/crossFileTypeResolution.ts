/**
 * Shared cross-file member/type resolution helpers: class/interface/type-alias
 * member shape extraction, cross-file type-declaration resolution, and
 * position lookups for type identifiers, member expressions, and member
 * declarations. Used by the definition/hover/references operations in
 * crossFileNavigation.ts.
 */
import { classPropertyParameters } from "./classResolver";
import { effectiveSourceRoots, preferVirtualRuntimeDeclarationFilePath, readTextDocument } from "./crossFileContext";
import type { ResolveContext } from "./crossFileContext";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { uriToFilePath } from "./importFixes";
import { containsPosition, nodeRange } from "./ranges";
import { findMatchingTypeDelimiter, findTopLevelTypeCharacter, splitTopLevelDelimitedTypeText } from "compiler/analysis/typeNames";
import type { ArrayLiteral, ArrowFunctionExpression, AsExpression, AssignmentExpression, BinaryExpression, BlockStatement, CallExpression, ClassStatement, CommaExpression, ConditionalExpression, DoWhileStatement, ExportStatement, Expr, ExprStatement, ForStatement, FunctionExpression, FunctionParameter, FunctionStatement, Identifier, IfStatement, InterfaceStatement, LabeledStatement, MemberExpression, NewExpression, NonNullExpression, ObjectLiteral, Program, RangeExpression, ReturnStatement, Statement, SwitchStatement, ThrowStatement, TryStatement, TypeAliasStatement, UnaryExpression, UpdateExpression, VarStatement, WhileStatement, WithStatement } from "compiler/ast/ast";
import { bindingNameText } from "compiler/ast/bindingPatterns";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { getDomDeclarationFilePath } from "compiler/runtime/domDeclarations";
import { getEcmaScriptRuntimeDeclarationFilePath } from "compiler/runtime/ecmascriptDeclarations";


export interface CanonicalMemberSymbol {
  className: string;
  memberName: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface ClassMemberInfo {
  memberName: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  typeLabel: string;
  sourceKind: "primary-constructor" | "field" | "method";
}

export type TypeLikeDeclaration = ClassStatement | InterfaceStatement;

export interface ObjectTypeMemberInfo {
  memberName: string;
  typeLabel: string;
  kind: "field" | "method";
}

export const TYPE_ANNOTATION_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "extendsType",
  "extendsTypes",
  "implementsTypes",
  "receiverType",
  "typeArguments",
  "constraint",
  "defaultType"
]);

export function classMemberDeclarationRangeByName(
  classStatement: TypeLikeDeclaration,
  memberName: string
): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  if (classStatement.kind === "InterfaceStatement") {
    for (const member of classStatement.members) {
      if (member.name.name !== memberName) {
        continue;
      }
      const range = nodeRange(member.name);
      if (range) {
        return range;
      }
    }
    return null;
  }

  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) !== memberName) {
      continue;
    }
    const range = nodeRange(parameter.name);
    if (range) {
      return range;
    }
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    const range = nodeRange(member.name);
    if (range) {
      return range;
    }
  }

  return null;
}

export async function fallbackInterfaceMemberRangeInFile(
  context: ResolveContext,
  filePath: string,
  interfaceName: string,
  memberName: string
): Promise<{ start: { line: number; character: number }; end: { line: number; character: number } } | null> {
  const source = await readTextDocument(context, filePath);
  if (source === null) {
    return null;
  }
  const lines = source.split("\n");
  const interfacePattern = new RegExp(`\\binterface\\s+${interfaceName}\\b`);
  const memberPattern = new RegExp(`\\b${memberName}\\b`);

  let interfaceLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (interfacePattern.test(lines[i] ?? "")) {
      interfaceLine = i;
      break;
    }
  }
  if (interfaceLine < 0) {
    return null;
  }

  let braceDepth = 0;
  let enteredBody = false;
  for (let i = interfaceLine; i < lines.length; i += 1) {
    const lineText = lines[i] ?? "";
    for (const char of lineText) {
      if (char === "{") {
        braceDepth += 1;
        enteredBody = true;
      } else if (char === "}") {
        braceDepth -= 1;
      }
    }
    if (enteredBody && braceDepth <= 0) {
      break;
    }
    const match = memberPattern.exec(lineText);
    if (!match) {
      continue;
    }
    return {
      start: { line: i, character: match.index },
      end: { line: i, character: match.index + memberName.length }
    };
  }

  return null;
}

export async function fallbackTypeAliasMemberRangeInFile(
  context: ResolveContext,
  filePath: string,
  typeAliasName: string,
  memberName: string
): Promise<{ start: { line: number; character: number }; end: { line: number; character: number } } | null> {
  const source = await readTextDocument(context, filePath);
  if (source === null) {
    return null;
  }
  const lines = source.split("\n");
  const typePattern = new RegExp(`\\btype\\s+${typeAliasName}\\b`);
  const memberPattern = new RegExp(`\\b${memberName}\\b`);

  let typeLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (typePattern.test(lines[i] ?? "")) {
      typeLine = i;
      break;
    }
  }
  if (typeLine < 0) {
    return null;
  }

  let braceDepth = 0;
  let enteredBody = false;
  for (let i = typeLine; i < lines.length; i += 1) {
    const lineText = lines[i] ?? "";
    for (const char of lineText) {
      if (char === "{") {
        braceDepth += 1;
        enteredBody = true;
      } else if (char === "}") {
        braceDepth -= 1;
      }
    }
    if (enteredBody && braceDepth <= 0) {
      break;
    }
    const match = memberPattern.exec(lineText);
    if (!match) {
      continue;
    }
    return {
      start: { line: i, character: match.index },
      end: { line: i, character: match.index + memberName.length }
    };
  }

  return null;
}

export function functionTypeLabelFromParameters(
  parameters: FunctionParameter[],
  returnTypeName?: string
): string {
  const parameterLabel = parameters
    .map((parameter) => {
      const typeName = parameter.typeAnnotation?.name ?? "unknown";
      const optionalSuffix = parameter.optional ? "?" : "";
      return `${bindingNameText(parameter.name)}${optionalSuffix}: ${typeName}`;
    })
    .join(", ");
  return `(${parameterLabel}) => ${returnTypeName ?? "void"}`;
}

export function classMemberInfoByName(
  classStatement: TypeLikeDeclaration,
  memberName: string
): ClassMemberInfo | null {
  if (classStatement.kind === "InterfaceStatement") {
    for (const member of classStatement.members) {
      if (member.name.name !== memberName) {
        continue;
      }
      const range = nodeRange(member.name);
      if (!range) {
        return null;
      }
      if (member.kind === "InterfacePropertyMember") {
        return {
          memberName,
          range,
          typeLabel: member.typeAnnotation.name,
          sourceKind: "field"
        };
      }
      return {
        memberName,
        range,
        typeLabel: functionTypeLabelFromParameters(member.parameters, member.returnType?.name),
        sourceKind: "method"
      };
    }
    return null;
  }

  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) !== memberName) {
      continue;
    }
    const range = nodeRange(parameter.name);
    if (!range) {
      return null;
    }
    return {
      memberName,
      range,
      typeLabel: parameter.typeAnnotation?.name ?? "unknown",
      sourceKind: "primary-constructor"
    };
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    const range = nodeRange(member.name);
    if (!range) {
      return null;
    }
    if (member.kind === "ClassFieldMember") {
      return {
        memberName,
        range,
        typeLabel: member.typeAnnotation?.name ?? "unknown",
        sourceKind: "field"
      };
    }
    return {
      memberName,
      range,
      typeLabel: functionTypeLabelFromParameters(member.parameters, member.returnType?.name),
      sourceKind: "method"
    };
  }

  return null;
}

export function parseObjectTypeMemberInfo(
  objectTypeText: string,
  memberName: string
): ObjectTypeMemberInfo | null {
  const targetTypeText = objectTypeText.trim();
  if (!targetTypeText.startsWith("{") || !targetTypeText.endsWith("}")) {
    return null;
  }

  const body = targetTypeText.slice(1, -1).trim();
  if (body.length === 0) {
    return null;
  }

  for (const entry of splitTopLevelDelimitedTypeText(body, new Set([",", ";"]))) {
    const trimmedEntry = entry.trim();
    if (trimmedEntry.length === 0) {
      continue;
    }

    const methodOpenParen = findTopLevelTypeCharacter(trimmedEntry, "(");
    const propertyColon = findTopLevelTypeCharacter(trimmedEntry, ":");
    if (methodOpenParen >= 0 && (propertyColon < 0 || methodOpenParen < propertyColon)) {
      const closeParen = findMatchingTypeDelimiter(trimmedEntry, methodOpenParen, "(", ")");
      const arrowIndex = closeParen >= 0 ? trimmedEntry.indexOf("=>", closeParen) : -1;
      if (closeParen < 0 || arrowIndex < 0) {
        continue;
      }
      const candidateName = trimmedEntry.slice(0, methodOpenParen).trim().replace(/\?$/, "");
      if (candidateName !== memberName) {
        continue;
      }
      return {
        memberName,
        kind: "method",
        typeLabel: trimmedEntry.slice(methodOpenParen).trim()
      };
    }

    if (propertyColon < 0) {
      continue;
    }
    const candidateName = trimmedEntry.slice(0, propertyColon).trim().replace(/\?$/, "");
    if (candidateName !== memberName) {
      continue;
    }
    return {
      memberName,
      kind: "field",
      typeLabel: trimmedEntry.slice(propertyColon + 1).trim()
    };
  }

  return null;
}

export async function resolveTypeDefinitionAcrossFiles(
  context: ResolveContext,
  typeName: string
): Promise<{ declaration: TypeLikeDeclaration; filePath: string } | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = effectiveSourceRoots(context.sourceRoots, currentFilePath);
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: typeName,
    currentFilePath,
    predicate: (statement): statement is TypeLikeDeclaration =>
      statement.kind === "ClassStatement" || statement.kind === "InterfaceStatement",
    includeRuntime: true,
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });

  if (!resolved) {
    const ambientDeclaration = findAmbientTypeDeclaration(context.session.ambientDeclarations ?? [], typeName);
    if (!ambientDeclaration) {
      return null;
    }
    return {
      declaration: ambientDeclaration,
      filePath: await preferVirtualRuntimeDeclarationFilePath(getDomDeclarationFilePath(), context)
    };
  }

  const resolvedFilePath = resolved.filePath === ""
    ? await getEcmaScriptRuntimeDeclarationFilePath()
    : resolved.filePath;
  return {
    declaration: resolved.declaration,
    filePath: await preferVirtualRuntimeDeclarationFilePath(resolvedFilePath, context)
  };
}

export function findAmbientTypeDeclaration(
  declarations: Statement[],
  typeName: string
): TypeLikeDeclaration | null {
  for (const statement of declarations) {
    const unwrapped = unwrapExportedDeclaration(statement) ?? statement;
    if (unwrapped.kind === "ClassStatement" || unwrapped.kind === "InterfaceStatement") {
      const declaration = unwrapped as TypeLikeDeclaration;
      if (declaration.name.name === typeName) {
        return declaration;
      }
    }
  }
  return null;
}

export async function resolveTypeAliasDefinitionAcrossFiles(
  context: ResolveContext,
  typeName: string
): Promise<{ declaration: TypeAliasStatement; filePath: string } | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = effectiveSourceRoots(context.sourceRoots, currentFilePath);
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: typeName,
    currentFilePath,
    predicate: (statement): statement is TypeAliasStatement => statement.kind === "TypeAliasStatement",
    includeRuntime: true,
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });

  if (!resolved) {
    return null;
  }

  return {
    declaration: resolved.declaration,
    filePath: resolved.filePath === "" ? await getEcmaScriptRuntimeDeclarationFilePath() : resolved.filePath
  };
}

export function isAstNode(value: unknown): value is { kind: string } {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

export function findTypeIdentifierAtPosition(
  value: unknown,
  line: number,
  character: number
): Identifier | null {
  let best: Identifier | null = null;
  let bestSize = Number.POSITIVE_INFINITY;

  const considerIdentifier = (identifier: Identifier): void => {
    const range = nodeRange(identifier);
    if (!range || !containsPosition(range, { line, character })) {
      return;
    }
    const size =
      (range.end.line - range.start.line) * 100_000 +
      (range.end.character - range.start.character);
    if (size <= bestSize) {
      best = identifier;
      bestSize = size;
    }
  };

  const visitTypeValue = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visitTypeValue(item);
      }
      return;
    }
    if (!isAstNode(entry)) {
      return;
    }
    if (entry.kind === "Identifier") {
      considerIdentifier(entry as Identifier);
    }
    for (const [key, child] of Object.entries(entry)) {
      if (key === "kind" || key === "range" || key === "firstToken" || key === "lastToken") {
        continue;
      }
      visitTypeValue(child);
    }
  };

  const visitNode = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visitNode(item);
      }
      return;
    }
    if (!isAstNode(entry)) {
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (TYPE_ANNOTATION_KEYS.has(key)) {
        visitTypeValue(child);
        continue;
      }
      if (key === "kind" || key === "range" || key === "firstToken" || key === "lastToken") {
        continue;
      }
      visitNode(child);
    }
  };

  visitNode(value);
  return best;
}

export function findMemberExpressionAtPosition(
  program: Program,
  line: number,
  character: number
): MemberExpression | null {
  let best: { member: MemberExpression; size: number } | null = null;

  const consider = (member: MemberExpression): void => {
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }
    const propertyRange = nodeRange(member.property);
    if (!propertyRange || !containsPosition(propertyRange, { line, character })) {
      return;
    }
    const size =
      (propertyRange.end.line - propertyRange.start.line) * 100_000 +
      (propertyRange.end.character - propertyRange.start.character);
    if (!best || size <= best.size) {
      best = { member, size };
    }
  };

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "MemberExpression": {
        const member = expression as MemberExpression;
        consider(member);
        visitExpression(member.object);
        if (member.computed) {
          visitExpression(member.property);
        }
        return;
      }
      case "CallExpression":
        for (const argument of (expression as CallExpression).arguments) {
          visitExpression(argument);
        }
        visitExpression((expression as CallExpression).callee);
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression":
        visitExpression((expression as AsExpression).expression);
        return;
      case "NonNullExpression":
        visitExpression((expression as NonNullExpression).expression);
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
      case "UnaryExpression":
        visitExpression((expression as UnaryExpression).argument);
        return;
      case "UpdateExpression":
        visitExpression((expression as UpdateExpression).argument);
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
      case "ArrowFunctionExpression": {
        const body = (expression as ArrowFunctionExpression).body;
        if (body.kind === "BlockStatement") {
          for (const child of (body as BlockStatement).body) {
            visitStatement(child);
          }
        } else {
          visitExpression(body as Expr);
        }
        return;
      }
      case "FunctionExpression":
        for (const child of (expression as FunctionExpression).body.body) {
          visitStatement(child);
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement": {
        const variableStatement = statement as VarStatement;
        if (variableStatement.declarations && variableStatement.declarations.length > 0) {
          for (const declaration of variableStatement.declarations) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if (variableStatement.initializer) {
          visitExpression(variableStatement.initializer);
        }
        return;
      }
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
      case "ExportStatement":
        {
          const declaration = (statement as ExportStatement).declaration;
          if (declaration) {
            visitStatement(declaration);
          }
        }
        return;
      case "ClassStatement":
        for (const member of (statement as ClassStatement).members) {
          if (member.kind === "ClassFieldMember" && member.initializer) {
            visitExpression(member.initializer);
          } else if (member.kind === "ClassMethodMember") {
            for (const child of member.body.body) {
              visitStatement(child);
            }
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
      case "ForStatement": {
        const forStatement = statement as ForStatement;
        if (forStatement.initializer && forStatement.initializer.kind === "VarStatement") {
          visitStatement(forStatement.initializer);
        } else if (forStatement.initializer) {
          visitExpression(forStatement.initializer);
        }
        if (forStatement.iterator && forStatement.iterator.kind === "VarStatement") {
          visitStatement(forStatement.iterator);
        } else if (forStatement.iterator && forStatement.iterator.kind !== "Identifier") {
          visitExpression(forStatement.iterator);
        }
        if (forStatement.iterable) {
          visitExpression(forStatement.iterable);
        }
        if (forStatement.condition) {
          visitExpression(forStatement.condition);
        }
        if (forStatement.update) {
          visitExpression(forStatement.update);
        }
        visitStatement(forStatement.body);
        return;
      }
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

  if (!best) {
    return null;
  }
  return (best as { member: MemberExpression }).member;
}

export function findClassMemberDeclarationAtPosition(
  program: Program,
  line: number,
  character: number
): { className: string; member: ClassMemberInfo } | null {
  for (const statement of program.body) {
    if (statement.kind !== "ClassStatement") {
      continue;
    }
    const classStatement = statement as ClassStatement;
    for (const parameter of classPropertyParameters(classStatement)) {
      const member = classMemberInfoByName(classStatement, bindingNameText(parameter.name));
      if (!member || !containsPosition(member.range, { line, character })) {
        continue;
      }
      return {
        className: classStatement.name.name,
        member
      };
    }
    for (const classMember of classStatement.members) {
      const member = classMemberInfoByName(classStatement, classMember.name.name);
      if (!member || !containsPosition(member.range, { line, character })) {
        continue;
      }
      return {
        className: classStatement.name.name,
        member
      };
    }
  }

  return null;
}

export async function resolveCanonicalMemberSymbol(context: ResolveContext): Promise<CanonicalMemberSymbol | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath) {
    return null;
  }

  const declaration = findClassMemberDeclarationAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (declaration) {
    return {
      className: declaration.className,
      memberName: declaration.member.memberName,
      filePath: currentFilePath,
      range: declaration.member.range
    };
  }

  const memberExpression = findMemberExpressionAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!memberExpression || memberExpression.property.kind !== "Identifier") {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType || (objectType.kind !== "named" && objectType.kind !== "array")) {
    return null;
  }

  const resolvedClassName = objectType.kind === "array" ? "Array" : objectType.name;
  const classResolution = await resolveTypeDefinitionAcrossFiles(context, resolvedClassName);
  if (!classResolution) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const memberInfo = classMemberInfoByName(classResolution.declaration, memberName);
  if (!memberInfo) {
    return null;
  }

  return {
    className: resolvedClassName,
    memberName,
    filePath: classResolution.filePath,
    range: memberInfo.range
  };
}

export function collectMemberExpressions(program: Program): MemberExpression[] {
  const expressions: MemberExpression[] = [];

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "MemberExpression": {
        const member = expression as MemberExpression;
        expressions.push(member);
        visitExpression(member.object);
        if (member.computed) {
          visitExpression(member.property);
        }
        return;
      }
      case "CallExpression":
        visitExpression((expression as CallExpression).callee);
        for (const argument of (expression as CallExpression).arguments) {
          visitExpression(argument);
        }
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression":
        visitExpression((expression as AsExpression).expression);
        return;
      case "NonNullExpression":
        visitExpression((expression as NonNullExpression).expression);
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
      case "ArrowFunctionExpression": {
        const body = (expression as ArrowFunctionExpression).body;
        if (body.kind === "BlockStatement") {
          for (const child of (body as BlockStatement).body) {
            visitStatement(child);
          }
        } else {
          visitExpression(body as Expr);
        }
        return;
      }
      case "FunctionExpression":
        for (const child of (expression as FunctionExpression).body.body) {
          visitStatement(child);
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
          if (member.kind === "ClassFieldMember" && member.initializer) {
            visitExpression(member.initializer);
          } else if (member.kind === "ClassMethodMember") {
            for (const child of member.body.body) {
              visitStatement(child);
            }
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
        if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind !== "VarStatement") {
          visitExpression((statement as ForStatement).initializer as Expr);
        } else if ((statement as ForStatement).initializer && (statement as ForStatement).initializer!.kind === "VarStatement") {
          visitStatement((statement as ForStatement).initializer as Statement);
        }
        if ((statement as ForStatement).iterator && (statement as ForStatement).iterator!.kind !== "VarStatement" && (statement as ForStatement).iterator!.kind !== "Identifier") {
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

  return expressions;
}
