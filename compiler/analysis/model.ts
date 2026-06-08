import type { Node } from "compiler/ast/ast";
import type { BinaryExpression } from "compiler/ast/ast";
import type { AnalysisType } from "./types";
import type { AnalysisIssueCode, AnalysisIssueData } from "./issueCodes";

export type AnalysisSymbolKind = "variable" | "parameter" | "function" | "class" | "method";
export type AnalysisValueType = string;

export interface AnalysisSymbol {
  name: string;
  kind: AnalysisSymbolKind;
  node: Node;
  declaredOffset: number;
  isReadonly?: boolean;
  implicitReceiver?: boolean;
  implicitReceiverClassName?: string;
  type?: AnalysisType;
  valueType?: AnalysisValueType;
}

export interface AnalysisIssue {
  message: string;
  node: Node;
  code?: AnalysisIssueCode;
  data?: AnalysisIssueData;
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
  labels?: Array<{ name: string; allowsContinue: boolean }>;
  expectedReturnType?: AnalysisType;
  inAsync?: boolean;
  inGenerator?: boolean;
}

export interface BoundAnalysis {
  rootScope: Scope;
  scopeByNode: WeakMap<Node, Scope>;
}

export interface IdentifierResolution {
  identifier: Node & { kind: "Identifier"; name: string };
  symbol: AnalysisSymbol;
}

export interface JsxAttributeResolution {
  attribute: Node & { kind: "JsxAttribute"; name: string };
  symbol: AnalysisSymbol;
}

export interface OperatorResolution {
  expression: BinaryExpression;
  symbol: AnalysisSymbol;
}

export interface CheckedAnalysis {
  issues: AnalysisIssue[];
  identifierResolutions: IdentifierResolution[];
  jsxAttributeResolutions: JsxAttributeResolution[];
  operatorResolutions: OperatorResolution[];
  expressionTypes: Map<Node, AnalysisType>;
  // Expressions that receive an implicit `await` because they evaluate to a Promise inside a
  // `sync` function body (and were not opted out via the `go` operator or `.then`-style usage).
  autoAwaitExpressions: Set<Node>;
}
