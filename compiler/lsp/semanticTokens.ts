import { bindingElements, bindingIdentifiers } from "compiler/ast/bindingPatterns";
import type {
  ArrayLiteral,
  AsExpression,
  ArrowFunctionExpression,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  CatchClause,
  ChainExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
  EnumStatement,
  Expr,
  ExprStatement,
  ExportStatement,
  ForStatement,
  FunctionExpression,
  FunctionParameter,
  FunctionStatement,
  Identifier,
  IfStatement,
  LabeledStatement,
  ImportStatement,
  MemberExpression,
  NamespaceStatement,
  NewExpression,
  NonNullExpression,
  ObjectLiteral,
  ObjectProperty,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarDeclarator,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";
import type { SourceRange, Token } from "compiler/parser/tokenizer";
import { tokenize } from "compiler/parser/tokenizer";
import {
  type SemanticTokens,
  type SemanticTokensLegend
} from "vscode-languageserver/node.js";
import { comparePosition, type Position } from "./ranges";

class SimpleSemanticTokensBuilder {
  private readonly data: number[] = [];
  private previousLine = 0;
  private previousCharacter = 0;

  push(
    line: number,
    character: number,
    length: number,
    tokenType: number,
    tokenModifiers: number
  ): void {
    const deltaLine = line - this.previousLine;
    const deltaCharacter = deltaLine === 0
      ? character - this.previousCharacter
      : character;
    this.data.push(deltaLine, deltaCharacter, length, tokenType, tokenModifiers);
    this.previousLine = line;
    this.previousCharacter = character;
  }

  build(): SemanticTokens {
    return { data: this.data };
  }
}

const TOKEN_TYPES = [
  "keyword",
  "keywordControl",
  "keywordModifier",
  "keywordFunction",
  "keywordType",
  "variable",
  "parameter",
  "function",
  "method",
  "class",
  "enumMember",
  "property",
  "namespace",
  "type",
  "number",
  "string",
  "operator"
] as const;

const TOKEN_MODIFIERS = [
  "deprecated"
] as const;

type TokenTypeName = (typeof TOKEN_TYPES)[number];
type TokenModifierName = (typeof TOKEN_MODIFIERS)[number];

const TOKEN_MODIFIER_INDEX: Record<TokenModifierName, number> = TOKEN_MODIFIERS.reduce(
  (indexByType, tokenModifier, index) => {
    indexByType[tokenModifier] = index;
    return indexByType;
  },
  {} as Record<TokenModifierName, number>
);

export const DEPRECATED_TOKEN_MODIFIER = 1 << TOKEN_MODIFIER_INDEX.deprecated;

const TOKEN_TYPE_INDEX: Record<TokenTypeName, number> = TOKEN_TYPES.reduce(
  (indexByType, tokenType, index) => {
    indexByType[tokenType] = index;
    return indexByType;
  },
  {} as Record<TokenTypeName, number>
);

export const VEXA_SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: [...TOKEN_MODIFIERS]
};

const CONTROL_KEYWORDS = new Set([
  "return",
  "throw",
  "if",
  "else",
  "for",
  "in",
  "of",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "debugger",
  "try",
  "catch",
  "finally",
  "defer",
  "new",
  "typeof",
  "void",
  "delete",
  "await",
  "instanceof"
]);

const MODIFIER_KEYWORDS = new Set([
  "readonly",
  "public",
  "private",
  "protected",
  "static",
  "abstract",
  "get",
  "set",
  "async",
  "sync",
  "let",
  "var",
  "val",
  "const"
]);

const FUNCTION_KEYWORDS = new Set([
  "fun",
  "function"
]);

const TYPE_KEYWORDS = new Set([
  "declare",
  "namespace",
  "enum",
  "import",
  "from",
  "as",
  "export",
  "class",
  "interface",
  "infer",
  "extends",
  "implements",
  "override",
  "yield",
  "keyof",
  "int",
  "number",
  "numeric",
  "string",
  "boolean",
  "bigint",
  "long",
  "true",
  "false",
  "null",
  "undefined"
]);

const OPERATOR_SYMBOLS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "<<",
  ">>",
  ">>>",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "===",
  "!==",
  "&",
  "|",
  "^",
  "&&",
  "||",
  "??",
  "=",
  "+=",
  "-=",
  "%=",
  "*=",
  "/=",
  "&=",
  "|=",
  "&&=",
  "||=",
  "??=",
  "<<=",
  ">>=",
  ">>>=",
  "!",
  "~",
  "++",
  "--",
  "?",
  ":",
  "...",
  "..<",
  ".."
]);

interface DocumentRange {
  start: Position;
  end: Position;
}

interface SemanticTokenParams {
  text: string;
  ast?: Program | null;
  analysis?: Analysis | null;
  range?: DocumentRange;
  tokenModifiersByRangeKey?: ReadonlyMap<string, number>;
}

export function semanticTokenRangeKey(range: SourceRange): string {
  return `${range.start.offset}:${range.end.offset}`;
}

function identifierRangeKey(identifier: Identifier): string | null {
  if (!identifier.firstToken || !identifier.lastToken) {
    return null;
  }
  return `${identifier.firstToken.range.start.offset}:${identifier.lastToken.range.end.offset}`;
}

function markIdentifier(
  kinds: Map<string, TokenTypeName>,
  identifier: Identifier | undefined,
  tokenType: TokenTypeName
): void {
  if (!identifier) {
    return;
  }
  const key = identifierRangeKey(identifier);
  if (!key) {
    return;
  }
  kinds.set(key, tokenType);
}

function markTypeAnnotation(kinds: Map<string, TokenTypeName>, typeAnnotation?: Identifier): void {
  if (!typeAnnotation) {
    return;
  }
  markIdentifier(kinds, typeAnnotation, "type");
}

function isPascalCaseIdentifier(identifier: Identifier | undefined): boolean {
  return identifier !== undefined && /^[A-Z]/.test(identifier.name);
}

function collectIdentifierKindsFromAst(program: Program): Map<string, TokenTypeName> {
  const kinds = new Map<string, TokenTypeName>();

  const visitVarDeclarator = (declaration: VarDeclarator): void => {
    for (const identifier of bindingIdentifiers(declaration.name)) markIdentifier(kinds, identifier, "variable");
    for (const element of bindingElements(declaration.name)) {
      if (element.propertyName?.kind === "Identifier") {
        markIdentifier(kinds, element.propertyName, "property");
      }
      if (element.initializer) visitExpression(element.initializer);
    }
    markTypeAnnotation(kinds, declaration.typeAnnotation);
    if (declaration.initializer) {
      visitExpression(declaration.initializer);
    }
  };

  const visitParameter = (parameter: FunctionParameter): void => {
    for (const identifier of bindingIdentifiers(parameter.name)) markIdentifier(kinds, identifier, "parameter");
    for (const element of bindingElements(parameter.name)) {
      if (element.propertyName?.kind === "Identifier") {
        markIdentifier(kinds, element.propertyName, "property");
      }
      if (element.initializer) visitExpression(element.initializer);
    }
    markTypeAnnotation(kinds, parameter.typeAnnotation);
    if (parameter.defaultValue) {
      visitExpression(parameter.defaultValue);
    }
  };

  const visitClassMember = (member: ClassFieldMember | ClassMethodMember): void => {
    if (member.kind === "ClassFieldMember") {
      markIdentifier(kinds, member.name, "property");
      markTypeAnnotation(kinds, member.typeAnnotation);
      if (member.initializer) {
        visitExpression(member.initializer);
      }
      return;
    }

    markIdentifier(kinds, member.name, "method");
    for (const parameter of member.parameters) {
      if (member.name.name === "constructor" && (parameter.accessModifier !== undefined || parameter.readonly === true)) {
        if (parameter.name.kind === "Identifier") markIdentifier(kinds, parameter.name, "property");
        markTypeAnnotation(kinds, parameter.typeAnnotation);
        if (parameter.defaultValue) {
          visitExpression(parameter.defaultValue);
        }
      } else {
        visitParameter(parameter);
      }
    }
    markTypeAnnotation(kinds, member.returnType);
    visitBlock(member.body);
  };

  const visitBlock = (block: BlockStatement): void => {
    for (const statement of block.body) {
      visitStatement(statement);
    }
  };

  const visitCatchClause = (catchClause: CatchClause): void => {
    if (catchClause.parameter) {
      markIdentifier(kinds, catchClause.parameter, "parameter");
    }
    visitBlock(catchClause.body);
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "ExportStatement": {
        const exportStatement = statement as ExportStatement;
        if (exportStatement.namespaceExport) {
          markIdentifier(kinds, exportStatement.namespaceExport, "namespace");
        }
        for (const specifier of exportStatement.specifiers ?? []) {
          if (specifier.local) {
            markIdentifier(kinds, specifier.local, "variable");
          }
          markIdentifier(kinds, specifier.exported, "variable");
        }
        if (exportStatement.declaration) {
          visitStatement(exportStatement.declaration);
        }
        return;
      }
      case "ImportStatement": {
        const importStatement = statement as ImportStatement;
        if (importStatement.defaultImport) {
          markIdentifier(kinds, importStatement.defaultImport, "variable");
        }
        if (importStatement.namespaceImport) {
          markIdentifier(kinds, importStatement.namespaceImport, "namespace");
        }
        for (const specifier of importStatement.specifiers) {
          const importedType: TokenTypeName = specifier.typeOnly || importStatement.typeOnly
            ? "type"
            : isPascalCaseIdentifier(specifier.imported)
              ? "class"
              : "variable";
          markIdentifier(kinds, specifier.imported, importedType);
          if (specifier.local) {
            markIdentifier(kinds, specifier.local, importedType);
          }
        }
        return;
      }
      case "NamespaceStatement": {
        const namespaceStatement = statement as NamespaceStatement;
        for (const name of namespaceStatement.names ?? []) {
          markIdentifier(kinds, name, "namespace");
        }
        visitBlock(namespaceStatement.body);
        return;
      }
      case "VarStatement": {
        const variableStatement = statement as VarStatement;
        if (variableStatement.declarations && variableStatement.declarations.length > 0) {
          for (const declaration of variableStatement.declarations) {
            visitVarDeclarator(declaration);
          }
        } else {
          for (const identifier of bindingIdentifiers(variableStatement.name)) markIdentifier(kinds, identifier, "variable");
          for (const element of bindingElements(variableStatement.name)) {
            if (element.propertyName?.kind === "Identifier") {
              markIdentifier(kinds, element.propertyName, "property");
            }
            if (element.initializer) visitExpression(element.initializer);
          }
          markTypeAnnotation(kinds, variableStatement.typeAnnotation);
          if (variableStatement.initializer) {
            visitExpression(variableStatement.initializer);
          }
        }
        return;
      }
      case "FunctionStatement": {
        const functionStatement = statement as FunctionStatement;
        markIdentifier(kinds, functionStatement.name, "function");
        for (const parameter of functionStatement.parameters) {
          visitParameter(parameter);
        }
        markTypeAnnotation(kinds, functionStatement.returnType);
        visitBlock(functionStatement.body);
        return;
      }
      case "ClassStatement": {
        const classStatement = statement as ClassStatement;
        markIdentifier(kinds, classStatement.name, "class");
        for (const parameter of classStatement.primaryConstructorParameters ?? []) {
          if (parameter.name.kind === "Identifier") markIdentifier(kinds, parameter.name, "property");
          markTypeAnnotation(kinds, parameter.typeAnnotation);
          if (parameter.defaultValue) {
            visitExpression(parameter.defaultValue);
          }
        }
        for (const member of classStatement.members) {
          visitClassMember(member);
        }
        return;
      }
      case "EnumStatement": {
        const enumStatement = statement as EnumStatement;
        markIdentifier(kinds, enumStatement.name, "class");
        for (const member of enumStatement.members) {
          markIdentifier(kinds, member.name, "enumMember");
          if (member.initializer) {
            visitExpression(member.initializer);
          }
        }
        return;
      }
      case "ExprStatement":
        visitExpression((statement as ExprStatement).expression);
        return;
      case "BlockStatement":
        visitBlock(statement as BlockStatement);
        return;
      case "WhileStatement": {
        const whileStatement = statement as WhileStatement;
        visitExpression(whileStatement.condition);
        visitStatement(whileStatement.body);
        return;
      }
      case "WithStatement": {
        const withStatement = statement as WithStatement;
        visitExpression(withStatement.object);
        visitStatement(withStatement.body);
        return;
      }
      case "LabeledStatement": {
        const labeled = statement as LabeledStatement;
        markIdentifier(kinds, labeled.label, "variable");
        visitStatement(labeled.body);
        return;
      }
      case "DoWhileStatement": {
        const doWhileStatement = statement as DoWhileStatement;
        visitStatement(doWhileStatement.body);
        visitExpression(doWhileStatement.condition);
        return;
      }
      case "ForStatement": {
        const forStatement = statement as ForStatement;
        if (forStatement.iterationKind && forStatement.iterator && forStatement.iterable) {
          if (forStatement.iterator.kind === "VarStatement") {
            visitStatement(forStatement.iterator as VarStatement);
          } else if (forStatement.iterator.kind === "Identifier") {
            markIdentifier(kinds, forStatement.iterator as Identifier, "variable");
          } else {
            visitExpression(forStatement.iterator as Expr);
          }
          visitExpression(forStatement.iterable);
          visitStatement(forStatement.body);
          return;
        }

        if (forStatement.initializer) {
          if (forStatement.initializer.kind === "VarStatement") {
            visitStatement(forStatement.initializer as VarStatement);
          } else {
            visitExpression(forStatement.initializer as Expr);
          }
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
      case "IfStatement": {
        const ifStatement = statement as IfStatement;
        visitExpression(ifStatement.condition);
        visitStatement(ifStatement.thenBranch);
        if (ifStatement.elseBranch) {
          visitStatement(ifStatement.elseBranch);
        }
        return;
      }
      case "SwitchStatement": {
        const switchStatement = statement as SwitchStatement;
        visitExpression(switchStatement.discriminant);
        for (const switchCase of switchStatement.cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const consequent of switchCase.consequent) {
            visitStatement(consequent);
          }
        }
        return;
      }
      case "ReturnStatement": {
        const returnStatement = statement as ReturnStatement;
        if (returnStatement.expression) {
          visitExpression(returnStatement.expression);
        }
        return;
      }
      case "ThrowStatement":
        visitExpression((statement as ThrowStatement).expression);
        return;
      case "DeferStatement":
        visitExpression((statement as import("compiler/ast/ast").DeferStatement).expression);
        return;
      case "TryStatement": {
        const tryStatement = statement as TryStatement;
        visitBlock(tryStatement.tryBlock);
        if (tryStatement.catchClause) {
          visitCatchClause(tryStatement.catchClause);
        }
        if (tryStatement.finallyBlock) {
          visitBlock(tryStatement.finallyBlock);
        }
        return;
      }
      default:
        return;
    }
  };

  const visitObjectProperty = (property: ObjectProperty): void => {
    if (!property.computed && property.key.kind === "Identifier") {
      markIdentifier(kinds, property.key as Identifier, property.method ? "method" : "property");
    } else {
      visitExpression(property.key);
    }
    if (property.method && property.value.kind === "FunctionExpression") {
      const fn = property.value as FunctionExpression;
      for (const parameter of fn.parameters) {
        visitParameter(parameter);
      }
      markTypeAnnotation(kinds, fn.returnType);
      visitBlock(fn.body);
      return;
    }
    visitExpression(property.value);
  };

  const visitCallCallee = (callee: Expr, identifierType: TokenTypeName): void => {
    if (callee.kind === "Identifier") {
      const identifier = callee as Identifier;
      markIdentifier(kinds, identifier, isPascalCaseIdentifier(identifier) ? "class" : identifierType);
      return;
    }
    if (callee.kind === "MemberExpression") {
      const member = callee as MemberExpression;
      visitExpression(member.object);
      if (member.computed) {
        visitExpression(member.property);
      } else if (member.property.kind === "Identifier") {
        markIdentifier(kinds, member.property as Identifier, "method");
      } else {
        visitExpression(member.property);
      }
      return;
    }
    visitExpression(callee);
  };

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "Identifier":
      case "IntLiteral":
      case "FloatLiteral":
      case "BigIntLiteral":
      case "LongLiteral":
      case "StringLiteral":
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression": {
        const assertion = expression as AsExpression;
        visitExpression(assertion.expression);
        markTypeAnnotation(kinds, assertion.typeAnnotation);
        return;
      }
      case "NonNullExpression":
        visitExpression((expression as NonNullExpression).expression);
        return;
      case "BinaryExpression": {
        const binary = expression as BinaryExpression;
        visitExpression(binary.left);
        visitExpression(binary.right);
        return;
      }
      case "RangeExpression": {
        const range = expression as RangeExpression;
        visitExpression(range.start);
        visitExpression(range.end);
        return;
      }
      case "ChainExpression": {
        const chain = expression as ChainExpression;
        visitExpression(chain.receiver);
        for (const operation of chain.operations) {
          visitExpression(operation);
        }
        return;
      }
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
        visitExpression(assignment.left);
        visitExpression(assignment.right);
        return;
      }
      case "ConditionalExpression": {
        const conditional = expression as ConditionalExpression;
        visitExpression(conditional.test);
        visitExpression(conditional.consequent);
        visitExpression(conditional.alternate);
        return;
      }
      case "MemberExpression": {
        const member = expression as MemberExpression;
        visitExpression(member.object);
        if (member.computed) {
          visitExpression(member.property);
        } else if (member.property.kind === "Identifier") {
          markIdentifier(kinds, member.property as Identifier, "property");
        } else {
          visitExpression(member.property);
        }
        return;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        visitCallCallee(call.callee, "function");
        for (const argument of call.arguments) {
          visitExpression(argument);
        }
        return;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        visitCallCallee(newExpression.callee, "class");
        for (const argument of newExpression.arguments ?? []) {
          visitExpression(argument);
        }
        return;
      }
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
            visitObjectProperty(property);
          }
        }
        return;
      case "FunctionExpression": {
        const fn = expression as FunctionExpression;
        if (fn.name) {
          markIdentifier(kinds, fn.name, "function");
        }
        for (const parameter of fn.parameters) {
          visitParameter(parameter);
        }
        markTypeAnnotation(kinds, fn.returnType);
        visitBlock(fn.body);
        return;
      }
      case "ArrowFunctionExpression": {
        const arrow = expression as ArrowFunctionExpression;
        for (const parameter of arrow.parameters) {
          visitParameter(parameter);
        }
        if (arrow.body.kind === "BlockStatement") {
          visitBlock(arrow.body as BlockStatement);
        } else {
          visitExpression(arrow.body as Expr);
        }
        return;
      }
      default:
        return;
    }
  };

  for (const statement of program.body) {
    visitStatement(statement);
  }

  return kinds;
}

function sameRange(
  left: { start: Position; end: Position },
  right: { start: Position; end: Position }
): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function tokenTypeFromAnalysis(token: Token, analysis: Analysis): TokenTypeName | null {
  if (token.type !== "identifier") {
    return null;
  }
  const length = Math.max(1, token.range.end.column - token.range.start.column);
  const queryCharacter = token.range.start.column + Math.floor((length - 1) / 2);
  const match = analysis.getSymbolAt(token.range.start.line, queryCharacter);
  if (!match) {
    return null;
  }
  if (
    !sameRange(match.range, {
      start: {
        line: token.range.start.line,
        character: token.range.start.column
      },
      end: {
        line: token.range.end.line,
        character: token.range.end.column
      }
    })
  ) {
    return null;
  }
  switch (match.symbol.kind) {
    case "parameter":
      return "parameter";
    case "function":
      return "function";
    case "class":
      return "class";
    case "method":
      return "method";
    case "variable":
    default:
      return "variable";
  }
}

function intersectsRange(tokenRange: SourceRange, queryRange?: DocumentRange): boolean {
  if (!queryRange) {
    return true;
  }
  const tokenStart: Position = {
    line: tokenRange.start.line,
    character: tokenRange.start.column
  };
  const tokenEnd: Position = {
    line: tokenRange.end.line,
    character: tokenRange.end.column
  };

  if (comparePosition(tokenEnd, queryRange.start) <= 0) {
    return false;
  }
  if (comparePosition(tokenStart, queryRange.end) >= 0) {
    return false;
  }
  return true;
}

function classifyToken(
  token: Token,
  identifierKinds: Map<string, TokenTypeName>,
  analysis?: Analysis | null
): TokenTypeName | null {
  if (token.type === "number") {
    return "number";
  }
  if (token.type === "string" || token.type === "regexp") {
    return "string";
  }
  if (token.type === "symbol") {
    return OPERATOR_SYMBOLS.has(token.value) ? "operator" : null;
  }
  if (token.type !== "identifier") {
    return null;
  }
  if (CONTROL_KEYWORDS.has(token.value)) {
    return "keywordControl";
  }
  if (MODIFIER_KEYWORDS.has(token.value)) {
    return "keywordModifier";
  }
  if (FUNCTION_KEYWORDS.has(token.value)) {
    return "keywordFunction";
  }
  if (TYPE_KEYWORDS.has(token.value)) {
    return "keywordType";
  }
  if (token.value === "is") {
    return "keyword";
  }

  const astKind = identifierKinds.get(semanticTokenRangeKey(token.range));
  if (astKind) {
    return astKind;
  }

  if (analysis) {
    const symbolKind = tokenTypeFromAnalysis(token, analysis);
    if (symbolKind) {
      return symbolKind;
    }
  }

  return "variable";
}

export function createSemanticTokens(params: SemanticTokenParams): SemanticTokens {
  let tokens: Token[] = [];
  try {
    tokens = tokenize(params.text);
  } catch {
    return { data: [] };
  }
  const identifierKinds = params.ast ? collectIdentifierKindsFromAst(params.ast) : new Map();
  const builder = new SimpleSemanticTokensBuilder();

  for (const token of tokens) {
    if (token.type === "eof") {
      continue;
    }
    if (!intersectsRange(token.range, params.range)) {
      continue;
    }

    const tokenType = classifyToken(token, identifierKinds, params.analysis);
    if (!tokenType) {
      continue;
    }

    const line = token.range.start.line;
    const character = token.range.start.column;
    const length = token.range.end.column - token.range.start.column;
    if (length <= 0) {
      continue;
    }

    const tokenModifiers = params.tokenModifiersByRangeKey?.get(semanticTokenRangeKey(token.range)) ?? 0;
    builder.push(line, character, length, TOKEN_TYPE_INDEX[tokenType], tokenModifiers);
  }

  return builder.build();
}
