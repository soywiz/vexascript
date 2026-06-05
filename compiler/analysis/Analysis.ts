import type { BinaryExpression, ClassStatement, Node, Program } from "compiler/ast/ast";
import { Binder } from "./Binder";
import type {
  AnalysisIssue,
  AnalysisSymbol,
  IdentifierResolution,
  OperatorResolution,
  Scope
} from "./model";
import { TypeChecker } from "./TypeChecker";
import { type AnalysisType, typeToString } from "./types";

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

export class Analysis {
  private readonly rootScope: Scope;
  private readonly issues: AnalysisIssue[];
  private readonly identifierResolutions: IdentifierResolution[];
  private readonly operatorResolutions: OperatorResolution[];
  private readonly expressionTypes: Map<Node, AnalysisType>;
  private readonly autoAwaitExpressions: Set<Node>;

  constructor(
    program: Program,
    importedClassStatements: ReadonlyMap<string, ClassStatement> = new Map()
  ) {
    const bound = new Binder(program, importedClassStatements).bind();
    this.rootScope = bound.rootScope;

    const checked = new TypeChecker(program, bound, importedClassStatements).check();
    this.issues = checked.issues;
    this.identifierResolutions = checked.identifierResolutions;
    this.operatorResolutions = checked.operatorResolutions;
    this.expressionTypes = checked.expressionTypes;
    this.autoAwaitExpressions = checked.autoAwaitExpressions;
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

  getAutoAwaitExpressions(): ReadonlySet<Node> {
    return this.autoAwaitExpressions;
  }

  getImplicitReceiverIdentifiers(): ReadonlySet<Node> {
    return new Set(
      this.identifierResolutions
        .filter((resolution) => resolution.symbol.implicitReceiver === true)
        .map((resolution) => resolution.identifier)
    );
  }

  getSymbolAt(line: number, character: number): AnalysisSymbolMatch | null {
    for (const resolution of this.identifierResolutions) {
      const range = this.nodeToRange(resolution.identifier);
      if (range && this.rangeContains(range, line, character)) {
        return { symbol: resolution.symbol, range };
      }
    }

    const visible = this.getVisibleSymbolsAt(line, character);
    let best: AnalysisSymbolMatch | null = null;
    for (const symbol of visible) {
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
