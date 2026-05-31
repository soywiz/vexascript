import { CompletionItemKind } from "vscode-languageserver/node.js";
import type { CompletionItem } from "vscode-languageserver/node.js";
import type {
  BlockStatement,
  ClassStatement,
  DoWhileStatement,
  Expr,
  ForStatement,
  FunctionStatement,
  IfStatement,
  Program
  ,
  Statement,
  SwitchStatement,
  TryStatement,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import { Analysis } from "compiler/analysis/Analysis";
import type { AnalysisSymbol } from "compiler/analysis/Analysis";
import type { AutoImportSuggestion } from "./importFixes";
import {
  resolveClassMember,
  resolveClassStatementAcrossFiles,
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
  prefix: string
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

  for (const parameter of classStatement.primaryConstructorParameters ?? []) {
    const resolved = resolveClassMember(classStatement, parameter.name.name);
    pushItem({
      label: parameter.name.name,
      kind: CompletionItemKind.Field,
      detail: `Class property: ${resolved?.typeName ?? "unknown"}`
    });
  }

  for (const member of classStatement.members) {
    const resolved = resolveClassMember(classStatement, member.name.name);
    if (member.kind === "ClassFieldMember") {
      pushItem({
        label: member.name.name,
        kind: CompletionItemKind.Field,
        detail: `Class property: ${resolved?.typeName ?? "unknown"}`
      });
      continue;
    }

    pushItem({
      label: member.name.name,
      kind: CompletionItemKind.Method,
      detail: resolved?.signature
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
  options: CompletionRequestOptions
): string | null {
  if (pathSegments.length === 0) {
    return null;
  }

  const symbolMatch = analysis.getSymbolAt(line, Math.max(0, objectStartCharacter));
  let currentTypeName: string | null = null;

  const resolvedSymbolMatch = symbolMatch;
  if (resolvedSymbolMatch && resolvedSymbolMatch.symbol.name === pathSegments[0]) {
    if (resolvedSymbolMatch.symbol.type?.kind === "named") {
      currentTypeName = resolvedSymbolMatch.symbol.type.name;
    } else if (resolvedSymbolMatch.symbol.type?.kind === "builtin") {
      currentTypeName = resolvedSymbolMatch.symbol.type.name;
    }
  } else {
    const visibleSymbols = analysis.getVisibleSymbolsAt(line, objectStartCharacter);
    const symbol = visibleSymbols.find((candidate) => candidate.name === pathSegments[0]);
    if (!symbol) {
      return null;
    }
    if (symbol.type?.kind === "named") {
      currentTypeName = symbol.type.name;
    } else if (symbol.type?.kind === "builtin") {
      currentTypeName = symbol.type.name;
    }
  }

  if (!currentTypeName || currentTypeName === "unknown") {
    const firstSegment = pathSegments[0];
    if (firstSegment) {
      currentTypeName = inferClassNameFromAstVariableInitializer(ast, firstSegment, line);
    }
  }

  const resolverOptions = classResolverOptionsFromCompletionOptions(options);
  for (let index = 1; index < pathSegments.length; index += 1) {
    const memberName = pathSegments[index];
    if (!memberName || !currentTypeName) {
      return null;
    }
    const classResolution = resolveClassStatementAcrossFiles(ast, currentTypeName, resolverOptions);
    if (!classResolution) {
      return null;
    }
    const member = resolveClassMember(classResolution.classStatement, memberName);
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

  const pathSegments = target.objectPath.split(".");
  const className = resolveTypeNameFromPath(
    ast,
    analysis,
    pathSegments,
    line,
    target.objectStartCharacter,
    options
  );
  if (!className) {
    return null;
  }

  const classStatement = resolveClassStatementAcrossFiles(
    ast,
    className,
    classResolverOptionsFromCompletionOptions(options)
  )?.classStatement;
  if (!classStatement) {
    return null;
  }

  return buildClassMemberCompletionItems(classStatement, target.prefix);
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

  const items: CompletionItem[] = [...KEYWORD_COMPLETIONS];
  const seenLabels = new Set(items.map((item) => item.label));
  for (const symbol of visibleSymbols) {
    seenLabels.add(symbol.name);
    items.push({
      label: symbol.name,
      kind: symbolKindToCompletionKind(symbol),
      detail: symbolDetail(symbol)
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
