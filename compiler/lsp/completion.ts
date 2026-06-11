import type { CompletionItem } from "vscode-languageserver/node.js";
import type { Vfs } from "compiler/vfs";
import type {
  ArrayLiteral,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassMember,
  ClassMethodMember,
  ClassStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
  Expr,
  ExportStatement,
  ForStatement,
  FunctionStatement,
  IfStatement,
  Identifier,
  ImportStatement,
  InterfaceStatement,
  InterfaceMethodMember,
  LabeledStatement,
  MemberExpression,
  NewExpression,
  NonNullExpression,
  NamespaceStatement,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  TypeAnnotation,
  TypeAliasStatement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import { unwrapExportedDeclaration, walkAst } from "compiler/ast/traversal";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/Analysis";
import type { AnalysisType } from "compiler/analysis/types";
import {
  baseTypeName,
  findMatchingTypeDelimiter,
  findTopLevelTypeCharacter,
  parseTypeNameShape,
  splitTopLevelDelimitedTypeText,
  splitTopLevelTypeText,
  stripEnclosingTypeParens,
  substituteTypeNameText
} from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import { compileSource } from "compiler/pipeline/compile";
import { resolveImportTargetFilePath } from "compiler/moduleResolution";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { readDocumentationFromProgramDeclaration } from "./documentation";
import {
  buildAutoImportSuggestions,
  buildExtensionAutoImportSuggestions,
  type AutoImportSuggestion,
  type SymbolExportProvider,
} from "./importFixes";
import {
  createClassResolverCache,
  resolveCallableSignature,
  resolveClassMember,
  resolveClassMemberNames,
  resolveInterfaceStatementAcrossFiles,
  resolveInterfaceMember,
  resolveInterfaceMemberNames,
  resolveClassStatementAcrossFiles,
  resolveConstructorSignature,
  type ClassResolverCache,
  type ClassResolverOptions
} from "./classResolver";
import { comparePosition, containsPosition, nodeRange, rangeSize } from "./ranges";
import { getNodeModuleTypings } from "./nodeModulesTypings";
import { fileURLToPath } from "compiler/utils/path";

const CompletionItemKind = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Interface: 8,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Color: 16,
  File: 17,
  Reference: 18,
  Folder: 19,
  EnumMember: 20,
  Constant: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

type CompletionItemKind = (typeof CompletionItemKind)[keyof typeof CompletionItemKind];
type InterfaceCompletionMember = {
  name: string;
  detail: string;
  kind: typeof CompletionItemKind.Field | typeof CompletionItemKind.Method;
};

type TypeAliasCompletionMember = {
  name: string;
  detail: string;
  kind: typeof CompletionItemKind.Field | typeof CompletionItemKind.Method;
};

const KEYWORD_COMPLETIONS: CompletionItem[] = [
  { label: "fn", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "type", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "interface", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "enum", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "namespace", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "module", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "declare", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "debugger", kind: CompletionItemKind.Keyword, detail: "Keyword" },
  { label: "int", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "number", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "numeric", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "bigint", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "long", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "string", kind: CompletionItemKind.Keyword, detail: "Builtin type" },
  { label: "boolean", kind: CompletionItemKind.Keyword, detail: "Builtin type" }
];

function symbolKindToCompletionKind(symbol: AnalysisSymbol): CompletionItemKind {
  if (symbol.kind === "function" || symbol.kind === "method") {
    return CompletionItemKind.Function;
  }
  if (symbol.kind === "class") {
    return CompletionItemKind.Class;
  }
  return CompletionItemKind.Variable;
}

function symbolDetail(symbol: AnalysisSymbol): string {
  if (symbol.valueType) {
    return `In-scope ${symbol.kind}: ${symbol.valueType}`;
  }
  return `In-scope ${symbol.kind}`;
}

interface CompletionSessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

export interface CompletionRequestOptions {
  text?: string;
  uri?: string;
  sourceRoots?: string[];
  ambientDeclarations?: Statement[];
  vfs?: Vfs;
  getSessionForFilePath?: (filePath: string) => CompletionSessionLike | null | Promise<CompletionSessionLike | null>;
  getExportedSymbols?: SymbolExportProvider;
  recoverAnalysisSession?: (source: string) => CompletionSessionLike | Promise<CompletionSessionLike>;
}

interface MemberAccessTarget {
  objectPath: string;
  objectStartCharacter: number;
  memberAccessStartCharacter: number;
  prefix: string;
}

interface ExtensionMemberCompletionCandidate {
  name: string;
  receiverType: string;
  kind: "property" | "method";
  returnTypeName?: string | null;
}

const COMPLETION_RECOVERY_MEMBER = "__vexa_completion__";
const CompletionItemInsertTextFormat = {
  PlainText: 1,
  Snippet: 2,
} as const;
const CompletionCommand = {
  TriggerParameterHints: "editor.action.triggerParameterHints",
} as const;

function isCallableCompletionLabel(label: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(label);
}

function withCallSnippet(item: CompletionItem): CompletionItem {
  if (item.insertText) {
    return item;
  }
  if (item.kind !== CompletionItemKind.Method && item.kind !== CompletionItemKind.Function) {
    return item;
  }
  if (!isCallableCompletionLabel(item.label)) {
    return item;
  }
  return {
    ...item,
    insertText: `${item.label}($1)`,
    insertTextFormat: CompletionItemInsertTextFormat.Snippet,
    command: {
      title: "Trigger parameter hints",
      command: CompletionCommand.TriggerParameterHints,
    },
  };
}

function operatorSymbolFromMemberName(name: string): string | null {
  return name.startsWith("operator") ? name.slice("operator".length) || null : null;
}

function constructorParameterProperties(classStatement: ClassStatement) {
  return classStatement.members
    .filter((member) => member.kind === "ClassMethodMember" && member.name.name === "constructor")
    .flatMap((member) => member.kind === "ClassMethodMember" ? member.parameters : [])
    .filter((parameter) => parameter.accessModifier !== undefined || parameter.readonly === true);
}

function classPropertyParameters(classStatement: ClassStatement) {
  return [...(classStatement.primaryConstructorParameters ?? []), ...constructorParameterProperties(classStatement)];
}

function memberSortGroup(memberName: string, classStatement: ClassStatement, membersByName: Map<string, ClassMember>): string {
  if (classPropertyParameters(classStatement).some((parameter) => parameter.name.kind === "Identifier" && parameter.name.name === memberName)) {
    return "0";
  }
  const member = membersByName.get(memberName);
  if (member?.kind === "ClassFieldMember") {
    return "1";
  }
  return "2";
}

function parseMemberAccessTarget(
  text: string | undefined,
  line: number,
  character: number
): MemberAccessTarget | null {
  if (!text) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (!lineText) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);
  const match = /((?:[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)(?:(?:\s*\?\.\s*|\s*!\.\s*|\s*\.\s*)[A-Za-z_][A-Za-z0-9_]*)*)(\?\.|!\.|\.)(?:\s*([A-Za-z_][A-Za-z0-9_]*))?$/.exec(uptoCursor);
  if (!match || !match[1]) {
    return null;
  }
  const objectPath = match[1];
  const typedPrefix = match[3] ?? "";
  const objectStartCharacter = match.index;
  const operator = match[2] ?? ".";
  const memberAccessStartCharacter = match.index + objectPath.length + operator.length - 1;
  return {
    objectPath: objectPath.replace(/\?\./g, ".").replace(/!\./g, ".").replace(/\s+/g, ""),
    objectStartCharacter,
    memberAccessStartCharacter,
    prefix: typedPrefix
  };
}

/**
 * Lenient member-access detection that, unlike {@link parseMemberAccessTarget},
 * does not require the receiver to be a plain identifier-dot chain. It only
 * locates the member-access dot and the partially typed member name, so the
 * receiver type can be resolved from the analyzed expression types instead of
 * from textual symbol lookups. This is what enables member completion after
 * complex receivers such as calls (e.g. `fetch(...).arrayBuffer`).
 */
function findMemberAccessDot(
  text: string | undefined,
  line: number,
  character: number
): { dotCharacter: number; receiverEndCharacter: number; prefix: string } | null {
  if (!text) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (lineText === undefined) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);
  const match = /(\?\.|!\.|\.)(?:\s*([A-Za-z_][A-Za-z0-9_]*))?$/.exec(uptoCursor);
  if (!match) {
    return null;
  }
  const operator = match[1] ?? ".";
  const dotCharacter = match.index + operator.length - 1;
  // The receiver must end with a value-producing token so that we are looking at
  // a member access rather than, for example, a decimal point in a number.
  // A trailing-lambda call receiver ends at its closing brace (`xs.map { it }.`),
  // so `}` must be accepted here too.
  const beforeDot = uptoCursor.slice(0, match.index).replace(/\s+$/, "");
  const lastChar = beforeDot[beforeDot.length - 1];
  if (!lastChar || !/[A-Za-z0-9_)\]"'`}!]/.test(lastChar)) {
    return null;
  }
  return { dotCharacter, receiverEndCharacter: beforeDot.length, prefix: match[2] ?? "" };
}

function inferLiteralTypeName(pathSegment: string): string | null {
  if (/^\d+$/.test(pathSegment)) {
    return "int";
  }
  if (/^\d+\.\d+$/.test(pathSegment)) {
    return "number";
  }
  return null;
}

function nonNullishTypeName(typeName: string | null): string | null {
  if (!typeName) {
    return null;
  }
  const parts = splitTopLevelTypeText(stripEnclosingTypeParens(typeName), "|")
    .map((part) => stripEnclosingTypeParens(part).trim())
    .filter((part) => part.length > 0 && part !== "null" && part !== "undefined");
  if (parts.length === 0) {
    return null;
  }
  return parts[0] ?? null;
}

function normalizeRecoveredReceiverType(
  type: AnalysisType,
  node: Expr,
  expressionTypes: ReadonlyMap<import("compiler/ast/ast").Node, AnalysisType>
): string {
  if (type.kind === "union") {
    return type.types.map((member) => normalizeRecoveredReceiverType(member, node, expressionTypes)).join(" | ");
  }
  if (type.kind === "named" && node.kind === "CallExpression") {
    const calleeType = expressionTypes.get((node as CallExpression).callee);
    if (calleeType?.kind === "function" && calleeType.typeParameterConstraints?.[type.name]) {
      return typeToString(calleeType.typeParameterConstraints[type.name]!);
    }
  }
  return typeToString(type);
}

function receiverTypeNameEndingAt(
  analysis: Analysis,
  line: number,
  character: number
): string | null {
  let best: { node: Expr; type: AnalysisType; size: number } | null = null;
  let nearest: { node: Expr; type: AnalysisType; size: number; distance: number } | null = null;
  for (const [node, type] of analysis.getExpressionTypes()) {
    const range = nodeRange(node);
    if (!range || range.end.line !== line) {
      continue;
    }
    const size = rangeSize(range);
    if (range.end.character === character) {
      if (!best || size > best.size) {
        best = { node: node as Expr, type, size };
      }
      continue;
    }
    if (range.end.character > character) {
      continue;
    }
    const distance = character - range.end.character;
    if (distance > 2) {
      continue;
    }
    if (
      !nearest ||
      distance < nearest.distance ||
      (distance === nearest.distance && size > nearest.size)
    ) {
      nearest = { node: node as Expr, type, size, distance };
    }
  }
  const resolved = best ?? nearest;
  return resolved ? normalizeRecoveredReceiverType(resolved.type, resolved.node, analysis.getExpressionTypes()) : null;
}

function recoveredReceiverTypeName(
  ast: Program,
  analysis: Analysis
): string | null {
  let recovered: { node: Expr; type: AnalysisType; size: number } | undefined;

  walkAst(ast, (node) => {
    if (node.kind !== "MemberExpression") {
      return;
    }
    const member = node as MemberExpression;
    if (
      member.computed ||
      member.property.kind !== "Identifier" ||
      !(member.property as Identifier).name.includes(COMPLETION_RECOVERY_MEMBER)
    ) {
      return;
    }
    const objectType = analysis.getExpressionTypes().get(member.object);
    if (!objectType) {
      return;
    }
    const range = nodeRange(member.object);
    const size = range ? rangeSize(range) : 0;
    if (!recovered || size >= recovered.size) {
      recovered = { node: member.object as Expr, type: objectType, size };
    }
  });

  if (recovered === undefined) {
    return null;
  }
  return normalizeRecoveredReceiverType(recovered.type, recovered.node, analysis.getExpressionTypes());
}

function identifierPrefixAtPosition(
  text: string | undefined,
  line: number,
  character: number
): string {
  if (!text) {
    return "";
  }
  const lineText = text.split("\n")[line] ?? "";
  const uptoCursor = lineText.slice(0, Math.max(0, Math.min(character, lineText.length)));
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(uptoCursor);
  return match?.[0] ?? "";
}

function declarationNameRangeContainsPosition(identifier: Identifier, line: number, character: number): boolean {
  const range = nodeRange(identifier);
  return !!range && containsPosition(range, { line, character });
}

function isTextualDeclarationNamePosition(
  text: string | undefined,
  line: number,
  character: number
): boolean {
  if (!text) {
    return false;
  }

  const lineText = text.split("\n")[line] ?? "";
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);

  return [
    /^\s*fun\s+[A-Za-z_][A-Za-z0-9_]*$/u,
    /^\s*(?:let|val|var|const)\s+[A-Za-z_][A-Za-z0-9_]*$/u,
    /^\s*(?:class|interface|namespace)\s+[A-Za-z_][A-Za-z0-9_]*$/u,
  ].some((pattern) => pattern.test(uptoCursor));
}

function isDeclarationNamePosition(ast: Program, line: number, character: number): boolean {
  const matchesBinding = (identifier: Identifier): boolean =>
    declarationNameRangeContainsPosition(identifier, line, character);

  for (const statement of ast.body) {
    if (statement.kind === "FunctionStatement") {
      const fn = statement as FunctionStatement;
      if (matchesBinding(fn.name)) {
        return true;
      }
      for (const parameter of fn.parameters) {
        for (const binding of bindingIdentifiers(parameter.name)) {
          if (matchesBinding(binding)) {
            return true;
          }
        }
      }
      continue;
    }

    if (statement.kind === "VarStatement") {
      const variable = statement as VarStatement;
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      if (bindings.some(matchesBinding)) {
        return true;
      }
      continue;
    }

    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      if (matchesBinding(classStatement.name)) {
        return true;
      }
      for (const parameter of classStatement.primaryConstructorParameters ?? []) {
        for (const binding of bindingIdentifiers(parameter.name)) {
          if (matchesBinding(binding)) {
            return true;
          }
        }
      }
      for (const member of classStatement.members) {
        if (matchesBinding(member.name)) {
          return true;
        }
        if (member.kind === "ClassMethodMember") {
          const method = member as ClassMethodMember;
          for (const parameter of method.parameters) {
            for (const binding of bindingIdentifiers(parameter.name)) {
              if (matchesBinding(binding)) {
                return true;
              }
            }
          }
        }
      }
      continue;
    }

    if (statement.kind === "InterfaceStatement") {
      const interfaceStatement = statement as InterfaceStatement;
      if (matchesBinding(interfaceStatement.name)) {
        return true;
      }
      for (const member of interfaceStatement.members) {
        if (matchesBinding(member.name)) {
          return true;
        }
        if (member.kind === "InterfaceMethodMember") {
          const method = member as InterfaceMethodMember;
          for (const parameter of method.parameters) {
            for (const binding of bindingIdentifiers(parameter.name)) {
              if (matchesBinding(binding)) {
                return true;
              }
            }
          }
        }
      }
      continue;
    }

    if (statement.kind === "NamespaceStatement") {
      const namespaceStatement = statement as NamespaceStatement;
      if ((namespaceStatement.names ?? []).some((name) => matchesBinding(name))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Maps an array type name such as `int[]` to its `Array<int>` alias so member
 * completion resolves against the declared `class Array<T>`. Nested arrays peel
 * a single dimension (`int[][]` -> `Array<int[]>`). Returns `null` when the
 * type is not an array.
 */
function arrayTypeNameToArrayAlias(typeName: string): string | null {
  const shape = parseTypeNameShape(typeName);
  if (shape.arrayDepth <= 0) {
    return null;
  }
  let elementType =
    shape.typeArguments.length > 0
      ? `${shape.baseName}<${shape.typeArguments.join(", ")}>`
      : shape.baseName;
  for (let depth = 0; depth < shape.arrayDepth - 1; depth += 1) {
    elementType += "[]";
  }
  return `Array<${elementType}>`;
}

function boxedCompletionTypeName(typeName: string): string {
  const normalizedTypeName = nonNullishTypeName(typeName) ?? typeName;
  if (normalizedTypeName === "int" || normalizedTypeName === "number" || normalizedTypeName === "numeric") {
    return "Number";
  }
  if (normalizedTypeName === "string") {
    return "String";
  }
  if (normalizedTypeName === "boolean") {
    return "Boolean";
  }
  if (normalizedTypeName === "bigint" || normalizedTypeName === "long") {
    return "BigInt";
  }
  return normalizedTypeName;
}

function extensionReceiverMatches(receiverType: string, objectTypeName: string): boolean {
  // Array-shaped types (`int[]`, `Array<int>`) resolve their extension members
  // against the `Array` receiver, so `[].extensionMember` and `someArray.method()`
  // surface generic `Array<T>` extensions.
  const shape = parseTypeNameShape(objectTypeName);
  if (shape.arrayDepth > 0 && receiverType === "Array") {
    return true;
  }
  const normalized = shape.baseName;
  return receiverType === normalized || (normalized === "int" && receiverType === "number");
}

function inferExtensionReturnTypeName(
  statement: Statement,
  analysis: Analysis | null
): string | null {
  if (statement.kind === "VarStatement") {
    const variable = statement as VarStatement;
    if (variable.typeAnnotation?.name) {
      return variable.typeAnnotation.name;
    }
    if (variable.initializer && analysis) {
      const initializerType = analysis.getExpressionTypes().get(variable.initializer);
      const typeName = initializerType ? typeToString(initializerType) : null;
      if (typeName && typeName !== "unknown") {
        return typeName;
      }
    }
    const initializer = variable.initializer;
    if (initializer?.kind === "CallExpression") {
      const call = initializer as CallExpression;
      if (call.callee.kind === "Identifier") {
        return (call.callee as Identifier).name;
      }
    }
    if (initializer?.kind === "NewExpression") {
      const newExpression = initializer as NewExpression;
      if (newExpression.callee.kind === "Identifier") {
        return (newExpression.callee as Identifier).name;
      }
    }
    return null;
  }
  if (statement.kind === "FunctionStatement") {
    return (statement as FunctionStatement).returnType?.name ?? null;
  }
  return null;
}

async function collectAvailableExtensionMembers(
  ast: Program,
  objectTypeName: string,
  options: CompletionRequestOptions,
  analysis: Analysis | null = null
): Promise<ExtensionMemberCompletionCandidate[]> {
  const currentFilePath = options.uri?.startsWith("file://")
    ? fileURLToPath(options.uri)
    : null;
  const importedNames = new Set<string>();
  const candidates: ExtensionMemberCompletionCandidate[] = [];
  const seen = new Set<string>();

  const maybePushStatement = (statement: Statement): void => {
    const candidate = statement.kind === "ExportStatement"
      ? (statement as ExportStatement).declaration
      : statement;
    if (!candidate) {
      return;
    }
    if (candidate.kind === "VarStatement") {
      const variable = candidate as VarStatement;
      const receiverType = variable.receiverType?.name;
      if (!receiverType || !extensionReceiverMatches(receiverType, objectTypeName)) {
        return;
      }
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      for (const binding of bindings) {
        if (seen.has(`property:${binding.name}`)) {
          continue;
        }
        seen.add(`property:${binding.name}`);
        candidates.push({
          name: binding.name,
          receiverType,
          kind: "property",
          returnTypeName: inferExtensionReturnTypeName(variable, analysis)
        });
      }
      return;
    }
    if (candidate.kind === "FunctionStatement") {
      const fn = candidate as FunctionStatement;
      const receiverType = fn.receiverType?.name;
      if (!receiverType || fn.operator || !extensionReceiverMatches(receiverType, objectTypeName)) {
        return;
      }
      if (seen.has(`method:${fn.name.name}`)) {
        return;
      }
      seen.add(`method:${fn.name.name}`);
      candidates.push({
        name: fn.name.name,
        receiverType,
        kind: "method",
        returnTypeName: inferExtensionReturnTypeName(fn, analysis)
      });
    }
  };

  for (const statement of ast.body) {
    maybePushStatement(statement);
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    for (const specifier of importStatement.specifiers) {
      importedNames.add((specifier.local ?? specifier.imported).name);
    }
  }

  if (!currentFilePath || !options.getSessionForFilePath) {
    return candidates;
  }

  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as ImportStatement;
    const targetFilePath = await resolveImportTargetFilePath(currentFilePath, importStatement.from.value, {
      ...(options.vfs ? { vfs: options.vfs } : {}),
      getSessionForFilePath: options.getSessionForFilePath
    });
    if (!targetFilePath) {
      continue;
    }
    const importedSession = await options.getSessionForFilePath(targetFilePath);
    const importedAst = importedSession?.ast;
    const importedAnalysis = importedSession?.analysis ?? null;
    if (!importedAst) {
      continue;
    }
    for (const importedStatement of importedAst.body) {
      const unwrapped = importedStatement.kind === "ExportStatement"
        ? (importedStatement as ExportStatement).declaration
        : importedStatement;
      if (!unwrapped) {
        continue;
      }
      if (unwrapped.kind === "VarStatement") {
        const variable = unwrapped as VarStatement;
        const receiverType = variable.receiverType?.name;
        if (!receiverType || !extensionReceiverMatches(receiverType, objectTypeName)) {
          continue;
        }
        const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
        for (const binding of bindings) {
          if (!importedNames.has(binding.name) || seen.has(`property:${binding.name}`)) {
            continue;
          }
          seen.add(`property:${binding.name}`);
          candidates.push({
            name: binding.name,
            receiverType,
            kind: "property",
            returnTypeName: inferExtensionReturnTypeName(variable, importedAnalysis)
          });
        }
        continue;
      }
      if (unwrapped.kind === "FunctionStatement") {
        const fn = unwrapped as FunctionStatement;
        const receiverType = fn.receiverType?.name;
        if (!receiverType || fn.operator || !extensionReceiverMatches(receiverType, objectTypeName)) {
          continue;
        }
        if (!importedNames.has(fn.name.name) || seen.has(`method:${fn.name.name}`)) {
          continue;
        }
        seen.add(`method:${fn.name.name}`);
        candidates.push({
          name: fn.name.name,
          receiverType,
          kind: "method",
          returnTypeName: inferExtensionReturnTypeName(fn, importedAnalysis)
        });
      }
    }
  }

  return candidates;
}

async function resolveExtensionMemberTypeName(
  ast: Program,
  objectTypeName: string,
  memberName: string,
  options: CompletionRequestOptions,
  analysis?: Analysis | null
): Promise<string | null> {
  const candidate = (await collectAvailableExtensionMembers(ast, objectTypeName, options, analysis))
    .find((item) => item.name === memberName);
  return candidate?.returnTypeName ?? null;
}

async function buildExtensionMemberCompletionItems(
  ast: Program,
  objectTypeName: string,
  prefix: string,
  options: CompletionRequestOptions,
  analysis?: Analysis | null
): Promise<CompletionItem[]> {
  const normalizedPrefix = prefix.trim();
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  const pushItem = (item: CompletionItem): void => {
    if (normalizedPrefix.length > 0 && !item.label.startsWith(normalizedPrefix)) {
      return;
    }
    if (seen.has(item.label)) {
      return;
    }
    seen.add(item.label);
    items.push(item);
  };

  for (const candidate of await collectAvailableExtensionMembers(ast, objectTypeName, options, analysis)) {
    pushItem({
      label: candidate.name,
      kind: candidate.kind === "method" ? CompletionItemKind.Method : CompletionItemKind.Property,
      detail: `Extension ${candidate.kind}: ${candidate.receiverType}`,
      sortText: `3-${candidate.name}`
    });
  }

  if (options.uri && (options.sourceRoots?.length || options.getExportedSymbols)) {
    const autoImports = await buildExtensionAutoImportSuggestions({
      uri: options.uri,
      ast,
      sourceRoots: options.sourceRoots ?? [],
      ...(options.getExportedSymbols ? { getExportedSymbols: options.getExportedSymbols } : {}),
      receiverType: baseTypeName(objectTypeName),
      prefix: normalizedPrefix,
      excludeSymbols: seen
    });
    for (const suggestion of autoImports) {
      pushItem({
        label: suggestion.symbol.name,
        kind: suggestion.symbol.memberKind === "method" ? CompletionItemKind.Method : CompletionItemKind.Property,
        detail: `Auto import extension from ${suggestion.importPath}`,
        sortText: `4-${suggestion.symbol.name}`,
        additionalTextEdits: [
          {
            range: suggestion.range,
            newText: `import { ${suggestion.symbol.name} } from "${suggestion.importPath}"\n`
          }
        ]
      });
    }
  }

  return items.sort((left, right) => left.label.localeCompare(right.label));
}

async function buildClassMemberCompletionItems(
  classStatement: ClassStatement,
  objectTypeName: string | undefined,
  prefix: string,
  analysis: Analysis,
  memberAccessEdit:
    | {
        line: number;
        dotCharacter: number;
        prefixEndCharacter: number;
      }
    | undefined,
  resolverContext: {
    ast: Program;
    options: ClassResolverOptions;
    cache: ClassResolverCache;
  }
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const normalizedPrefix = prefix.trim();
  const membersByName = new Map(classStatement.members.map((member) => [member.name.name, member]));

  const pushItem = (item: CompletionItem): void => {
    if (normalizedPrefix.length > 0 && !item.label.startsWith(normalizedPrefix)) {
      return;
    }
    if (seen.has(item.label)) {
      return;
    }
    seen.add(item.label);
    items.push(item);
  };

  const memberNames = await resolveClassMemberNames(classStatement, objectTypeName, {
    ast: resolverContext.ast,
    options: resolverContext.options,
    cache: resolverContext.cache
  });
  for (const memberName of memberNames) {
    const resolved = await resolveClassMember(classStatement, memberName, objectTypeName, {
      ast: resolverContext.ast,
      options: resolverContext.options,
      analysis,
      cache: resolverContext.cache
    });
    if (!resolved) {
      continue;
    }
    if (resolved.kind === "field") {
      pushItem({
        label: memberName,
        kind: CompletionItemKind.Field,
        detail: `Class property: ${resolved.typeName}`,
        sortText: `${memberSortGroup(memberName, classStatement, membersByName)}-${memberName}`
      });
      continue;
    }

    const operatorSymbol = operatorSymbolFromMemberName(memberName);
    pushItem({
      label: memberName,
      kind: CompletionItemKind.Method,
      ...(operatorSymbol ? { filterText: memberName } : {}),
      detail: resolved.signature
        ? `Class method: (${resolved.signature.parameters.map((parameter) => `${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${resolved.signature.returnTypeName}`
        : "Class method",
      ...(operatorSymbol && memberAccessEdit
        ? {
            textEdit: {
              range: {
                start: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter + 1 },
                end: { line: memberAccessEdit.line, character: memberAccessEdit.prefixEndCharacter }
              },
              newText: ` ${operatorSymbol} `
            },
            additionalTextEdits: [
              {
                range: {
                  start: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter },
                  end: { line: memberAccessEdit.line, character: memberAccessEdit.dotCharacter + 1 }
                },
                newText: ""
              }
            ]
          }
        : {}),
      sortText: `${memberSortGroup(memberName, classStatement, membersByName)}-${memberName}`
    });
  }

  return items;
}

function buildInterfaceMemberCompletionItems(
  prefix: string,
  resolvedMembers: Array<InterfaceCompletionMember | TypeAliasCompletionMember>
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const normalizedPrefix = prefix.trim();
  for (const member of resolvedMembers) {
    if (normalizedPrefix.length > 0 && !member.name.startsWith(normalizedPrefix)) {
      continue;
    }
    if (seen.has(member.name)) {
      continue;
    }
    seen.add(member.name);
    items.push({
      label: member.name,
      kind: member.kind,
      detail: member.detail,
      sortText: `2-${member.name}`
    });
  }
  return items;
}

function typeAliasSubstitutions(
  typeAlias: TypeAliasStatement,
  objectTypeName: string
): Map<string, string> {
  const substitutions = new Map<string, string>();
  const parsedObjectType = parseTypeNameShape(objectTypeName);
  const declaredTypeParameters = typeAlias.typeParameters ?? [];
  for (let i = 0; i < declaredTypeParameters.length; i += 1) {
    const parameterName = declaredTypeParameters[i]?.name.name;
    if (!parameterName) {
      continue;
    }
    substitutions.set(parameterName, parsedObjectType.typeArguments[i] ?? parameterName);
  }
  return substitutions;
}

function parseObjectTypeTextMembers(
  objectTypeText: string,
  substitutions: Map<string, string> = new Map()
): TypeAliasCompletionMember[] {
  const targetTypeText = objectTypeText.trim();
  if (!targetTypeText.startsWith("{") || !targetTypeText.endsWith("}")) {
    return [];
  }

  const body = targetTypeText.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }

  const members: TypeAliasCompletionMember[] = [];

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
      const name = trimmedEntry.slice(0, methodOpenParen).trim().replace(/\?$/, "");
      if (!name) {
        continue;
      }
      members.push({
        name,
        kind: CompletionItemKind.Method,
        detail: `Type alias method: ${substituteTypeNameText(trimmedEntry.slice(methodOpenParen).trim(), substitutions)}`
      });
      continue;
    }

    if (propertyColon < 0) {
      continue;
    }
    const name = trimmedEntry.slice(0, propertyColon).trim().replace(/\?$/, "");
    if (!name) {
      continue;
    }
    members.push({
      name,
      kind: CompletionItemKind.Field,
      detail: `Type alias property: ${substituteTypeNameText(trimmedEntry.slice(propertyColon + 1).trim(), substitutions)}`
    });
  }

  return members;
}

function parseTypeAliasObjectMembers(
  typeAlias: TypeAliasStatement,
  objectTypeName: string
): TypeAliasCompletionMember[] {
  return parseObjectTypeTextMembers(
    typeAlias.targetType.name,
    typeAliasSubstitutions(typeAlias, objectTypeName)
  );
}

function classResolverOptionsFromCompletionOptions(options: CompletionRequestOptions): ClassResolverOptions {
  return {
    ...(options.uri ? { uri: options.uri } : {}),
    ...(options.sourceRoots ? { sourceRoots: options.sourceRoots } : {}),
    ...(options.getSessionForFilePath
      ? { getSessionForFilePath: options.getSessionForFilePath }
      : {})
  };
}

function findIdentifierAtPosition(
  ast: Program,
  line: number,
  character: number
): Identifier | null {
  let best: { identifier: Identifier; size: number } | undefined;
  walkAst(ast, (node) => {
    if (node.kind !== "Identifier") {
      return;
    }
    const identifier = node as Identifier;
    const range = nodeRange(identifier);
    if (!range || !containsPosition(range, { line, character })) {
      return;
    }
    const size = rangeSize(range);
    if (!best || size < best.size) {
      best = { identifier, size };
    }
  });
  return best ? best.identifier : null;
}

interface ArgumentCompletionContext {
  callee: Expr;
  argumentIndex: number;
  kind: "call" | "new";
}

function findArgumentCompletionContext(
  ast: Program,
  line: number,
  character: number
): ArgumentCompletionContext | null {
  const position = { line, character };
  let bestContext: ArgumentCompletionContext | null = null;
  let bestSize: number | null = null;

  const considerCallLike = (
    kind: "call" | "new",
    callee: Expr,
    args: Expr[]
  ): void => {
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (!argument) {
        continue;
      }
      const argumentRange = nodeRange(argument);
      if (!argumentRange || !containsPosition(argumentRange, position)) {
        continue;
      }
      const size = rangeSize(argumentRange);
      if (bestSize === null || size <= bestSize) {
        bestContext = {
          callee,
          argumentIndex: index,
          kind
        };
        bestSize = size;
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
        considerCallLike("call", call.callee, call.arguments);
        return;
      }
      case "NewExpression": {
        const call = expression as NewExpression;
        visitExpression(call.callee);
        for (const argument of call.arguments ?? []) {
          visitExpression(argument);
        }
        considerCallLike("new", call.callee, call.arguments ?? []);
        return;
      }
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        if ((expression as MemberExpression).computed) {
          visitExpression((expression as MemberExpression).property);
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
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement": {
        const variable = statement as VarStatement;
        if (variable.declarations?.length) {
          for (const declaration of variable.declarations) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if (variable.initializer) {
          visitExpression(variable.initializer);
        }
        return;
      }
      case "ExprStatement":
        visitExpression((statement as { kind: "ExprStatement"; expression: Expr }).expression);
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
            for (const child of (member as ClassMethodMember).body.body) {
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
        const loop = statement as ForStatement;
        if (loop.initializer?.kind === "VarStatement") {
          visitStatement(loop.initializer as Statement);
        } else if (loop.initializer) {
          visitExpression(loop.initializer as Expr);
        }
        if (loop.iterator?.kind === "VarStatement") {
          visitStatement(loop.iterator as Statement);
        } else if (loop.iterator?.kind !== "Identifier" && loop.iterator) {
          visitExpression(loop.iterator as Expr);
        }
        if (loop.iterable) {
          visitExpression(loop.iterable);
        }
        if (loop.condition) {
          visitExpression(loop.condition);
        }
        if (loop.update) {
          visitExpression(loop.update);
        }
        visitStatement(loop.body);
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

  for (const statement of ast.body) {
    visitStatement(statement);
  }

  return bestContext;
}

interface NamedArgumentCallContext {
  callee: Expr;
  isNew: boolean;
}

/**
 * Finds the innermost call or `new` expression whose argument list encloses the
 * cursor, so named-argument completions can offer the callee's parameter names.
 * Unlike {@link findArgumentCompletionContext}, it does not require an existing
 * argument at the cursor, so it also works for empty (`fetch(|)`) and partially
 * typed (`fetch(ur|)`) argument lists. The cursor must sit past the callee so we
 * are inside the parentheses rather than on the callee itself.
 */
function findNamedArgumentCallContext(
  ast: Program,
  line: number,
  character: number
): NamedArgumentCallContext | null {
  const position = { line, character };
  let best: NamedArgumentCallContext | null = null;
  let bestSize: number | null = null;

  walkAst(ast, (node) => {
    if (node.kind !== "CallExpression" && node.kind !== "NewExpression") {
      return;
    }
    const callLike = node as CallExpression | NewExpression;
    const range = nodeRange(callLike);
    if (!range || !containsPosition(range, position)) {
      return;
    }
    const calleeRange = nodeRange(callLike.callee);
    if (calleeRange && comparePosition(position, calleeRange.end) <= 0) {
      return;
    }
    const size = rangeSize(range);
    if (bestSize === null || size <= bestSize) {
      best = { callee: callLike.callee, isNew: node.kind === "NewExpression" };
      bestSize = size;
    }
  });

  return best;
}

async function buildNamedArgumentCompletionItems(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<CompletionItem[]> {
  const context = findNamedArgumentCallContext(ast, line, character);
  if (!context) {
    return [];
  }
  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const signature = context.isNew
    ? await resolveConstructorSignature(context.callee, analysis, ast, resolverOptions)
    : await resolveCallableSignature(context.callee, analysis, ast, resolverOptions);
  const parameters = signature?.parameters ?? [];
  const items: CompletionItem[] = [];
  for (const parameter of parameters) {
    if (parameter.rest) {
      continue;
    }
    items.push({
      label: `${parameter.name}:`,
      kind: CompletionItemKind.Field,
      detail: `Named argument: ${parameter.typeName}`,
      filterText: parameter.name,
      insertText: `${parameter.name}: `,
      sortText: `0-${parameter.name}`
    });
  }
  return items;
}

async function inferExpectedTypeForPosition(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<string | null> {
  const context = findArgumentCompletionContext(ast, line, character);
  if (!context) {
    return null;
  }

  if (context.kind === "call") {
    const signature = await resolveCallableSignature(
      context.callee,
      analysis,
      ast,
      classResolverOptionsFromCompletionOptions(options)
    );
    return signature?.parameters[context.argumentIndex]?.typeName ?? null;
  }

  const constructorSignature = await resolveConstructorSignature(
    context.callee,
    analysis,
    ast,
    classResolverOptionsFromCompletionOptions(options)
  );
  return constructorSignature?.parameters[context.argumentIndex]?.typeName ?? null;
}

function symbolTypeName(symbol: AnalysisSymbol): string | null {
  if (symbol.valueType && symbol.valueType !== "unknown") {
    return symbol.valueType;
  }
  if (symbol.type) {
    return typeToString(symbol.type);
  }
  return null;
}

function isAssignableTypeName(sourceType: string, targetType: string): boolean {
  if (sourceType === targetType) {
    return true;
  }
  if (sourceType === "int" && targetType === "number") {
    return true;
  }
  if (sourceType === "long" && targetType === "bigint") {
    return true;
  }
  if (
    targetType === "numeric" &&
    (sourceType === "int" || sourceType === "number" || sourceType === "long" || sourceType === "bigint")
  ) {
    return true;
  }
  return false;
}

function symbolTypeRelevance(symbol: AnalysisSymbol, expectedTypeName: string | null): number {
  if (!expectedTypeName || expectedTypeName === "unknown") {
    return 0;
  }
  const candidateTypeName = symbolTypeName(symbol);
  if (!candidateTypeName) {
    return 0;
  }
  if (candidateTypeName === expectedTypeName) {
    return 2;
  }
  if (isAssignableTypeName(candidateTypeName, expectedTypeName)) {
    return 1;
  }
  return 0;
}

function symbolKindPriority(symbol: AnalysisSymbol): number {
  if (symbol.kind === "parameter") {
    return 0;
  }
  if (symbol.kind === "variable") {
    return 1;
  }
  if (symbol.kind === "function" || symbol.kind === "method") {
    return 2;
  }
  if (symbol.kind === "class") {
    return 3;
  }
  return 4;
}

function symbolReceiverPriority(symbol: AnalysisSymbol): number {
  if (symbol.implicitReceiver === true && symbol.name !== "this") {
    return 0;
  }
  if (symbol.name === "this") {
    return 2;
  }
  return 1;
}

function inferClassNameFromAstVariableInitializer(
  ast: Program,
  variableName: string,
  line: number
): string | null {
  let bestLine = -1;
  let bestClassName: string | null = null;

  const maybeClassNameFromInitializer = (initializer: Expr | undefined): string | null => {
    if (!initializer || initializer.kind !== "NewExpression") {
      return null;
    }
    const newExpression = initializer as Expr & { kind: "NewExpression"; callee: Expr };
    if (newExpression.callee.kind === "Identifier") {
      return (newExpression.callee as Expr & { kind: "Identifier"; name: string }).name;
    }
    return null;
  };

  const considerDeclaration = (
    name: string,
    initializer: Expr | undefined,
    declarationLine: number
  ): void => {
    if (name !== variableName || declarationLine > line) {
      return;
    }
    const className = maybeClassNameFromInitializer(initializer);
    if (!className) {
      return;
    }
    if (declarationLine >= bestLine) {
      bestLine = declarationLine;
      bestClassName = className;
    }
  };

  const visitStatements = (statements: Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "VarStatement") {
        const varStatement = statement as VarStatement;
        if (varStatement.declarations && varStatement.declarations.length > 0) {
          for (const declaration of varStatement.declarations) {
            for (const identifier of bindingIdentifiers(declaration.name)) {
              const declarationLine = identifier.firstToken?.range.start.line ?? -1;
              considerDeclaration(identifier.name, declaration.initializer, declarationLine);
            }
          }
        } else {
          for (const identifier of bindingIdentifiers(varStatement.name)) {
            const declarationLine = identifier.firstToken?.range.start.line ?? -1;
            considerDeclaration(identifier.name, varStatement.initializer, declarationLine);
          }
        }
      }

      if (statement.kind === "FunctionStatement") {
        visitStatements((statement as FunctionStatement).body.body);
      } else if (statement.kind === "BlockStatement") {
        visitStatements((statement as BlockStatement).body);
      } else if (statement.kind === "IfStatement") {
        const ifStatement = statement as IfStatement;
        visitStatements([ifStatement.thenBranch]);
        if (ifStatement.elseBranch) {
          visitStatements([ifStatement.elseBranch]);
        }
      } else if (statement.kind === "WhileStatement" || statement.kind === "DoWhileStatement") {
        const loopStatement = statement as WhileStatement | DoWhileStatement;
        visitStatements([loopStatement.body]);
      } else if (statement.kind === "WithStatement") {
        visitStatements([(statement as WithStatement).body]);
      } else if (statement.kind === "LabeledStatement") {
        visitStatements([(statement as LabeledStatement).body]);
      } else if (statement.kind === "ForStatement") {
        const forStatement = statement as ForStatement;
        if (forStatement.initializer && forStatement.initializer.kind === "VarStatement") {
          visitStatements([forStatement.initializer]);
        }
        visitStatements([forStatement.body]);
      } else if (statement.kind === "SwitchStatement") {
        for (const switchCase of (statement as SwitchStatement).cases) {
          visitStatements(switchCase.consequent);
        }
      } else if (statement.kind === "TryStatement") {
        const tryStatement = statement as TryStatement;
        visitStatements(tryStatement.tryBlock.body);
        if (tryStatement.catchClause) {
          visitStatements(tryStatement.catchClause.body.body);
        }
        if (tryStatement.finallyBlock) {
          visitStatements(tryStatement.finallyBlock.body);
        }
      } else if (statement.kind === "ClassStatement") {
        for (const member of (statement as ClassStatement).members) {
          if (member.kind === "ClassMethodMember") {
            visitStatements(member.body.body);
          }
        }
      }
    }
  };

  visitStatements(ast.body);
  return bestClassName;
}

function inferTypeNameFromAstBindingAnnotation(
  ast: Program,
  bindingName: string,
  line: number
): string | null {
  let bestLine = -1;
  let bestTypeName: string | null = null;

  const typeNameFromAnnotation = (typeAnnotation: TypeAnnotation | undefined): string | null => {
    if (!typeAnnotation) {
      return null;
    }
    if (typeAnnotation.kind === "Identifier") {
      return typeAnnotation.name;
    }
    if (typeAnnotation.kind === "TypeReference") {
      return typeAnnotation.name.name;
    }
    return null;
  };

  const considerDeclaration = (
    name: string,
    typeAnnotation: TypeAnnotation | undefined,
    declarationLine: number
  ): void => {
    if (name !== bindingName || declarationLine > line) {
      return;
    }
    const typeName = typeNameFromAnnotation(typeAnnotation);
    if (!typeName) {
      return;
    }
    if (declarationLine >= bestLine) {
      bestLine = declarationLine;
      bestTypeName = typeName;
    }
  };

  const visitStatements = (statements: Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "FunctionStatement") {
        const fn = statement as FunctionStatement;
        for (const parameter of fn.parameters) {
          for (const identifier of bindingIdentifiers(parameter.name)) {
            const declarationLine = identifier.firstToken?.range.start.line ?? -1;
            considerDeclaration(identifier.name, parameter.typeAnnotation, declarationLine);
          }
        }
      }

      if (statement.kind === "VarStatement") {
        const varStatement = statement as VarStatement;
        if (varStatement.declarations && varStatement.declarations.length > 0) {
          for (const declaration of varStatement.declarations) {
            for (const identifier of bindingIdentifiers(declaration.name)) {
              const declarationLine = identifier.firstToken?.range.start.line ?? -1;
              considerDeclaration(identifier.name, declaration.typeAnnotation, declarationLine);
            }
          }
        } else {
          for (const identifier of bindingIdentifiers(varStatement.name)) {
            const declarationLine = identifier.firstToken?.range.start.line ?? -1;
            considerDeclaration(identifier.name, varStatement.typeAnnotation, declarationLine);
          }
        }
      }

      if (statement.kind === "FunctionStatement") {
        visitStatements((statement as FunctionStatement).body.body);
      } else if (statement.kind === "BlockStatement") {
        visitStatements((statement as BlockStatement).body);
      } else if (statement.kind === "IfStatement") {
        const ifStatement = statement as IfStatement;
        visitStatements([ifStatement.thenBranch]);
        if (ifStatement.elseBranch) {
          visitStatements([ifStatement.elseBranch]);
        }
      } else if (statement.kind === "WhileStatement" || statement.kind === "DoWhileStatement") {
        const loopStatement = statement as WhileStatement | DoWhileStatement;
        visitStatements([loopStatement.body]);
      } else if (statement.kind === "WithStatement") {
        visitStatements([(statement as WithStatement).body]);
      } else if (statement.kind === "LabeledStatement") {
        visitStatements([(statement as LabeledStatement).body]);
      } else if (statement.kind === "ForStatement") {
        const forStatement = statement as ForStatement;
        if (forStatement.initializer && forStatement.initializer.kind === "VarStatement") {
          visitStatements([forStatement.initializer]);
        }
        visitStatements([forStatement.body]);
      } else if (statement.kind === "SwitchStatement") {
        for (const switchCase of (statement as SwitchStatement).cases) {
          visitStatements(switchCase.consequent);
        }
      } else if (statement.kind === "TryStatement") {
        const tryStatement = statement as TryStatement;
        visitStatements(tryStatement.tryBlock.body);
        if (tryStatement.catchClause) {
          visitStatements(tryStatement.catchClause.body.body);
        }
        if (tryStatement.finallyBlock) {
          visitStatements(tryStatement.finallyBlock.body);
        }
      } else if (statement.kind === "ClassStatement") {
        const classStatement = statement as ClassStatement;
        for (const parameter of classStatement.primaryConstructorParameters ?? []) {
          for (const identifier of bindingIdentifiers(parameter.name)) {
            const declarationLine = identifier.firstToken?.range.start.line ?? -1;
            considerDeclaration(identifier.name, parameter.typeAnnotation, declarationLine);
          }
        }
        for (const member of classStatement.members) {
          if (member.kind === "ClassMethodMember") {
            for (const parameter of member.parameters) {
              for (const identifier of bindingIdentifiers(parameter.name)) {
                const declarationLine = identifier.firstToken?.range.start.line ?? -1;
                considerDeclaration(identifier.name, parameter.typeAnnotation, declarationLine);
              }
            }
            visitStatements(member.body.body);
          }
        }
      }
    }
  };

  visitStatements(ast.body);
  return bestTypeName;
}

async function resolveTypeNameFromPath(
  ast: Program,
  analysis: Analysis,
  pathSegments: string[],
  line: number,
  objectStartCharacter: number,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache
): Promise<string | null> {
  if (pathSegments.length === 0) {
    return null;
  }

  const typeNameFromSymbol = (symbol: AnalysisSymbol): string | null => {
    if (symbol.valueType && symbol.valueType !== "unknown") {
      return symbol.valueType;
    }
    if (symbol.type) {
      return typeToString(symbol.type);
    }
    return null;
  };

  const identifierAtCursor = pathSegments.length === 1
    ? findIdentifierAtPosition(ast, line, objectStartCharacter)
    : null;
  if (identifierAtCursor) {
    const expressionTypeName = analysis.getExpressionTypes().get(identifierAtCursor)
      ? typeToString(analysis.getExpressionTypes().get(identifierAtCursor)!)
      : null;
    const narrowedExpressionTypeName = nonNullishTypeName(expressionTypeName);
    if (narrowedExpressionTypeName && narrowedExpressionTypeName !== "unknown") {
      return narrowedExpressionTypeName;
    }
    const annotatedTypeName = inferTypeNameFromAstBindingAnnotation(ast, identifierAtCursor.name, line);
    if (annotatedTypeName) {
      return annotatedTypeName;
    }
  }

  const symbolMatch = analysis.getSymbolAt(line, Math.max(0, objectStartCharacter));
  let currentTypeName: string | null = null;
  const firstSegment = pathSegments[0];
  if (!firstSegment) {
    return null;
  }
  const literalTypeName = inferLiteralTypeName(firstSegment);
  if (literalTypeName) {
    currentTypeName = literalTypeName;
  }
  if (!currentTypeName) {
    const resolvedSymbolMatch = symbolMatch;
    if (resolvedSymbolMatch && resolvedSymbolMatch.symbol.name === firstSegment) {
      currentTypeName = typeNameFromSymbol(resolvedSymbolMatch.symbol);
    } else {
      const visibleSymbols = analysis.getVisibleSymbolsAt(line, objectStartCharacter);
      const symbol = visibleSymbols.find((candidate) => candidate.name === firstSegment);
      if (!symbol) {
        currentTypeName =
          inferTypeNameFromAstBindingAnnotation(ast, firstSegment, line) ??
          inferClassNameFromAstVariableInitializer(ast, firstSegment, line);
        if (!currentTypeName) {
          return null;
        }
      } else {
        currentTypeName = typeNameFromSymbol(symbol);
      }
    }
  }

  currentTypeName = nonNullishTypeName(currentTypeName);
  if (!currentTypeName || currentTypeName === "unknown") {
    currentTypeName =
      inferTypeNameFromAstBindingAnnotation(ast, firstSegment, line) ??
      inferClassNameFromAstVariableInitializer(ast, firstSegment, line);
  }
  for (let index = 1; index < pathSegments.length; index += 1) {
    const memberName = pathSegments[index];
    if (!memberName || !currentTypeName) {
      return null;
    }
    currentTypeName = boxedCompletionTypeName(currentTypeName);
    if (!currentTypeName) {
      return null;
    }
    const classResolution = await resolveClassStatementAcrossFiles(
      ast,
      baseTypeName(currentTypeName),
      resolverOptions,
      resolverCache
    );
    if (!classResolution) {
      const interfaceStatement = (await resolveInterfaceStatementAcrossFiles(
        ast,
        baseTypeName(currentTypeName),
        resolverOptions,
        resolverCache
      ))?.interfaceStatement;
      if (interfaceStatement) {
        const member = await resolveInterfaceMember(interfaceStatement, memberName, currentTypeName, {
          ast,
          options: resolverOptions,
          cache: resolverCache
        });
        if (member) {
          currentTypeName = member.kind === "method"
            ? member.signature?.returnTypeName ?? null
            : member.typeName;
          continue;
        }
      }
      currentTypeName = await resolveExtensionMemberTypeName(
        ast,
        currentTypeName,
        memberName,
        {
          ...resolverOptions
        },
        analysis
      );
      if (!currentTypeName) {
        return null;
      }
      continue;
    }
    const member = await resolveClassMember(classResolution.classStatement, memberName, currentTypeName, {
      ast,
      options: resolverOptions,
      analysis,
      cache: resolverCache
    });
    if (!member) {
      currentTypeName = await resolveExtensionMemberTypeName(
        ast,
        currentTypeName,
        memberName,
        {
          ...resolverOptions
        },
        analysis
      );
      if (!currentTypeName) {
        return null;
      }
      continue;
    }
    if (member.kind === "method") {
      currentTypeName = member.signature?.returnTypeName ?? null;
    } else {
      currentTypeName = member.typeName;
    }
  }

  return currentTypeName;
}

async function findNodeModuleNamespaceForTypeName(
  ast: Program,
  typeName: string,
  importerFilePath: string,
  options: CompletionRequestOptions
): Promise<NamespaceStatement | null> {
  for (const statement of ast.body) {
    if (statement.kind !== "ImportStatement") continue;
    const importStatement = statement as ImportStatement;
    if (importStatement.from.value.startsWith(".")) continue;
    const typings = await getNodeModuleTypings(importerFilePath, importStatement.from.value, { vfs: options.vfs });
    if (!typings || typings.defaultExportName !== typeName) continue;
    for (const decl of typings.declarations) {
      const candidate =
        decl.kind === "ExportStatement"
          ? (decl as { declaration?: Statement }).declaration ?? decl
          : decl;
      if (
        candidate.kind === "NamespaceStatement" &&
        (candidate as NamespaceStatement).names?.[0]?.name === typeName
      ) {
        return candidate as NamespaceStatement;
      }
    }
  }
  return null;
}

function findNamespaceByPath(ast: Program, path: string[]): NamespaceStatement | null {
  let statements: Statement[] = ast.body;
  let found: NamespaceStatement | null = null;
  for (const segment of path) {
    found = null;
    for (const statement of statements) {
      const candidate = statement.kind === "ExportStatement" ? (statement as ExportStatement).declaration : statement;
      if (candidate?.kind === "NamespaceStatement" && (candidate as NamespaceStatement).names?.[0]?.name === segment) {
        found = candidate as NamespaceStatement;
        break;
      }
    }
    if (!found) return null;
    statements = found.body.body;
  }
  return found;
}

function buildNamespaceMemberCompletionItems(namespaceStatement: NamespaceStatement, prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const push = (label: string, kind: CompletionItemKind, detail: string): void => {
    if (!label.startsWith(prefix) || seen.has(label)) return;
    seen.add(label);
    items.push({ label, kind, detail });
  };
  for (const statement of namespaceStatement.body.body) {
    if (statement.kind !== "ExportStatement") continue;
    const exported = statement as ExportStatement;
    const declaration = exported.declaration;
    if (declaration?.kind === "VarStatement") {
      const variable = declaration as VarStatement;
      const bindings = variable.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(variable.name);
      for (const binding of bindings) push(binding.name, CompletionItemKind.Variable, "Namespace variable");
    } else if (declaration?.kind === "FunctionStatement") {
      push((declaration as FunctionStatement).name.name, CompletionItemKind.Function, "Namespace function");
    } else if (declaration?.kind === "ClassStatement") {
      push((declaration as ClassStatement).name.name, CompletionItemKind.Class, "Namespace class");
    } else if (declaration?.kind === "NamespaceStatement") {
      const name = (declaration as NamespaceStatement).names?.[0]?.name;
      if (name) push(name, CompletionItemKind.Module, "Namespace");
    }
    for (const specifier of exported.specifiers ?? []) push(specifier.exported.name, CompletionItemKind.Variable, "Namespace export");
  }
  return items;
}

async function buildMemberCompletionItemsForType(
  ast: Program,
  analysis: Analysis,
  className: string,
  prefix: string,
  line: number,
  dotCharacter: number,
  prefixEndCharacter: number,
  options: CompletionRequestOptions,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache
): Promise<CompletionItem[]> {
  // Array types (`T[]`) resolve their members from the declared `class Array<T>`.
  const narrowedClassName = boxedCompletionTypeName(className);
  const resolvedClassName = arrayTypeNameToArrayAlias(narrowedClassName) ?? narrowedClassName;
  const classStatement = (await resolveClassStatementAcrossFiles(
    ast,
    baseTypeName(resolvedClassName),
    resolverOptions,
    resolverCache
  ))?.classStatement;
  const interfaceStatement = (await resolveInterfaceStatementAcrossFiles(
    ast,
    baseTypeName(resolvedClassName),
    resolverOptions,
    resolverCache
  ))?.interfaceStatement;
  const interfaceMembers: InterfaceCompletionMember[] = interfaceStatement
    ? await Promise.all(
      (await resolveInterfaceMemberNames(
        interfaceStatement,
        resolvedClassName,
        {
          ast,
          options: resolverOptions,
          cache: resolverCache
        }
      )).map(async (memberName) => {
        const member = await resolveInterfaceMember(interfaceStatement, memberName, resolvedClassName, {
          ast,
          options: resolverOptions,
          cache: resolverCache
        });
        if (!member) {
          return null;
        }
        return {
          name: memberName,
          kind: member.kind === "field" ? CompletionItemKind.Field : CompletionItemKind.Method,
          detail: member.kind === "field"
            ? `Interface property: ${member.typeName}`
            : `Interface method: ${member.typeName}`
        };
      })
    ).then((members) => members.filter((member): member is InterfaceCompletionMember => member !== null))
    : [];
  const ambientInterfaceMembers = !interfaceStatement && options.ambientDeclarations
    ? collectAmbientInterfaceCompletionMembers(options.ambientDeclarations, baseTypeName(resolvedClassName))
    : [];
  const typeAliasStatement = (await resolveTopLevelDeclarationAcrossFiles({
    ast,
    name: baseTypeName(resolvedClassName),
    currentFilePath: options.uri ? fileURLToPath(options.uri) : null,
    predicate: (statement): statement is TypeAliasStatement => statement.kind === "TypeAliasStatement",
    includeRuntime: true,
    sourceRoots: resolverOptions.sourceRoots ?? [],
    ...(resolverOptions.vfs ? { vfs: resolverOptions.vfs } : {}),
    ...(resolverOptions.getSessionForFilePath
      ? { getSessionForFilePath: resolverOptions.getSessionForFilePath }
      : {})
  }))?.declaration;
  const typeAliasMembers = typeAliasStatement
    ? parseTypeAliasObjectMembers(typeAliasStatement, resolvedClassName)
    : [];
  const objectTypeMembers = parseObjectTypeTextMembers(resolvedClassName);
  return [
    ...await buildExtensionMemberCompletionItems(ast, className, prefix, options, analysis),
    ...(classStatement
      ? await buildClassMemberCompletionItems(
        classStatement,
        resolvedClassName,
        prefix,
        analysis,
        {
          line,
          dotCharacter,
            prefixEndCharacter
          },
          {
            ast,
            options: resolverOptions,
            cache: resolverCache
          }
        )
      : interfaceStatement
        ? buildInterfaceMemberCompletionItems(prefix, interfaceMembers)
        : ambientInterfaceMembers.length > 0
          ? buildInterfaceMemberCompletionItems(prefix, ambientInterfaceMembers)
        : typeAliasMembers.length > 0
          ? buildInterfaceMemberCompletionItems(prefix, typeAliasMembers)
          : objectTypeMembers.length > 0
            ? buildInterfaceMemberCompletionItems(prefix, objectTypeMembers)
          : [])
  ];
}

async function buildMemberAccessCompletions(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions,
  allowRecovery = true
): Promise<CompletionItem[] | null> {
  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const resolverCache = createClassResolverCache();

  const target = parseMemberAccessTarget(options.text, line, character);
  if (target) {
    const pathSegments = target.objectPath.split(".");
    const importerFilePath = options.uri ? fileURLToPath(options.uri) : null;
    const namespaceStatement =
      findNamespaceByPath(ast, pathSegments) ??
      (importerFilePath && pathSegments.length === 1 && pathSegments[0]
        ? await findNodeModuleNamespaceForTypeName(ast, pathSegments[0], importerFilePath, options)
        : null);
    if (namespaceStatement) {
      return buildNamespaceMemberCompletionItems(namespaceStatement, target.prefix);
    }
    const className = await resolveTypeNameFromPath(
      ast,
      analysis,
      pathSegments,
      line,
      target.objectStartCharacter,
      resolverOptions,
      resolverCache
    );
    if (className) {
      const items = await buildMemberCompletionItemsForType(
        ast,
        analysis,
        className,
        target.prefix,
        line,
        target.memberAccessStartCharacter,
        character,
        options,
        resolverOptions,
        resolverCache
      );
      if (items.length > 0 || !allowRecovery) {
        return items;
      }
      return buildRecoveredMemberAccessCompletions(line, character, options);
    }
  }

  // The receiver is a complex expression (such as a call like `fetch(...)`) or
  // identifier-based resolution failed. Resolve its type from the analyzed
  // expression types, which already reflect sync-function auto-await
  // (`Promise<T>` is observed as `T`).
  const dot = findMemberAccessDot(options.text, line, character);
  if (dot) {
    const receiverTypeName = receiverTypeNameEndingAt(analysis, line, dot.receiverEndCharacter);
    if (receiverTypeName && receiverTypeName !== "unknown") {
      const items = await buildMemberCompletionItemsForType(
        ast,
        analysis,
        receiverTypeName,
        dot.prefix,
        line,
        dot.dotCharacter,
        character,
        options,
        resolverOptions,
        resolverCache
      );
      if (items.length > 0) {
        return items;
      }
    }
  }

  if (!target && !dot) {
    return null;
  }
  return allowRecovery ? buildRecoveredMemberAccessCompletions(line, character, options) : null;
}

function collectAmbientInterfaceCompletionMembers(
  ambientDeclarations: Statement[],
  interfaceName: string
): InterfaceCompletionMember[] {
  const items: InterfaceCompletionMember[] = [];
  for (const statement of ambientDeclarations) {
    const declaration = unwrapExportedDeclaration(statement) ?? statement;
    if (declaration.kind !== "InterfaceStatement") {
      continue;
    }
    const interfaceStatement = declaration as InterfaceStatement;
    if (interfaceStatement.name.name !== interfaceName) {
      continue;
    }
    for (const member of interfaceStatement.members) {
      if (member.kind === "InterfacePropertyMember") {
        items.push({
          name: member.name.name,
          detail: `Interface property: ${member.typeAnnotation?.name ?? "unknown"}`,
          kind: CompletionItemKind.Field
        });
      } else if (member.kind === "InterfaceMethodMember") {
        items.push({
          name: member.name.name,
          detail: `Interface method: ${member.returnType?.name ?? "unknown"}`,
          kind: CompletionItemKind.Method
        });
      }
    }
  }
  return items;
}

function recoverSourceForMemberAccessCompletion(
  text: string,
  line: number,
  character: number
): string | null {
  const target =
    parseMemberAccessTarget(text, line, character) ?? findMemberAccessDot(text, line, character);
  if (!target) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (lineText === undefined) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const prefixStartCharacter = "memberAccessStartCharacter" in target
    ? clampedCharacter - target.prefix.length
    : clampedCharacter - target.prefix.length;
  lines[line] =
    lineText.slice(0, prefixStartCharacter) +
    COMPLETION_RECOVERY_MEMBER +
    lineText.slice(clampedCharacter);
  return lines.join("\n");
}

async function buildRecoveredMemberAccessCompletions(
  line: number,
  character: number,
  options: CompletionRequestOptions
): Promise<CompletionItem[] | null> {
  if (!options.text) {
    return null;
  }
  const recoveredSource = recoverSourceForMemberAccessCompletion(options.text, line, character);
  if (!recoveredSource || recoveredSource === options.text) {
    return null;
  }
  const recovered = options.recoverAnalysisSession
    ? await options.recoverAnalysisSession(recoveredSource)
    : compileSource(recoveredSource);
  if (!recovered.ast || !recovered.analysis) {
    return null;
  }
  const recoveredTypeName = recoveredReceiverTypeName(recovered.ast, recovered.analysis);
  if (recoveredTypeName && recoveredTypeName !== "unknown") {
    const dot = findMemberAccessDot(recoveredSource, line, character);
    if (dot) {
      const resolverOptions = classResolverOptionsFromCompletionOptions(options);
      const resolverCache = createClassResolverCache();
      const items = await buildMemberCompletionItemsForType(
        recovered.ast,
        recovered.analysis,
        recoveredTypeName,
        dot.prefix,
        line,
        dot.dotCharacter,
        character,
        {
          ...options,
          text: recoveredSource
        },
        resolverOptions,
        resolverCache
      );
      if (items.length > 0) {
        return items;
      }
    }
  }
  return buildMemberAccessCompletions(
    recovered.ast,
    recovered.analysis,
    line,
    character,
    {
      ...options,
      text: recoveredSource
    },
    false
  );
}

export async function createCompletionItemsForPosition(
  ast: Program,
  line: number,
  character: number,
  analysis?: Analysis | null,
  autoImportSuggestions: AutoImportSuggestion[] = [],
  options: CompletionRequestOptions = {}
): Promise<CompletionItem[]> {
  const resolvedAnalysis = analysis ?? new Analysis(ast);
  const resolvedAutoImportSuggestions =
    autoImportSuggestions.length > 0
      ? autoImportSuggestions
      : options.uri && (options.sourceRoots?.length || options.getExportedSymbols)
        ? await buildAutoImportSuggestions({
            uri: options.uri,
            ast,
            sourceRoots: options.sourceRoots ?? [],
            ...(options.getExportedSymbols ? { getExportedSymbols: options.getExportedSymbols } : {}),
            prefix: identifierPrefixAtPosition(options.text, line, character),
            excludeSymbols: new Set(resolvedAnalysis.getVisibleSymbolsAt(line, character).map((symbol) => symbol.name))
          })
        : [];
  const memberCompletions = await buildMemberAccessCompletions(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  if (memberCompletions && memberCompletions.length > 0) {
    return memberCompletions.map(withCallSnippet);
  }
  const memberTarget = parseMemberAccessTarget(options.text, line, character);
  const literalReceiverType = memberTarget ? inferLiteralTypeName(memberTarget.objectPath) : null;
  if (memberTarget && literalReceiverType) {
    const literalExtensionCompletions = await buildExtensionMemberCompletionItems(
      ast,
      literalReceiverType,
      memberTarget.prefix,
      options,
      resolvedAnalysis
    );
    if (literalExtensionCompletions.length > 0) {
      return literalExtensionCompletions.map(withCallSnippet);
    }
  }

  const visibleSymbols = resolvedAnalysis.getVisibleSymbolsAt(line, character);
  const expectedTypeName = await inferExpectedTypeForPosition(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );

  const rankedSymbols = visibleSymbols
    .map((symbol, scopeDistance) => ({
      symbol,
      scopeDistance,
      typeRelevance: symbolTypeRelevance(symbol, expectedTypeName),
      receiverPriority: symbolReceiverPriority(symbol),
      kindPriority: symbolKindPriority(symbol)
    }))
    .sort((left, right) => {
      if (left.typeRelevance !== right.typeRelevance) {
        return right.typeRelevance - left.typeRelevance;
      }
      if (left.receiverPriority !== right.receiverPriority) {
        return left.receiverPriority - right.receiverPriority;
      }
      if (left.scopeDistance !== right.scopeDistance) {
        return left.scopeDistance - right.scopeDistance;
      }
      if (left.kindPriority !== right.kindPriority) {
        return left.kindPriority - right.kindPriority;
      }
      return left.symbol.name.localeCompare(right.symbol.name);
    });

  const items: CompletionItem[] = [];
  const seenLabels = new Set<string>();
  const suppressExistingSymbolCompletions =
    isDeclarationNamePosition(ast, line, character) ||
    isTextualDeclarationNamePosition(options.text, line, character);

  // Named-argument suggestions (`url:`) are offered alongside the in-scope
  // symbols whenever the cursor is inside a call's argument list, ranked above
  // ordinary symbols so they surface first.
  const namedArgumentItems = await buildNamedArgumentCompletionItems(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  for (const item of namedArgumentItems) {
    if (seenLabels.has(item.label)) {
      continue;
    }
    seenLabels.add(item.label);
    items.push(item);
  }

  if (!suppressExistingSymbolCompletions) {
    for (let index = 0; index < rankedSymbols.length; index += 1) {
      const entry = rankedSymbols[index]!;
      const symbol = entry.symbol;
      seenLabels.add(symbol.name);
      const documentation =
        symbol.node.kind === "Identifier"
          ? readDocumentationFromProgramDeclaration(ast, symbol.node as Identifier)
          : undefined;
      items.push({
        label: symbol.name,
        kind: symbolKindToCompletionKind(symbol),
        detail: symbolDetail(symbol),
        ...(documentation ? { documentation } : {}),
        sortText: `1-${entry.typeRelevance}-${String(entry.scopeDistance).padStart(4, "0")}-${String(index).padStart(4, "0")}-${symbol.name}`
      });
    }
  }

  if (!suppressExistingSymbolCompletions) {
    for (const suggestion of resolvedAutoImportSuggestions) {
      if (seenLabels.has(suggestion.symbol.name)) {
        continue;
      }
      seenLabels.add(suggestion.symbol.name);

      let kind: CompletionItemKind = CompletionItemKind.Variable;
      if (suggestion.symbol.kind === "class") {
        kind = CompletionItemKind.Class;
      } else if (suggestion.symbol.kind === "interface" || suggestion.symbol.kind === "type") {
        kind = CompletionItemKind.Interface;
      } else if (suggestion.symbol.kind === "function") {
        kind = CompletionItemKind.Function;
      }

      items.push({
        label: suggestion.symbol.name,
        kind,
        detail: `Auto import from ${suggestion.importPath}`,
        sortText: `8-${suggestion.symbol.name}`,
        additionalTextEdits: [
          {
            range: suggestion.range,
            newText: `import { ${suggestion.symbol.name} } from "${suggestion.importPath}"\n`
          }
        ]
      });
    }
  }

  for (let index = 0; index < KEYWORD_COMPLETIONS.length; index += 1) {
    const item = KEYWORD_COMPLETIONS[index]!;
    if (seenLabels.has(item.label)) {
      continue;
    }
    seenLabels.add(item.label);
    items.push({
      ...item,
      sortText: `9-${String(index).padStart(4, "0")}-${item.label}`
    });
  }

  return items.map(withCallSnippet);
}

export function createKeywordOnlyCompletionItems(): CompletionItem[] {
  return [...KEYWORD_COMPLETIONS];
}
