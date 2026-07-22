import type { Identifier, JsxAttribute, MemberExpression, Node, VarStatement } from "compiler/ast/ast";
import type { AnalysisRange } from "./Analysis";
import type { AnalysisType, FunctionType } from "./types";
import type { AnalysisIssueCode, AnalysisIssueData } from "./issueCodes";

export type AnalysisSymbolKind = "variable" | "parameter" | "function" | "class" | "method" | "annotation";
export type AnalysisValueType = string;

export class AnalysisSymbol {
  constructor(
    public name: string,
    public kind: AnalysisSymbolKind,
    public node: Node,
    public declaredOffset: number = -1,
    public isReadonly?: boolean,
    public implicitReceiver?: boolean,
    public implicitReceiverClassName?: string,
    /** Set when this implicit receiver symbol is a user-defined extension method/property on a receiver type. */
    public implicitReceiverExtensionReceiver?: string,
    public type?: AnalysisType,
    public valueType: AnalysisValueType = "unknown"
  ) {}
}

export interface AnalysisIssue {
  message: string;
  node: Node;
  range?: AnalysisRange;
  code?: AnalysisIssueCode;
  data?: AnalysisIssueData;
}

export class Scope {
  constructor(
    public node: Node,
    public symbols: Map<string, AnalysisSymbol>,
    public children: Scope[],
    public parent?: Scope,
    public narrowedExpressionTypes?: Map<string, AnalysisType>
  ) {}
}

export class FlowLabel {
  constructor(public name: string, public allowsContinue: boolean) {}
}

export class FlowContext {
  constructor(
    public loopDepth: number,
    public switchDepth: number,
    public labels?: FlowLabel[],
    public expectedReturnType?: AnalysisType,
    public inAsync?: boolean,
    public inGenerator?: boolean,
    public contextualVoidReturn?: boolean
  ) {}
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

export class IdentifierResolution {
  constructor(public identifier: Identifier, public symbol: AnalysisSymbol) {}
}

export class JsxAttributeResolution {
  constructor(public attribute: JsxAttribute, public symbol: AnalysisSymbol) {}
}

export class OperatorResolution {
  constructor(public expression: Node, public symbol: AnalysisSymbol) {}
}

export class ExtensionPropertyResolution {
  constructor(
    public expression: MemberExpression,
    public declaration: VarStatement,
    public receiverTypeArguments: AnalysisType[]
  ) {}
}

export class SelectedCallResolution {
  constructor(
    public call: Node,
    public callee: Node,
    public overload: FunctionType,
    public overloadIndex: number
  ) {}
}

export class ReceiverLambdaInfo {
  constructor(
    public receiverType: AnalysisType,
    public label: string,
    public implicitReceiverAlias: boolean
  ) {}
}

export interface CheckedAnalysis {
  issues: AnalysisIssue[];
  identifierResolutions: IdentifierResolution[];
  jsxAttributeResolutions: JsxAttributeResolution[];
  operatorResolutions: OperatorResolution[];
  extensionPropertyResolutions: ExtensionPropertyResolution[];
  expressionTypes: Map<Node, AnalysisType>;
  selectedCallResolutions: SelectedCallResolution[];
  receiverLambdas: ReadonlyMap<Node, ReceiverLambdaInfo>;
  extensionMethodsByReceiver: ReadonlyMap<string, ReadonlyMap<string, AnalysisType>>;
  // Expressions that receive an implicit `await` because they evaluate to a Promise inside a
  // `sync` function body (and were not opted out via the `go` operator or `.then`-style usage).
  autoAwaitExpressions: Set<Node>;
  // ForStatements whose iterable is an AsyncIterator/AsyncGenerator and that therefore need
  // to be emitted as `for await (... of ...)` and decorated with a suspension gutter icon.
  asyncForStatements: Set<Node>;
}
