import { CompletionItemKind } from "vscode-languageserver/node.js";
import type { CompletionItem } from "vscode-languageserver/node.js";
import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassMethodMember,
  ClassStatement,
  ConditionalExpression,
  DoWhileStatement,
  Expr,
  ForStatement,
  FunctionStatement,
  IfStatement,
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
  WhileStatement
} from "compiler/ast/ast";
import { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/Analysis";
import { baseTypeName } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
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
  prefix: string;
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
  return {
    objectPath: objectPath.replace(/\s+/g, ""),
    objectStartCharacter,
    prefix: typedPrefix
  };
}

function buildClassMemberCompletionItems(
  classStatement: ClassStatement,
  objectTypeName: string | undefined,
  prefix: string,
  resolverContext: {
    ast: Program;
    options: ClassResolverOptions;
    cache: ClassResolverCache;
  }
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const normalizedPrefix = prefix.trim();

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
        detail: `Class property: ${resolved.typeName}`
      });
      continue;
    }

    pushItem({
      label: memberName,
      kind: CompletionItemKind.Method,
      detail: resolved.signature
        ? `Class method: (${resolved.signature.parameters.map((parameter) => `${parameter.name}: ${parameter.typeName}`).join(", ")}) => ${resolved.signature.returnTypeName}`
        : "Class method"
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
            const declarationLine = declaration.name.firstToken?.range.start.line ?? -1;
            considerDeclaration(declaration.name.name, declaration.initializer, declarationLine);
          }
        } else {
          const declarationLine = varStatement.name.firstToken?.range.start.line ?? -1;
          considerDeclaration(varStatement.name.name, varStatement.initializer, declarationLine);
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

  const symbolMatch = analysis.getSymbolAt(line, Math.max(0, objectStartCharacter));
  let currentTypeName: string | null = null;

  const resolvedSymbolMatch = symbolMatch;
  if (resolvedSymbolMatch && resolvedSymbolMatch.symbol.name === pathSegments[0]) {
    currentTypeName = typeNameFromSymbol(resolvedSymbolMatch.symbol);
  } else {
    const visibleSymbols = analysis.getVisibleSymbolsAt(line, objectStartCharacter);
    const symbol = visibleSymbols.find((candidate) => candidate.name === pathSegments[0]);
    if (!symbol) {
      return null;
    }
    currentTypeName = typeNameFromSymbol(symbol);
  }

  if (!currentTypeName || currentTypeName === "unknown") {
    const firstSegment = pathSegments[0];
    if (firstSegment) {
      currentTypeName = inferClassNameFromAstVariableInitializer(ast, firstSegment, line);
    }
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

function buildMemberAccessCompletions(
  ast: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: CompletionRequestOptions
): CompletionItem[] | null {
  const target = parseMemberAccessTarget(options.text, line, character);
  if (!target) {
    return null;
  }

  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  const resolverCache = createClassResolverCache();
  const pathSegments = target.objectPath.split(".");
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
    return null;
  }

  const classStatement = resolveClassStatementAcrossFiles(
    ast,
    baseTypeName(className),
    resolverOptions,
    resolverCache
  )?.classStatement;
  if (!classStatement) {
    return null;
  }

  return buildClassMemberCompletionItems(classStatement, className, target.prefix, {
    ast,
    options: resolverOptions,
    cache: resolverCache
  });
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
