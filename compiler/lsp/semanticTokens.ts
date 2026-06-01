import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  CatchClause,
  ClassFieldMember,
  ClassMethodMember,
  ClassStatement,
  ConditionalExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionParameter,
  FunctionStatement,
  Identifier,
  IfStatement,
  ImportStatement,
  MemberExpression,
  NewExpression,
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
  WhileStatement
} from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";
import type { SourceRange, Token } from "compiler/parser/tokenizer";
import { tokenize } from "compiler/parser/tokenizer";
import {
  SemanticTokensBuilder,
  type SemanticTokens,
  type SemanticTokensLegend
} from "vscode-languageserver/node.js";

const TOKEN_TYPES = [
  "keyword",
  "variable",
  "parameter",
  "function",
  "method",
  "class",
  "property",
  "type",
  "number",
  "string",
  "operator"
] as const;

type TokenTypeName = (typeof TOKEN_TYPES)[number];

const TOKEN_TYPE_INDEX: Record<TokenTypeName, number> = TOKEN_TYPES.reduce(
  (indexByType, tokenType, index) => {
    indexByType[tokenType] = index;
    return indexByType;
  },
  {} as Record<TokenTypeName, number>
);

export const MYLANG_SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: []
};

const KEYWORDS = new Set([
  "declare",
  "namespace",
  "import",
  "from",
  "as",
  "export",
  "class",
  "interface",
  "extends",
  "implements",
  "override",
  "fun",
  "function",
  "let",
  "var",
  "val",
  "const",
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
  "try",
  "catch",
  "finally",
  "new",
  "typeof",
  "void",
  "delete",
  "await",
  "instanceof",
  "int",
  "number",
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
  "..."
]);

interface Position {
  line: number;
  character: number;
}

interface DocumentRange {
  start: Position;
  end: Position;
}

interface SemanticTokenParams {
  text: string;
  ast?: Program | null;
  analysis?: Analysis | null;
  range?: DocumentRange;
}

function rangeKey(range: SourceRange): string {
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

function collectIdentifierKindsFromAst(program: Program): Map<string, TokenTypeName> {
  const kinds = new Map<string, TokenTypeName>();

  const visitVarDeclarator = (declaration: VarDeclarator): void => {
    markIdentifier(kinds, declaration.name, "variable");
    markTypeAnnotation(kinds, declaration.typeAnnotation);
    if (declaration.initializer) {
      visitExpression(declaration.initializer);
    }
  };

  const visitParameter = (parameter: FunctionParameter): void => {
    markIdentifier(kinds, parameter.name, "parameter");
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
      visitParameter(parameter);
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
      case "ImportStatement": {
        const importStatement = statement as ImportStatement;
        for (const specifier of importStatement.specifiers) {
          markIdentifier(kinds, specifier.imported, "variable");
        }
        return;
      }
      case "VarStatement": {
        const variableStatement = statement as VarStatement;
        if (variableStatement.declarations && variableStatement.declarations.length > 0) {
          for (const declaration of variableStatement.declarations) {
            visitVarDeclarator(declaration);
          }
        } else {
          markIdentifier(kinds, variableStatement.name, "variable");
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
          markIdentifier(kinds, parameter.name, "property");
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
    markIdentifier(kinds, property.key, "property");
    visitExpression(property.value);
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
        visitExpression(call.callee);
        for (const argument of call.arguments) {
          visitExpression(argument);
        }
        return;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        visitExpression(newExpression.callee);
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
          visitObjectProperty(property);
        }
        return;
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

function comparePosition(left: Position, right: Position): number {
  if (left.line !== right.line) {
    return left.line < right.line ? -1 : 1;
  }
  if (left.character !== right.character) {
    return left.character < right.character ? -1 : 1;
  }
  return 0;
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
  if (token.type === "string") {
    return "string";
  }
  if (token.type === "symbol") {
    return OPERATOR_SYMBOLS.has(token.value) ? "operator" : null;
  }
  if (token.type !== "identifier") {
    return null;
  }
  if (KEYWORDS.has(token.value)) {
    return "keyword";
  }

  const astKind = identifierKinds.get(rangeKey(token.range));
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
  const builder = new SemanticTokensBuilder();

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

    builder.push(line, character, length, TOKEN_TYPE_INDEX[tokenType], 0);
  }

  return builder.build();
}
