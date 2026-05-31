import { CompletionItemKind } from "vscode-languageserver/node.js";
import type { CompletionItem } from "vscode-languageserver/node.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type {
  BlockStatement,
  ClassStatement,
  DoWhileStatement,
  Expr,
  ForStatement,
  FunctionStatement,
  Identifier,
  IfStatement,
  ImportStatement,
  NewExpression,
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
import { compileSource } from "compiler/pipeline/compile";
import { uriToFilePath } from "./importFixes";

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
  objectName: string;
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
  const match = /([A-Za-z_][A-Za-z0-9_]*)\.\s*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(uptoCursor);
  if (!match || !match[1]) {
    return null;
  }
  const fullMatch = match[0];
  const objectName = match[1];
  const typedPrefix = match[2] ?? "";
  const objectInMatchIndex = fullMatch.indexOf(objectName);
  const objectStartCharacter = match.index + (objectInMatchIndex >= 0 ? objectInMatchIndex : 0);
  return {
    objectName,
    objectStartCharacter,
    prefix: typedPrefix
  };
}

function findClassStatementInProgram(ast: Program, className: string): ClassStatement | null {
  for (const statement of ast.body) {
    if (statement.kind !== "ClassStatement") {
      continue;
    }
    const classStatement = statement as ClassStatement;
    if (classStatement.name.name === className) {
      return classStatement;
    }
  }
  return null;
}

function resolveImportTargetFilePath(importerFilePath: string, importPath: string): string | null {
  const baseDir = dirname(importerFilePath);
  const direct = resolve(baseDir, importPath);
  if (existsSync(direct)) {
    return direct;
  }
  if (!extname(direct)) {
    const withMyExt = `${direct}.my`;
    if (existsSync(withMyExt)) {
      return withMyExt;
    }
  }
  return null;
}

function getSessionForFilePath(
  filePath: string,
  options: CompletionRequestOptions
): CompletionSessionLike | null {
  if (options.getSessionForFilePath) {
    const fromProvider = options.getSessionForFilePath(filePath);
    if (fromProvider) {
      return fromProvider;
    }
  }
  if (!existsSync(filePath)) {
    return null;
  }
  const source = readFileSync(filePath, "utf8");
  const compiled = compileSource(source);
  return {
    ast: compiled.ast,
    analysis: compiled.analysis
  };
}

function scanMyFiles(sourceRoots: string[]): string[] {
  const files: string[] = [];
  const stack = [...sourceRoots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".my") {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function resolveClassStatement(
  ast: Program,
  className: string,
  options: CompletionRequestOptions
): ClassStatement | null {
  const local = findClassStatementInProgram(ast, className);
  if (local) {
    return local;
  }

  const currentFilePath = options.uri ? uriToFilePath(options.uri) : null;
  if (currentFilePath) {
    for (const statement of ast.body) {
      if (statement.kind !== "ImportStatement") {
        continue;
      }
      const importStatement = statement as ImportStatement;
      if (!importStatement.specifiers.some((specifier) => specifier.imported.name === className)) {
        continue;
      }
      const targetFilePath = resolveImportTargetFilePath(currentFilePath, importStatement.from.value);
      if (!targetFilePath) {
        continue;
      }
      const session = getSessionForFilePath(targetFilePath, options);
      if (!session?.ast) {
        continue;
      }
      const targetClass = findClassStatementInProgram(session.ast, className);
      if (targetClass) {
        return targetClass;
      }
    }
  }

  const sourceRoots = options.sourceRoots ?? [];
  if (sourceRoots.length > 0) {
    for (const filePath of scanMyFiles(sourceRoots)) {
      const session = getSessionForFilePath(filePath, options);
      if (!session?.ast) {
        continue;
      }
      const targetClass = findClassStatementInProgram(session.ast, className);
      if (targetClass) {
        return targetClass;
      }
    }
  }

  return null;
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
    pushItem({
      label: parameter.name.name,
      kind: CompletionItemKind.Field,
      detail: parameter.typeAnnotation
        ? `Class property: ${parameter.typeAnnotation.name}`
        : "Class property"
    });
  }

  for (const member of classStatement.members) {
    if (member.kind === "ClassFieldMember") {
      pushItem({
        label: member.name.name,
        kind: CompletionItemKind.Field,
        detail: member.typeAnnotation
          ? `Class property: ${member.typeAnnotation.name}`
          : "Class property"
      });
      continue;
    }

    pushItem({
      label: member.name.name,
      kind: CompletionItemKind.Method,
      detail: "Class method"
    });
  }

  return items;
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
    const newExpression = initializer as NewExpression;
    if (newExpression.callee.kind === "Identifier") {
      return (newExpression.callee as Identifier).name;
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

  const symbolMatch = analysis.getSymbolAt(
    line,
    target.objectStartCharacter + Math.floor(Math.max(0, target.objectName.length - 1) / 2)
  );
  let symbol = symbolMatch?.symbol;
  if (!symbol || symbol.name !== target.objectName) {
    const visibleSymbols = analysis.getVisibleSymbolsAt(line, character);
    symbol = visibleSymbols.find((candidate) => candidate.name === target.objectName);
    if (!symbol) {
      return null;
    }
  }

  let className: string | null = null;
  if (symbol.type?.kind === "named") {
    className = symbol.type.name;
  } else if (symbol.valueType) {
    const valueType = symbol.valueType;
    if (!["unknown", "int", "number", "string", "boolean", "bigint", "long"].includes(valueType)) {
      className = valueType;
    }
  }

  if (!className) {
    className = inferClassNameFromAstVariableInitializer(
      ast,
      target.objectName,
      line
    );
  }

  if (!className) {
    return null;
  }

  const classStatement = resolveClassStatement(ast, className, options);
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
