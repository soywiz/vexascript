import type { Identifier, JsxAttribute, MemberExpression, Node, VarStatement } from "compiler/ast/ast";
import type { AnalysisRange } from "./Analysis";
import type { AnalysisType, FunctionType } from "./types";
import type { AnalysisIssueCode, AnalysisIssueData } from "./issueCodes";

export type AnalysisSymbolKind = "variable" | "parameter" | "function" | "class" | "method" | "annotation";
export type AnalysisValueType = string;

export interface AnalysisSymbol {
  name: string;
  kind: AnalysisSymbolKind;
  node: Node;
  declaredOffset: number;
  isReadonly?: boolean;
  implicitReceiver?: boolean;
  implicitReceiverClassName?: string;
  /** Set when this implicit receiver symbol is a user-defined extension method/property on a receiver type. */
  implicitReceiverExtensionReceiver?: string;
  type?: AnalysisType;
  valueType?: AnalysisValueType;
}

export interface AnalysisIssue {
  message: string;
  node: Node;
  range?: AnalysisRange;
  code?: AnalysisIssueCode;
  data?: AnalysisIssueData;
}

export interface Scope {
  parent?: Scope;
  node: Node;
  symbols: Map<string, AnalysisSymbol>;
  narrowedExpressionTypes?: Map<string, AnalysisType>;
  children: Scope[];
}

export class FlowLabel {
  constructor(public name: string, public allowsContinue: boolean) {}
}

export interface FlowContext {
  loopDepth: number;
  switchDepth: number;
  labels?: FlowLabel[];
  expectedReturnType?: AnalysisType;
  inAsync?: boolean;
  inGenerator?: boolean;
}

export interface BoundAnalysis {
  rootScope: Scope;
  scopeByNode: WeakMap<Node, Scope>;
  issues: AnalysisIssue[];
}

export function resolveScopeSymbol(
  name: string,
  scope: Scope,
  usageOffset: number | undefined
): AnalysisSymbol | null {
  let current: Scope | undefined = scope;
  while (current) {
    const symbol = current.symbols.get(name);
    if (symbol) {
      if (!current.parent || symbol.implicitReceiver === true || usageOffset === undefined ||
          symbol.declaredOffset < 0 || symbol.declaredOffset <= usageOffset) {
        return symbol;
      }
    }
    current = current.parent;
  }
  return null;
}

export interface IdentifierResolution {
  identifier: Identifier;
  symbol: AnalysisSymbol;
}

export interface JsxAttributeResolution {
  attribute: JsxAttribute;
  symbol: AnalysisSymbol;
}

export interface OperatorResolution {
  expression: Node;
  symbol: AnalysisSymbol;
}

export interface ExtensionPropertyResolution {
  expression: MemberExpression;
  declaration: VarStatement;
  receiverTypeArguments: AnalysisType[];
}

export interface SelectedCallResolution {
  call: Node;
  callee: Node;
  overload: FunctionType;
  overloadIndex: number;
}

export interface CheckedAnalysis {
  issues: AnalysisIssue[];
  identifierResolutions: IdentifierResolution[];
  jsxAttributeResolutions: JsxAttributeResolution[];
  operatorResolutions: OperatorResolution[];
  extensionPropertyResolutions: ExtensionPropertyResolution[];
  expressionTypes: Map<Node, AnalysisType>;
  selectedCallResolutions: SelectedCallResolution[];
  // Expressions that receive an implicit `await` because they evaluate to a Promise inside a
  // `sync` function body (and were not opted out via the `go` operator or `.then`-style usage).
  autoAwaitExpressions: Set<Node>;
  // ForStatements whose iterable is an AsyncIterator/AsyncGenerator and that therefore need
  // to be emitted as `for await (... of ...)` and decorated with a suspension gutter icon.
  asyncForStatements: Set<Node>;
}
