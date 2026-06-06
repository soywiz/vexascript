import { dirname, resolve } from "node:path";
import type { Analysis } from "compiler/analysis/Analysis";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { typeToString } from "compiler/analysis/types";
import {
  getEcmaScriptRuntimeDeclarationFilePath,
  isEcmaScriptRuntimeNode
} from "compiler/runtime/ecmascriptDeclarations";
import type {
  ArrayLiteral,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  Expr,
  ClassStatement,
  InterfaceStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
  ExprStatement,
  ForStatement,
  FunctionStatement,
  FunctionParameter,
  Identifier,
  IfStatement,
  LabeledStatement,
  ImportStatement,
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
import { bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import {
  findTopLevelDeclarationInProgram,
  isClassStatement,
  resolveTopLevelDeclarationAcrossFiles,
  topLevelDeclarationNames
} from "./declarationResolver";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import type { Hover, Location, WorkspaceEdit } from "vscode-languageserver/node.js";
import { pathToUri, uriToFilePath } from "./importFixes";
import {
  classPropertyParameters,
  createClassResolverCache,
  resolveClassMember
} from "./classResolver";
import {
  getProjectIndex,
  getProjectSessionForFilePath,
  scanProjectMyFiles
} from "./projectAnalysis";

interface SessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

interface ResolveContext {
  uri: string;
  line: number;
  character: number;
  session: SessionLike;
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => SessionLike | null;
}

interface CanonicalSymbol {
  name: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface CanonicalMemberSymbol {
  className: string;
  memberName: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface ClassMemberInfo {
  memberName: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  typeLabel: string;
  sourceKind: "primary-constructor" | "field" | "method";
}

function localReferencesFromContext(
  context: ResolveContext,
  includeDeclaration: boolean
): Location[] {
  if (!context.session.analysis) {
    return [];
  }
  const ranges = context.session.analysis.getReferenceRangesAt(
    context.line,
    context.character,
    includeDeclaration
  );
  return ranges.map((range) => ({
    uri: context.uri,
    range
  }));
}

function localRenameWorkspaceEdit(context: ResolveContext, newName: string): WorkspaceEdit | null {
  if (!context.session.analysis) {
    return null;
  }
  const ranges = context.session.analysis.getRenameRangesAt(
    context.line,
    context.character
  );
  if (ranges.length === 0) {
    return null;
  }
  return {
    changes: {
      [context.uri]: ranges.map((range) => ({
        range,
        newText: newName
      }))
    }
  };
}

function nodeToRange(node: { firstToken?: { range: { start: { line: number; column: number } } }; lastToken?: { range: { end: { line: number; column: number } } } }) {
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

function findImportForSymbolNode(ast: Program, symbolNode: unknown): { from: string; name: string } | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    for (const specifier of importStatement.specifiers) {
      if (specifier.imported === symbolNode || specifier.local === symbolNode) {
        return { from: importStatement.from.value, name: specifier.imported.name };
      }
    }
  }
  return null;
}

function findTopLevelDeclarationByName(ast: Program, name: string): Statement | null {
  return findTopLevelDeclarationInProgram(
    ast,
    name,
    (statement): statement is Statement => topLevelDeclarationNames(statement).includes(name)
  );
}

function declarationRangeForName(statement: Statement, name: string) {
  if (statement.kind === "VarStatement") {
    const variableStatement = statement as VarStatement;
    if (variableStatement.declarations && variableStatement.declarations.length > 0) {
      for (const declaration of variableStatement.declarations) {
        const identifier = bindingIdentifiers(declaration.name).find((item) => item.name === name);
        if (identifier) return nodeToRange(identifier);
      }
    }
    return nodeToRange(bindingIdentifiers(variableStatement.name).find((item) => item.name === name) ?? variableStatement.name);
  }
  if (statement.kind === "ClassStatement") {
    return nodeToRange((statement as ClassStatement).name);
  }
  if (statement.kind === "InterfaceStatement") {
    return nodeToRange((statement as InterfaceStatement).name);
  }
  if (statement.kind === "FunctionStatement") {
    return nodeToRange((statement as FunctionStatement).name);
  }
  return nodeToRange(statement);
}

function getSessionForFilePath(filePath: string, context: ResolveContext): SessionLike | null {
  return getProjectSessionForFilePath(filePath, {
    sourceRoots: context.sourceRoots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });
}

/**
 * Whether `declaration` introduces `symbolNode` as its declared name. The
 * analysis stores the declaration's name identifier (not the statement) as a
 * symbol node, so matching is done against the declaration's name node(s).
 */
function declarationDeclaresNode(declaration: Statement, symbolNode: unknown): boolean {
  if (declaration === symbolNode) {
    return true;
  }
  const named = declaration as { name?: unknown };
  if (named.name === symbolNode) {
    return true;
  }
  if (declaration.kind === "VarStatement") {
    const variableStatement = declaration as VarStatement;
    const names = [
      ...bindingIdentifiers(variableStatement.name),
      ...(variableStatement.declarations ?? []).flatMap((item) => bindingIdentifiers(item.name))
    ];
    return names.some((identifier) => identifier === symbolNode);
  }
  return false;
}

/**
 * Finds the imported file that owns `symbolNode` and returns a canonical symbol
 * pointing at the declaration there. Used when a symbol resolved through an
 * external declaration (e.g. a cross-file operator overload) carries a node that
 * lives in an imported file rather than the current document. Declarations are
 * matched by node identity because the analysis registers the very same AST
 * nodes parsed from the imported file as external declarations.
 */
function resolveExternalDeclarationLocation(
  context: ResolveContext,
  currentFilePath: string,
  symbolNode: unknown,
  symbolName: string
): CanonicalSymbol | null {
  const ast = context.session.ast;
  if (!ast) {
    return null;
  }
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const targetFilePath = resolveImportTargetFilePath(currentFilePath, (statement as ImportStatement).from.value);
    if (!targetFilePath) {
      continue;
    }
    const targetSession = getSessionForFilePath(targetFilePath, context);
    if (!targetSession?.ast) {
      continue;
    }
    for (const targetStatement of targetSession.ast.body) {
      const declaration = unwrapExportedDeclaration(targetStatement);
      if (declaration && declarationDeclaresNode(declaration, symbolNode)) {
        const range = declarationRangeForName(declaration, symbolName);
        if (!range) {
          continue;
        }
        return {
          name: symbolName,
          filePath: targetFilePath,
          range
        };
      }
    }
  }
  return null;
}

function resolveCanonicalSymbol(context: ResolveContext): CanonicalSymbol | null {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.analysis || !context.session.ast) {
    return null;
  }

  const definition = context.session.analysis.getDefinitionAt(context.line, context.character);
  const symbolAt =
    context.session.analysis.getSymbolAt(context.line, context.character) ??
    context.session.analysis.getOperatorSymbolAt(context.line, context.character);
  if (!definition || !symbolAt) {
    return null;
  }

  const importBinding = findImportForSymbolNode(context.session.ast, symbolAt.symbol.node);
  if (!importBinding) {
    if (isEcmaScriptRuntimeNode(symbolAt.symbol.node)) {
      return {
        name: symbolAt.symbol.name,
        filePath: getEcmaScriptRuntimeDeclarationFilePath(),
        range: definition.range
      };
    }
    // Symbols resolved through external (imported) declarations - e.g. a
    // cross-file operator overload reached from a `a + b` usage - carry a node
    // that belongs to the imported file, not the current document. Locate the
    // owning file so navigation lands there instead of the current file.
    const externalLocation = resolveExternalDeclarationLocation(
      context,
      currentFilePath,
      symbolAt.symbol.node,
      symbolAt.symbol.name
    );
    if (externalLocation) {
      return externalLocation;
    }
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const targetFilePath = resolveImportTargetFilePath(currentFilePath, importBinding.from);
  if (!targetFilePath) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const targetSession = getSessionForFilePath(targetFilePath, context);
  if (!targetSession?.ast) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  const projectIndex = getProjectIndex(context.sourceRoots);
  const indexedDeclaration = projectIndex.findTopLevelDeclaration(targetFilePath, importBinding.name);
  const targetRange = indexedDeclaration?.range ?? null;
  if (!targetRange) {
    return {
      name: symbolAt.symbol.name,
      filePath: currentFilePath,
      range: definition.range
    };
  }

  return {
    name: importBinding.name,
    filePath: targetFilePath,
    range: targetRange
  };
}

function rangesEqual(
  a: { start: { line: number; character: number }; end: { line: number; character: number } },
  b: { start: { line: number; character: number }; end: { line: number; character: number } }
): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function findMatchingImportSpecifierPositions(
  importerAst: Program,
  importerFilePath: string,
  symbol: CanonicalSymbol
): Array<{ line: number; character: number }> {
  const positions: Array<{ line: number; character: number }> = [];
  for (const statement of importerAst.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetFilePath = resolveImportTargetFilePath(importerFilePath, importStatement.from.value);
    if (!targetFilePath || resolve(targetFilePath) !== resolve(symbol.filePath)) {
      continue;
    }
    for (const specifier of importStatement.specifiers) {
      if (specifier.imported.name !== symbol.name || !specifier.imported.firstToken) {
        continue;
      }
      positions.push({
        line: specifier.imported.firstToken.range.start.line,
        character: specifier.imported.firstToken.range.start.column
      });
    }
  }
  return positions;
}

function rangeContainsPosition(
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  line: number,
  character: number
): boolean {
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.character) {
    return false;
  }
  if (line === range.end.line && character > range.end.character) {
    return false;
  }
  return true;
}

function classMemberDeclarationRangeByName(
  classStatement: ClassStatement,
  memberName: string
): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) !== memberName) {
      continue;
    }
    const range = nodeToRange(parameter.name);
    if (range) {
      return range;
    }
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    const range = nodeToRange(member.name);
    if (range) {
      return range;
    }
  }

  return null;
}

function functionTypeLabelFromParameters(
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

function classMemberInfoByName(
  classStatement: ClassStatement,
  memberName: string
): ClassMemberInfo | null {
  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) !== memberName) {
      continue;
    }
    const range = nodeToRange(parameter.name);
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
    const range = nodeToRange(member.name);
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

function resolveClassDefinitionAcrossFiles(
  context: ResolveContext,
  className: string
): { classStatement: ClassStatement; filePath: string } | null {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(currentFilePath)];
  const resolved = resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: className,
    currentFilePath,
    predicate: isClassStatement,
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
    classStatement: resolved.declaration,
    filePath: resolved.filePath === "" ? getEcmaScriptRuntimeDeclarationFilePath() : resolved.filePath
  };
}

function findMemberExpressionAtPosition(
  program: Program,
  line: number,
  character: number
): MemberExpression | null {
  let best: { member: MemberExpression; size: number } | null = null;

  const consider = (member: MemberExpression): void => {
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }
    const propertyRange = nodeToRange(member.property);
    if (!propertyRange || !rangeContainsPosition(propertyRange, line, character)) {
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

function resolveMemberDefinitionAcrossFiles(context: ResolveContext): Location | null {
  if (!context.session.ast || !context.session.analysis) {
    return null;
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
  const classResolution = resolveClassDefinitionAcrossFiles(context, resolvedClassName);
  if (!classResolution) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const range = classMemberDeclarationRangeByName(classResolution.classStatement, memberName);
  if (!range) {
    return null;
  }

  return {
    uri: pathToUri(classResolution.filePath),
    range
  };
}

function findClassMemberDeclarationAtPosition(
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
      if (!member || !rangeContainsPosition(member.range, line, character)) {
        continue;
      }
      return {
        className: classStatement.name.name,
        member
      };
    }
    for (const classMember of classStatement.members) {
      const member = classMemberInfoByName(classStatement, classMember.name.name);
      if (!member || !rangeContainsPosition(member.range, line, character)) {
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

function resolveCanonicalMemberSymbol(context: ResolveContext): CanonicalMemberSymbol | null {
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
  const classResolution = resolveClassDefinitionAcrossFiles(context, resolvedClassName);
  if (!classResolution) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const memberInfo = classMemberInfoByName(classResolution.classStatement, memberName);
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

function collectMemberExpressions(program: Program): MemberExpression[] {
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

function resolveMemberReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Location[] {
  const memberSymbol = resolveCanonicalMemberSymbol(context);
  if (!memberSymbol) {
    return [];
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(memberSymbol.filePath)];
  const files = scanProjectMyFiles(roots);
  const locations: Location[] = [];
  const seen = new Set<string>();

  const addLocation = (uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    locations.push({ uri, range });
  };

  if (includeDeclaration) {
    addLocation(pathToUri(memberSymbol.filePath), memberSymbol.range);
  }

  for (const filePath of files) {
    const session = getSessionForFilePath(filePath, context);
    if (!session?.ast || !session.analysis) {
      continue;
    }

    const expressionTypes = session.analysis.getExpressionTypes();
    for (const member of collectMemberExpressions(session.ast)) {
      if (member.computed || member.property.kind !== "Identifier") {
        continue;
      }
      const memberName = (member.property as Identifier).name;
      if (memberName !== memberSymbol.memberName) {
        continue;
      }
      const objectType = expressionTypes.get(member.object);
      if (!objectType || (objectType.kind !== "named" && objectType.kind !== "array")) {
        continue;
      }
      const objectClassName = objectType.kind === "array" ? "Array" : objectType.name;
      if (objectClassName !== memberSymbol.className) {
        continue;
      }
      const range = nodeToRange(member.property);
      if (!range) {
        continue;
      }
      addLocation(pathToUri(filePath), range);
    }
  }

  return locations;
}

export function resolveDefinitionAcrossFiles(context: ResolveContext): Location | null {
  const memberDefinition = resolveMemberDefinitionAcrossFiles(context);
  if (memberDefinition) {
    return memberDefinition;
  }

  const symbol = resolveCanonicalSymbol(context);
  if (symbol) {
    return {
      uri: pathToUri(symbol.filePath),
      range: symbol.range
    };
  }
  return null;
}

function createMemberHoverContents(
  className: string,
  member: ClassMemberInfo
): string {
  const prefix = member.sourceKind === "method" ? "method" : "member";
  return `${prefix} ${className}.${member.memberName}: ${member.typeLabel}`;
}

export function resolveMemberHoverAcrossFiles(context: ResolveContext): Hover | null {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }

  const declaration = findClassMemberDeclarationAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (declaration) {
    return {
      contents: {
        kind: "plaintext",
        value: createMemberHoverContents(declaration.className, declaration.member)
      },
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
  const classResolution = resolveClassDefinitionAcrossFiles(context, resolvedClassName);
  if (!classResolution) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const resolvedMember = resolveClassMember(
    classResolution.classStatement,
    memberName,
    objectType.kind === "array" ? `Array<${typeToString(objectType.elementType)}>` : typeToString(objectType),
    {
      ast: context.session.ast,
      options: {
        uri: context.uri,
        sourceRoots: context.sourceRoots,
        ...(context.getSessionForFilePath
          ? { getSessionForFilePath: context.getSessionForFilePath }
          : {})
      },
      cache: createClassResolverCache()
    }
  );
  if (!resolvedMember) {
    return null;
  }
  const prefix = resolvedMember.kind === "method" ? "method" : "member";

  const memberRange = nodeToRange(memberExpression.property) ?? nodeToRange(memberExpression);
  return {
    contents: {
      kind: "plaintext",
      value: `${prefix} ${typeToString(objectType)}.${memberName}: ${resolvedMember.typeName}`
    },
    ...(memberRange ? { range: memberRange } : {})
  };
}

export function resolveReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Location[] {
  const memberLocations = resolveMemberReferencesAcrossFiles(context, includeDeclaration);
  if (memberLocations.length > 0) {
    return memberLocations;
  }

  const localFallbackReferences = localReferencesFromContext(context, includeDeclaration);
  const symbol = resolveCanonicalSymbol(context);
  if (!symbol) {
    return localFallbackReferences;
  }

  const roots = context.sourceRoots.length > 0 ? context.sourceRoots : [dirname(symbol.filePath)];
  const projectIndex = getProjectIndex(roots);
  const files = scanProjectMyFiles(roots);
  const locations: Location[] = [];
  const seen = new Set<string>();

  const addLocation = (uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
    const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    locations.push({ uri, range });
  };

  const importerByPath = new Map<string, Array<{ line: number; character: number }>>();
  for (const importer of projectIndex.findFilesImportingSymbol(symbol.filePath, symbol.name)) {
    const existing = importerByPath.get(importer.importerFilePath);
    if (existing) {
      existing.push(importer.importRange.start);
    } else {
      importerByPath.set(importer.importerFilePath, [importer.importRange.start]);
    }
  }

  for (const filePath of files) {
    const session = getSessionForFilePath(filePath, context);
    if (!session?.ast || !session.analysis) {
      continue;
    }
    const uri = pathToUri(filePath);

    if (resolve(filePath) === resolve(symbol.filePath)) {
      const declaration = findTopLevelDeclarationByName(session.ast, symbol.name);
      const declarationRange = declaration ? declarationRangeForName(declaration, symbol.name) : null;
      if (!declarationRange) {
        for (const location of localFallbackReferences) {
          addLocation(location.uri, location.range);
        }
        continue;
      }

      const references = session.analysis.getReferenceRangesAt(
        declarationRange.start.line,
        declarationRange.start.character,
        includeDeclaration
      );
      for (const range of references) {
        addLocation(uri, range);
      }
      continue;
    }

    const importPositions =
      importerByPath.get(filePath) ??
      findMatchingImportSpecifierPositions(session.ast, filePath, symbol);
    for (const position of importPositions) {
      const references = session.analysis.getReferenceRangesAt(
        position.line,
        position.character,
        includeDeclaration
      );
      for (const range of references) {
        addLocation(uri, range);
      }
    }
  }

  if (!includeDeclaration) {
    return locations.filter((location) => !(
      location.uri === pathToUri(symbol.filePath) && rangesEqual(location.range, symbol.range)
    ));
  }

  return locations;
}

export function resolveRenameAcrossFiles(
  context: ResolveContext,
  newName: string
): WorkspaceEdit | null {
  const locations = resolveReferencesAcrossFiles(context, true);
  if (locations.length === 0) {
    return localRenameWorkspaceEdit(context, newName);
  }

  const changes: Record<string, Array<{ range: Location["range"]; newText: string }>> = {};
  for (const location of locations) {
    if (!changes[location.uri]) {
      changes[location.uri] = [];
    }
    changes[location.uri]?.push({
      range: location.range,
      newText: newName
    });
  }

  if (Object.keys(changes).length === 0) {
    return localRenameWorkspaceEdit(context, newName);
  }
  return { changes };
}
