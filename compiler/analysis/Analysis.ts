import type { Node, Program } from "compiler/ast/ast";
import { Binder } from "./Binder";
import type { AnalysisIssue, AnalysisSymbol, Scope } from "./model";
import { TypeChecker } from "./TypeChecker";

export type { AnalysisIssue, AnalysisSymbol, AnalysisSymbolKind, AnalysisValueType } from "./model";

export class Analysis {
  private readonly rootScope: Scope;
  private readonly issues: AnalysisIssue[];

  constructor(program: Program) {
    const bound = new Binder(program).bind();
    this.rootScope = bound.rootScope;
    this.issues = new TypeChecker(program, bound).check();
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
    if (!node.firstToken || !node.lastToken) {
      return true;
    }

    const start = node.firstToken.range.start;
    const end = node.lastToken.range.end;

    if (line < start.line || line > end.line) {
      return false;
    }
    if (line === start.line && character < start.column) {
      return false;
    }
    if (line === end.line && character > end.column) {
      return false;
    }
    return true;
  }
}
