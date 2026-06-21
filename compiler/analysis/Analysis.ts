import type { BinaryExpression, Identifier, ImportStatement, MemberExpression, Node, Program, Statement } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { Binder } from "./Binder";
import type {
  AnalysisIssue,
  AnalysisSymbol,
  IdentifierResolution,
  JsxAttributeResolution,
  OperatorResolution,
  SelectedCallResolution,
  Scope
} from "./model";
import { TypeChecker } from "./TypeChecker";
import { type AnalysisType, typeToString } from "./types";
import { normalizeImportedSymbolSources, type ImportedSymbolResolution } from "compiler/importedSymbols";

export type { AnalysisIssue, AnalysisSymbol, AnalysisSymbolKind, AnalysisValueType } from "./model";

export interface AnalysisRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface AnalysisSymbolMatch {
  symbol: AnalysisSymbol;
  range: AnalysisRange;
}

export interface AnalysisHoverInfo {
  contents: string;
  range: AnalysisRange;
}

/**
 * Optional inputs that make a single-file analysis aware of declarations that
 * live in other files. The core analysis is otherwise single-file; callers that
 * have project/import context (the LSP server, the Monaco demo) can resolve the
 * imported top-level declarations and pass them here so that, for example,
 * extension methods declared on an imported class can resolve the implicit
 * `this` receiver and its members across files.
 */
export interface AnalysisOptions {
  /**
   * Top-level declaration statements imported from other files (classes,
   * interfaces, enums, type aliases). They are registered for name/member
   * resolution only; they are never re-checked or re-bound as if they belonged
   * to the analyzed program.
   */
  externalDeclarations?: Statement[];
  /**
   * Ambient library declarations requested by project configuration, such as
   * DOM globals from `compilerOptions.lib`. Unlike module imports, these
   * declarations are bound as globals in the analyzed file.
   */
  ambientDeclarations?: Statement[];
  /**
   * Resolved imported symbols, keyed by the local name they are bound to in
   * this program (e.g. `delay` from `import { delay } from "./other"`). This
   * keeps type, display text, declaration origin, and invalid-binding state in
   * one canonical structure so analysis, hover, and definition agree.
   */
  importedSymbols?: ReadonlyMap<string, ImportedSymbolResolution>;
  invalidImportedBindings?: ReadonlySet<string>;
}

export class Analysis {
  private readonly program: Program;
  private readonly rootScope: Scope;
  private readonly issues: AnalysisIssue[];
  private readonly identifierResolutions: IdentifierResolution[];
  private readonly jsxAttributeResolutions: JsxAttributeResolution[];
  private readonly operatorResolutions: OperatorResolution[];
  private readonly expressionTypes: Map<Node, AnalysisType>;
  private readonly selectedCallResolutions: SelectedCallResolution[];
  private readonly autoAwaitExpressions: Set<Node>;
  private readonly asyncForStatements: Set<Node>;

  constructor(program: Program, options: AnalysisOptions = {}) {
    this.program = program;
    const externalDeclarations = options.externalDeclarations ?? [];
    const ambientDeclarations = options.ambientDeclarations ?? [];
    const { importedSymbols } = normalizeImportedSymbolSources(options);
    const bound = new Binder(
      program,
      externalDeclarations,
      ambientDeclarations,
      importedSymbols
    ).bind();
    this.rootScope = bound.rootScope;

    const checked = new TypeChecker(
      program,
      bound,
      externalDeclarations,
      ambientDeclarations,
      options.invalidImportedBindings
    ).check();
    this.issues = [...bound.issues, ...checked.issues];
    this.identifierResolutions = checked.identifierResolutions;
    this.jsxAttributeResolutions = checked.jsxAttributeResolutions;
    this.operatorResolutions = checked.operatorResolutions;
    this.expressionTypes = checked.expressionTypes;
    this.selectedCallResolutions = checked.selectedCallResolutions;
    this.autoAwaitExpressions = checked.autoAwaitExpressions;
    this.asyncForStatements = checked.asyncForStatements;
  }

  getVisibleSymbolsAt(line: number, character: number): AnalysisSymbol[] {
    const scope = this.findInnermostScope(this.rootScope, line, character);
    if (!scope) {
      return [];
    }

    const visible = new Map<string, AnalysisSymbol>();
    let current: Scope | undefined = scope;
    while (current) {
      for (const [name, symbol] of current.symbols) {
        if (!visible.has(name)) {
          visible.set(name, symbol);
        }
      }
      current = current.parent;
    }
    return Array.from(visible.values());
  }

  getIssues(): AnalysisIssue[] {
    return [...this.issues];
  }

  getExpressionTypes(): ReadonlyMap<Node, AnalysisType> {
    return this.expressionTypes;
  }

  getUnusedImportIdentifiers(): readonly Identifier[] {
    const usedImportedBindings = new Set<Node>();
    for (const resolution of this.identifierResolutions) {
      if (resolution.symbol.node !== resolution.identifier) {
        usedImportedBindings.add(resolution.symbol.node);
      }
    }
    const memberPropertyNames = new Set<string>();
    walkAst(this.program, (node) => {
      if (node.kind !== "MemberExpression") {
        return;
      }
      const member = node as MemberExpression;
      if (!member.computed && member.property.kind === "Identifier") {
        memberPropertyNames.add((member.property as Identifier).name);
      }
    });

    const unused: Identifier[] = [];
    for (const statement of this.program.body) {
      if (statement.kind !== "ImportStatement") {
        continue;
      }
      const importStatement = statement as ImportStatement;
      const bindings: Identifier[] = [];
      if (importStatement.defaultImport) {
        bindings.push(importStatement.defaultImport);
      }
      if (importStatement.namespaceImport) {
        bindings.push(importStatement.namespaceImport);
      }
      for (const specifier of importStatement.specifiers) {
        bindings.push(specifier.local ?? specifier.imported);
      }
      for (const binding of bindings) {
        if (memberPropertyNames.has(binding.name)) {
          continue;
        }
        if (!usedImportedBindings.has(binding)) {
          unused.push(binding);
        }
      }
    }
    return unused;
  }

  getSelectedCallResolutionAt(line: number, character: number): SelectedCallResolution | null {
    for (const resolution of this.selectedCallResolutions) {
      const range = this.nodeToRange(resolution.callee);
      if (range && this.rangeContains(range, line, character)) {
        return resolution;
      }
    }
    return null;
  }

  getAutoAwaitExpressions(): ReadonlySet<Node> {
    return this.autoAwaitExpressions;
  }

  getAsyncForStatements(): ReadonlySet<Node> {
    return this.asyncForStatements;
  }

  /**
   * Returns the resolved type of a top-level (module-scope) symbol declared in
   * this program, or `undefined` if no such symbol exists. Used to resolve the
   * type of a value imported from this file into another file, including the
   * inferred return type of functions without an explicit return annotation.
   */
  getTopLevelSymbolType(name: string): AnalysisType | undefined {
    return this.rootScope.symbols.get(name)?.type;
  }

  getImplicitReceiverIdentifiers(): ReadonlySet<Node> {
    return new Set(
      this.identifierResolutions
        .filter((resolution) =>
          resolution.symbol.implicitReceiver === true &&
          !resolution.symbol.implicitReceiverClassName &&
          !resolution.symbol.implicitReceiverExtensionReceiver
        )
        .map((resolution) => resolution.identifier)
    );
  }

  getImplicitReceiverExtensionIdentifiers(): ReadonlyMap<Node, string> {
    const result = new Map<Node, string>();
    for (const resolution of this.identifierResolutions) {
      if (resolution.symbol.implicitReceiverExtensionReceiver) {
        result.set(resolution.identifier, resolution.symbol.implicitReceiverExtensionReceiver);
      }
    }
    return result;
  }

  getStaticImplicitReceiverIdentifiers(): ReadonlyMap<Node, string> {
    const result = new Map<Node, string>();
    for (const resolution of this.identifierResolutions) {
      if (resolution.symbol.implicitReceiver === true && resolution.symbol.implicitReceiverClassName) {
        result.set(resolution.identifier, resolution.symbol.implicitReceiverClassName);
      }
    }
    return result;
  }

  getSymbolAt(line: number, character: number): AnalysisSymbolMatch | null {
    for (const resolution of this.identifierResolutions) {
      const range = this.nodeToRange(resolution.identifier);
      if (range && this.rangeContains(range, line, character)) {
        return { symbol: resolution.symbol, range };
      }
    }

    for (const resolution of this.jsxAttributeResolutions) {
      const range = this.jsxAttributeNameRange(resolution.attribute);
      if (range && this.rangeContains(range, line, character)) {
        return { symbol: resolution.symbol, range };
      }
    }

    const visible = this.getVisibleSymbolsAt(line, character);
    let best: AnalysisSymbolMatch | null = null;
    for (const symbol of visible) {
      if (symbol.declaredOffset < 0) {
        continue;
      }
      if (symbol.node.kind !== "Identifier") {
        continue;
      }
      const range = this.nodeToRange(symbol.node);
      if (range && this.rangeContains(range, line, character)) {
        const candidate: AnalysisSymbolMatch = { symbol, range };
        if (!best || this.rangeSize(candidate.range) < this.rangeSize(best.range)) {
          best = candidate;
        }
      }
    }
    return best;
  }

  getDefinitionAt(line: number, character: number): AnalysisSymbolMatch | null {
    const at = this.getSymbolAt(line, character) ?? this.getOperatorSymbolAt(line, character);
    if (!at) {
      return null;
    }

    const range = this.nodeToRange(at.symbol.node);
    if (!range) {
      return null;
    }

    return {
      symbol: at.symbol,
      range
    };
  }

  getRenameRangesAt(line: number, character: number): AnalysisRange[] {
    const at = this.getSymbolAt(line, character);
    if (!at) {
      return [];
    }

    const symbol = at.symbol;
    if (symbol.declaredOffset < 0) {
      return [];
    }

    const ranges: AnalysisRange[] = [];
    const seen = new Set<string>();

    const declarationRange = this.nodeToRange(symbol.node);
    if (declarationRange) {
      const key = this.rangeKey(declarationRange);
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push(declarationRange);
      }
    }

    for (const resolution of this.identifierResolutions) {
      if (resolution.symbol !== symbol) {
        continue;
      }
      const range = this.nodeToRange(resolution.identifier);
      if (!range) {
        continue;
      }
      const key = this.rangeKey(range);
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push(range);
      }
    }

    return ranges;
  }

  getReferenceRangesAt(
    line: number,
    character: number,
    includeDeclaration: boolean = true
  ): AnalysisRange[] {
    const at = this.getSymbolAt(line, character);
    if (!at) {
      return [];
    }

    const symbol = at.symbol;
    const ranges: AnalysisRange[] = [];
    const seen = new Set<string>();

    if (includeDeclaration) {
      const declarationRange = this.nodeToRange(symbol.node);
      if (declarationRange) {
        const key = this.rangeKey(declarationRange);
        if (!seen.has(key)) {
          seen.add(key);
          ranges.push(declarationRange);
        }
      }
    }

    for (const resolution of this.identifierResolutions) {
      if (resolution.symbol !== symbol) {
        continue;
      }
      const range = this.nodeToRange(resolution.identifier);
      if (!range) {
        continue;
      }
      const key = this.rangeKey(range);
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push(range);
      }
    }

    return ranges;
  }

  getHoverAt(line: number, character: number): AnalysisHoverInfo | null {
    const symbolMatch = this.getSymbolAt(line, character) ?? this.getOperatorSymbolAt(line, character);
    if (symbolMatch) {
      const typeLabel = symbolMatch.symbol.valueType ?? "unknown";
      return {
        contents: `${symbolMatch.symbol.kind} ${symbolMatch.symbol.name}: ${typeLabel}`,
        range: symbolMatch.range
      };
    }

    const expressionMatch = this.findSmallestExpressionTypeAt(line, character);
    if (!expressionMatch) {
      return null;
    }

    return {
      contents: `expression: ${typeToString(expressionMatch.type)}`,
      range: expressionMatch.range
    };
  }

  /**
   * Resolves the type name of the receiver expression that ends exactly at the
   * given position, which is where the member-access dot sits. This relies on
   * the analyzed expression types, so it transparently reflects sync-function
   * auto-await (a call returning `Promise<T>` is observed here as `T`) and any
   * other complex receiver such as a call or parenthesized expression. Used by
   * completion to resolve members after receivers that are not plain identifier
   * chains. When several expressions end at the same position (e.g. an
   * identifier nested in a member expression), the outermost (largest) one is
   * returned.
   */
  getReceiverTypeNameEndingAt(line: number, character: number): string | null {
    let best: { type: AnalysisType; size: number } | null = null;
    for (const [node, type] of this.expressionTypes) {
      const range = this.nodeToRange(node);
      if (!range) {
        continue;
      }
      if (range.end.line !== line || range.end.character !== character) {
        continue;
      }
      const size = this.rangeSize(range);
      if (!best || size > best.size) {
        best = { type, size };
      }
    }
    return best ? typeToString(best.type) : null;
  }

  getOperatorSymbolAt(line: number, character: number): AnalysisSymbolMatch | null {
    let best: AnalysisSymbolMatch | null = null;
    for (const resolution of this.operatorResolutions) {
      const range = this.operatorRange(resolution.expression);
      if (!range || !this.rangeContains(range, line, character)) {
        continue;
      }
      const candidate: AnalysisSymbolMatch = { symbol: resolution.symbol, range };
      if (!best || this.rangeSize(candidate.range) < this.rangeSize(best.range)) {
        best = candidate;
      }
    }
    return best;
  }

  private findSmallestExpressionTypeAt(
    line: number,
    character: number
  ): { type: AnalysisType; range: AnalysisRange } | null {
    let best: { type: AnalysisType; range: AnalysisRange; size: number } | null = null;

    for (const [node, type] of this.expressionTypes) {
      const range = this.nodeToRange(node);
      if (!range) {
        continue;
      }
      if (!this.rangeContains(range, line, character)) {
        continue;
      }

      const size = this.rangeSize(range);
      if (!best || size < best.size) {
        best = { type, range, size };
      }
    }

    if (!best) {
      return null;
    }

    return {
      type: best.type,
      range: best.range
    };
  }

  private operatorRange(expression: BinaryExpression): AnalysisRange | null {
    const token = expression.operatorToken;
    if (!token) {
      return null;
    }
    return {
      start: {
        line: token.range.start.line,
        character: token.range.start.column
      },
      end: {
        line: token.range.end.line,
        character: token.range.end.column
      }
    };
  }

  private findInnermostScope(scope: Scope, line: number, character: number): Scope | null {
    if (!this.nodeContainsPosition(scope.node, line, character)) {
      return null;
    }

    for (const child of scope.children) {
      const nested = this.findInnermostScope(child, line, character);
      if (nested) {
        return nested;
      }
    }
    return scope;
  }

  private nodeContainsPosition(node: Node, line: number, character: number): boolean {
    const range = this.nodeToRange(node);
    if (!range) {
      return true;
    }
    return this.rangeContains(range, line, character);
  }

  private nodeToRange(node: Node): AnalysisRange | null {
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

  private jsxAttributeNameRange(attribute: Node & { kind: "JsxAttribute"; name: string }): AnalysisRange | null {
    const token = attribute.firstToken;
    if (!token) {
      return null;
    }

    return {
      start: {
        line: token.range.start.line,
        character: token.range.start.column
      },
      end: {
        line: token.range.start.line,
        character: token.range.start.column + attribute.name.length
      }
    };
  }

  private rangeContains(range: AnalysisRange, line: number, character: number): boolean {
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

  private rangeSize(range: AnalysisRange): number {
    const lineSpan = range.end.line - range.start.line;
    if (lineSpan > 0) {
      return lineSpan * 100000 + (range.end.character - range.start.character);
    }
    return range.end.character - range.start.character;
  }

  private rangeKey(range: AnalysisRange): string {
    return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
  }
}
