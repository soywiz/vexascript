import { CompletionItemKind } from "vscode-languageserver/node.js";
import type { CompletionItem } from "vscode-languageserver/node.js";
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
  LabeledStatement,
  MemberExpression,
  NewExpression,
  NamespaceStatement,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  TypeAnnotation,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import { compileSource } from "compiler/pipeline/compile";
import type { AutoImportSuggestion } from "./importFixes";
import {
  createClassResolverCache,
  resolveCallableSignature,
  resolveClassMember,
  resolveClassMemberNames,
  resolveClassStatementAcrossFiles,
  resolveConstructorSignature,
  type ClassResolverCache,
  type ClassResolverOptions
} from "./classResolver";

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
  getSessionForFilePath?: (filePath: string) => CompletionSessionLike | null;
}

interface MemberAccessTarget {
  objectPath: string;
  objectStartCharacter: number;
  memberAccessStartCharacter: number;
  prefix: string;
}

const COMPLETION_RECOVERY_MEMBER = "__mylang_completion__";

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
  const match = /([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\.\s*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(uptoCursor);
  if (!match || !match[1]) {
    return null;
  }
  const fullMatch = match[0];
  const objectPath = match[1];
  const typedPrefix = match[2] ?? "";
  const objectInMatchIndex = fullMatch.indexOf(objectPath);
  const objectStartCharacter = match.index + (objectInMatchIndex >= 0 ? objectInMatchIndex : 0);
  const memberAccessStartCharacter = match.index + fullMatch.lastIndexOf(".");
  return {
    objectPath: objectPath.replace(/\s+/g, ""),
    objectStartCharacter,
    memberAccessStartCharacter,
    prefix: typedPrefix
  };
}

function buildClassMemberCompletionItems(
  classStatement: ClassStatement,
  objectTypeName: string | undefined,
  prefix: string,
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
): CompletionItem[] {
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

  const memberNames = resolveClassMemberNames(classStatement, objectTypeName, {
    ast: resolverContext.ast,
    options: resolverContext.options,
    cache: resolverContext.cache
  });
  for (const memberName of memberNames) {
    const resolved = resolveClassMember(classStatement, memberName, objectTypeName, {
      ast: resolverContext.ast,
      options: resolverContext.options,
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

function classResolverOptionsFromCompletionOptions(options: CompletionRequestOptions): ClassResolverOptions {
  return {
    ...(options.uri ? { uri: options.uri } : {}),
    ...(options.sourceRoots ? { sourceRoots: options.sourceRoots } : {}),
    ...(options.getSessionForFilePath
      ? { getSessionForFilePath: options.getSessionForFilePath }
      : {})
  };
}

function nodeRange(node: {
  firstToken?: { range: { start: { line: number; column: number } } };
  lastToken?: { range: { end: { line: number; column: number } } };
}): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
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
    if (!range || !rangeContainsPosition(range, { line, character })) {
      return;
    }
    const size = rangeSize(range);
    if (!best || size < best.size) {
      best = { identifier, size };
    }
  });
  return best ? best.identifier : null;
}

function comparePosition(
  a: { line: number; character: number },
  b: { line: number; character: number }
): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

function rangeContainsPosition(
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  position: { line: number; character: number }
): boolean {
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0;
}

function rangeSize(range: { start: { line: number; character: number }; end: { line: number; character: number } }): number {
  const lineSpan = range.end.line - range.start.line;
  if (lineSpan > 0) {
    return lineSpan * 100000 + (range.end.character - range.start.character);
  }
  return range.end.character - range.start.character;
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
      if (!argumentRange || !rangeContainsPosition(argumentRange, position)) {
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

function inferExpectedTypeForPosition(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): string | null {
  const context = findArgumentCompletionContext(ast, line, character);
  if (!context) {
    return null;
  }

  if (context.kind === "call") {
    const signature = resolveCallableSignature(
      context.callee,
      analysis,
      ast,
      classResolverOptionsFromCompletionOptions(options)
    );
    return signature?.parameters[context.argumentIndex]?.typeName ?? null;
  }

  const constructorSignature = resolveConstructorSignature(
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

function inferTypeNameFromAstVariableAnnotation(
  ast: Program,
  variableName: string,
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
    if (name !== variableName || declarationLine > line) {
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
        for (const member of (statement as ClassStatement).members) {
          if (member.kind === "ClassMethodMember") {
            visitStatements(member.body.body);
          }
        }
      }
    }
  };

  visitStatements(ast.body);
  return bestTypeName;
}

function resolveTypeNameFromPath(
  ast: Program,
  analysis: Analysis,
  pathSegments: string[],
  line: number,
  objectStartCharacter: number,
  resolverOptions: ClassResolverOptions,
  resolverCache: ClassResolverCache
): string | null {
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
    if (expressionTypeName && expressionTypeName !== "unknown") {
      return expressionTypeName;
    }
    const annotatedTypeName = inferTypeNameFromAstVariableAnnotation(ast, identifierAtCursor.name, line);
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

  const resolvedSymbolMatch = symbolMatch;
  if (resolvedSymbolMatch && resolvedSymbolMatch.symbol.name === firstSegment) {
    currentTypeName = typeNameFromSymbol(resolvedSymbolMatch.symbol);
  } else {
    const visibleSymbols = analysis.getVisibleSymbolsAt(line, objectStartCharacter);
    const symbol = visibleSymbols.find((candidate) => candidate.name === firstSegment);
    if (!symbol) {
      currentTypeName =
        inferTypeNameFromAstVariableAnnotation(ast, firstSegment, line) ??
        inferClassNameFromAstVariableInitializer(ast, firstSegment, line);
      if (!currentTypeName) {
        return null;
      }
    } else {
      currentTypeName = typeNameFromSymbol(symbol);
    }
  }

  if (!currentTypeName || currentTypeName === "unknown") {
    currentTypeName =
      inferTypeNameFromAstVariableAnnotation(ast, firstSegment, line) ??
      inferClassNameFromAstVariableInitializer(ast, firstSegment, line);
  }
  for (let index = 1; index < pathSegments.length; index += 1) {
    const memberName = pathSegments[index];
    if (!memberName || !currentTypeName) {
      return null;
    }
    const classResolution = resolveClassStatementAcrossFiles(
      ast,
      baseTypeName(currentTypeName),
      resolverOptions,
      resolverCache
    );
    if (!classResolution) {
      return null;
    }
    const member = resolveClassMember(classResolution.classStatement, memberName, currentTypeName, {
      ast,
      options: resolverOptions,
      cache: resolverCache
    });
    if (!member) {
      return null;
    }
    if (member.kind === "method") {
      currentTypeName = member.signature?.returnTypeName ?? null;
    } else {
      currentTypeName = member.typeName;
    }
  }

  return currentTypeName;
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

function buildMemberAccessCompletions(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions,
  allowRecovery = true
): CompletionItem[] | null {
  const target = parseMemberAccessTarget(options.text, line, character);
  if (!target) {
    return null;
  }

  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const resolverCache = createClassResolverCache();
  const pathSegments = target.objectPath.split(".");
  const namespaceStatement = findNamespaceByPath(ast, pathSegments);
  if (namespaceStatement) {
    return buildNamespaceMemberCompletionItems(namespaceStatement, target.prefix);
  }
  const className = resolveTypeNameFromPath(
    ast,
    analysis,
    pathSegments,
    line,
    target.objectStartCharacter,
    resolverOptions,
    resolverCache
  );
  if (!className) {
    return allowRecovery ? buildRecoveredMemberAccessCompletions(line, character, options) : null;
  }

  const classStatement = resolveClassStatementAcrossFiles(
    ast,
    baseTypeName(className),
    resolverOptions,
    resolverCache
  )?.classStatement;
  if (!classStatement) {
    return allowRecovery ? buildRecoveredMemberAccessCompletions(line, character, options) : null;
  }

  const items = buildClassMemberCompletionItems(
    classStatement,
    className,
    target.prefix,
    {
      line,
      dotCharacter: target.memberAccessStartCharacter,
      prefixEndCharacter: character
    },
    {
      ast,
      options: resolverOptions,
      cache: resolverCache
    }
  );
  if (items.length > 0 || !allowRecovery) {
    return items;
  }
  return buildRecoveredMemberAccessCompletions(line, character, options);
}

function recoverSourceForMemberAccessCompletion(
  text: string,
  line: number,
  character: number
): string | null {
  const target = parseMemberAccessTarget(text, line, character);
  if (!target) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (lineText === undefined) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  lines[line] =
    lineText.slice(0, clampedCharacter) +
    COMPLETION_RECOVERY_MEMBER +
    lineText.slice(clampedCharacter);
  return lines.join("\n");
}

function buildRecoveredMemberAccessCompletions(
  line: number,
  character: number,
  options: CompletionRequestOptions
): CompletionItem[] | null {
  if (!options.text) {
    return null;
  }
  const recoveredSource = recoverSourceForMemberAccessCompletion(options.text, line, character);
  if (!recoveredSource || recoveredSource === options.text) {
    return null;
  }
  const recovered = compileSource(recoveredSource);
  if (!recovered.ast || !recovered.analysis) {
    return null;
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

export function createCompletionItemsForPosition(
  ast: Program,
  line: number,
  character: number,
  analysis?: Analysis | null,
  autoImportSuggestions: AutoImportSuggestion[] = [],
  options: CompletionRequestOptions = {}
): CompletionItem[] {
  const resolvedAnalysis = analysis ?? new Analysis(ast);
  const memberCompletions = buildMemberAccessCompletions(
    ast,
    resolvedAnalysis,
    line,
    character,
    options
  );
  if (memberCompletions && memberCompletions.length > 0) {
    return memberCompletions;
  }

  const visibleSymbols = resolvedAnalysis.getVisibleSymbolsAt(line, character);
  const expectedTypeName = inferExpectedTypeForPosition(
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
      kindPriority: symbolKindPriority(symbol)
    }))
    .sort((left, right) => {
      if (left.typeRelevance !== right.typeRelevance) {
        return right.typeRelevance - left.typeRelevance;
      }
      if (left.scopeDistance !== right.scopeDistance) {
        return left.scopeDistance - right.scopeDistance;
      }
      if (left.kindPriority !== right.kindPriority) {
        return left.kindPriority - right.kindPriority;
      }
      return left.symbol.name.localeCompare(right.symbol.name);
    });

  const items: CompletionItem[] = KEYWORD_COMPLETIONS.map((item, index) => ({
    ...item,
    sortText: `9-${String(index).padStart(4, "0")}-${item.label}`
  }));
  const seenLabels = new Set(items.map((item) => item.label));
  for (let index = 0; index < rankedSymbols.length; index += 1) {
    const entry = rankedSymbols[index]!;
    const symbol = entry.symbol;
    seenLabels.add(symbol.name);
    items.push({
      label: symbol.name,
      kind: symbolKindToCompletionKind(symbol),
      detail: symbolDetail(symbol),
      sortText: `1-${entry.typeRelevance}-${String(entry.scopeDistance).padStart(4, "0")}-${String(index).padStart(4, "0")}-${symbol.name}`
    });
  }

  for (const suggestion of autoImportSuggestions) {
    if (seenLabels.has(suggestion.symbol.name)) {
      continue;
    }
    seenLabels.add(suggestion.symbol.name);

    let kind: CompletionItemKind = CompletionItemKind.Variable;
    if (suggestion.symbol.kind === "class") {
      kind = CompletionItemKind.Class;
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

  return items;
}

export function createKeywordOnlyCompletionItems(): CompletionItem[] {
  return [...KEYWORD_COMPLETIONS];
}
