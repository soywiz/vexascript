import type { Node } from "compiler/ast/ast";
import type { AnalysisType } from "./types";

export type AnalysisSymbolKind = "variable" | "parameter" | "function" | "class" | "method";
export type AnalysisValueType = string;

export interface AnalysisSymbol {
  name: string;
  kind: AnalysisSymbolKind;
  node: Node;
  declaredOffset: number;
  isReadonly?: boolean;
  type?: AnalysisType;
  valueType?: AnalysisValueType;
}

export interface AnalysisIssue {
  message: string;
  node: Node;
}

export interface Scope {
  parent?: Scope;
  node: Node;
  symbols: Map<string, AnalysisSymbol>;
  children: Scope[];
}

export interface FlowContext {
  loopDepth: number;
  switchDepth: number;
}

export interface BoundAnalysis {
  rootScope: Scope;
  scopeByNode: WeakMap<Node, Scope>;
}

export interface IdentifierResolution {
  identifier: Node & { kind: "Identifier"; name: string };
  symbol: AnalysisSymbol;
}

export interface CheckedAnalysis {
  issues: AnalysisIssue[];
  identifierResolutions: IdentifierResolution[];
  expressionTypes: Map<Node, AnalysisType>;
}
