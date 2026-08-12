import { BinaryExpression, Identifier, ImportStatement, JsxAttribute, JsxElement, nodeStartOffset, UnaryExpression } from "compiler/ast/ast";
import type { Node, ObjectLiteral, Program, Statement } from "compiler/ast/ast";

import { childNodes } from "compiler/ast/traversal";
import { Binder } from "./Binder";
import type {
  AnalysisIssue,
  AnalysisSymbol,
  ExtensionPropertyResolution,
  JsxAttributeResolution,
  JsxElementResolution,
  OperatorResolution,
  ReceiverLambdaInfo,
  SelectedCallResolution,
  Scope
} from "./model";
import { TypeChecker } from "./TypeChecker";
import { DefiniteAssignmentChecker } from "./DefiniteAssignmentChecker";
import { type AnalysisType, typeToString, FunctionType, isUnknownType } from "./types";
import { normalizeImportedSymbolSources, type ImportedSymbolResolution } from "compiler/importedSymbols";
import { IdentifierResolution, resolveScopeSymbol, type BoundAnalysis } from "./model";
import { monotonicNow } from "compiler/utils/time";

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

export interface JsxOpeningTagTarget {
  position: { line: number; character: number };
  closingRange: AnalysisRange;
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
   * Treat `externalDeclarations` as project-owned VexaScript declarations for
   * rules that intentionally ignore third-party/imported types, such as the
   * missing-`override` requirement.
   */
  projectOwnedExternalDeclarations?: boolean;
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
  /**
   * Source language of the analyzed program. VexaScript-only semantic rules
   * (such as requiring `override` on members that redefine a project supertype
   * member) are skipped for `"typescript"` sources, which follow TypeScript
   * rules. Defaults to `"vexascript"`.
   */
  language?: "vexascript" | "typescript";
  /** Optional fine-grained timing sink for compiler performance diagnostics. */
  profile?: (event: AnalysisProfileEvent) => void;
  /**
   * Validate semantic type compatibility after binding. When false, analysis
   * still infers the expression and call information required by emitters.
   * Defaults to true.
   */
  checkTypes?: boolean;
  /**
   * Populate type-driven emitter metadata. Dynamic native bootstrap builds may
   * disable this after binding and rely on conservative lowering instead.
   * Defaults to true.
   */
  inferTypes?: boolean;
}

export interface AnalysisProfileEvent {
  phase: "binding" | "type-inference" | "type-checking";
  elapsedMs: number;
}

function collectBoundImplicitReceiverResolutions(
  node: Node,
  inheritedScope: Scope,
  bound: BoundAnalysis,
  resolutions: IdentifierResolution[]
): void {
  const scope = bound.scopeByNode.get(node) ?? inheritedScope;
  if (node instanceof Identifier) {
    const identifier = node as Identifier;
    const symbol = resolveScopeSymbol(identifier.name, scope, nodeStartOffset(identifier));
    if (symbol?.implicitReceiver === true) resolutions.push(new IdentifierResolution(identifier, symbol));
  }
  for (const child of childNodes(node)) {
    collectBoundImplicitReceiverResolutions(child, scope, bound, resolutions);
  }
}

export class Analysis {
  private readonly program: Program;
  private readonly rootScope: Scope;
  private readonly issues: AnalysisIssue[];
  private readonly identifierResolutions: IdentifierResolution[];
  private readonly jsxAttributeResolutions: JsxAttributeResolution[];
  private readonly jsxElementResolutions: JsxElementResolution[];
  private readonly jsxIntrinsicElementSymbols: ReadonlyMap<string, AnalysisSymbol>;
  private readonly jsxPropsByElement: ReadonlyMap<JsxElement, ReadonlyMap<string, AnalysisType>>;
  private readonly operatorResolutions: OperatorResolution[];
  private readonly extensionPropertyResolutions: ExtensionPropertyResolution[];
  private readonly expressionTypes: Map<Node, AnalysisType>;
  private readonly contextualObjectLiteralProperties: ReadonlyMap<ObjectLiteral, ReadonlyMap<string, AnalysisType>>;
  private readonly contextualObjectLiteralPropertyOwnerTypeNames: ReadonlyMap<ObjectLiteral, ReadonlyMap<string, string>>;
  private readonly selectedCallResolutions: SelectedCallResolution[];
  private readonly receiverLambdas: ReadonlyMap<Node, ReceiverLambdaInfo>;
  private readonly extensionMethodsByReceiver: ReadonlyMap<string, ReadonlyMap<string, AnalysisType>>;
  private readonly autoAwaitExpressions: Set<Node>;
  private readonly asyncForStatements: Set<Node>;
  private readonly narrowedScopes: readonly Scope[];
  private readonly importedSymbols: ReadonlyMap<string, ImportedSymbolResolution>;

  constructor(program: Program, options: AnalysisOptions = {}) {
    this.program = program;
    const externalDeclarations = options.externalDeclarations ?? [];
    const ambientDeclarations = options.ambientDeclarations ?? [];
    const invalidImportedBindings = options.invalidImportedBindings ?? new Set<string>();
    const importedSymbolViews = normalizeImportedSymbolSources(options);
    const importedSymbols: Map<string, ImportedSymbolResolution> = importedSymbolViews.importedSymbols;
    this.importedSymbols = importedSymbols;
    let phaseStartedAt: number = monotonicNow();
    const bound = new Binder(
      program,
      externalDeclarations,
      ambientDeclarations,
      importedSymbols
    ).bind();
    options.profile?.({ phase: "binding", elapsedMs: monotonicNow() - phaseStartedAt });
    this.rootScope = bound.rootScope;

    if (options.inferTypes === false) {
      options.profile?.({ phase: "type-inference", elapsedMs: 0 });
      this.issues = [...bound.issues];
      const identifierResolutions: IdentifierResolution[] = [];
      collectBoundImplicitReceiverResolutions(program, bound.rootScope, bound, identifierResolutions);
      this.identifierResolutions = identifierResolutions;
      this.jsxAttributeResolutions = [];
      this.jsxElementResolutions = [];
      this.jsxIntrinsicElementSymbols = new Map();
      this.jsxPropsByElement = new Map();
      this.operatorResolutions = [];
      this.extensionPropertyResolutions = [];
      this.expressionTypes = new Map();
      this.contextualObjectLiteralProperties = new Map();
      this.contextualObjectLiteralPropertyOwnerTypeNames = new Map();
      this.selectedCallResolutions = [];
      this.receiverLambdas = new Map();
      this.extensionMethodsByReceiver = new Map();
      this.autoAwaitExpressions = new Set();
      this.asyncForStatements = new Set();
      this.narrowedScopes = [];
      return;
    }

    phaseStartedAt = monotonicNow();
    const validateTypes = options.checkTypes ?? true;
    const checked = new TypeChecker(
      program,
      bound,
      externalDeclarations,
      ambientDeclarations,
      invalidImportedBindings,
      options.language ?? "vexascript",
      options.projectOwnedExternalDeclarations === true,
      validateTypes
    ).check();
    options.profile?.({
      phase: validateTypes ? "type-checking" : "type-inference",
      elapsedMs: monotonicNow() - phaseStartedAt
    });
    const definiteAssignmentIssues = validateTypes && (options.language ?? "vexascript") === "vexascript"
      ? new DefiniteAssignmentChecker(program, bound).check()
      : [];
    this.issues = validateTypes
      ? [...bound.issues, ...checked.issues, ...definiteAssignmentIssues]
      : [...bound.issues];
    this.identifierResolutions = checked.identifierResolutions;
    this.jsxAttributeResolutions = checked.jsxAttributeResolutions;
    this.jsxElementResolutions = checked.jsxElementResolutions;
    this.jsxIntrinsicElementSymbols = checked.jsxIntrinsicElementSymbols;
    this.jsxPropsByElement = checked.jsxPropsByElement;
    this.operatorResolutions = checked.operatorResolutions;
    this.extensionPropertyResolutions = checked.extensionPropertyResolutions;
    this.expressionTypes = checked.expressionTypes;
    this.contextualObjectLiteralProperties = checked.contextualObjectLiteralProperties;
    this.contextualObjectLiteralPropertyOwnerTypeNames = checked.contextualObjectLiteralPropertyOwnerTypeNames;
    this.selectedCallResolutions = checked.selectedCallResolutions;
    this.receiverLambdas = checked.receiverLambdas;
    this.extensionMethodsByReceiver = checked.extensionMethodsByReceiver;
    this.autoAwaitExpressions = checked.autoAwaitExpressions;
    this.asyncForStatements = checked.asyncForStatements;
    this.narrowedScopes = checked.narrowedScopes;
  }

  getVisibleSymbolsAt(line: number, character: number): AnalysisSymbol[] {
    const scope = this.findInnermostScope(this.rootScope, line, character);
    if (!scope) {
      return [];
    }

    let effectiveScope = scope;
    for (const narrowedScope of this.narrowedScopes) {
      if (this.nodeContainsPosition(narrowedScope.node, line, character)) {
        effectiveScope = narrowedScope;
      }
    }

    const visible = new Map<string, AnalysisSymbol>();
    let current: Scope | undefined = effectiveScope;
    while (current) {
      for (const [name, symbol] of current.symbols) {
        if (!visible.has(name)) {
          visible.set(name, symbol);
        }
      }
      current = current.parent;
    }
    const result: AnalysisSymbol[] = [];
    for (const value of visible.values()) {
      result.push(value);
    }
    return result;
  }

  getExpressionType(node: Node): AnalysisType | undefined {
    const inferred = this.expressionTypes.get(node);
    if (!(node instanceof Identifier)) {
      return inferred;
    }
    for (let index = this.identifierResolutions.length - 1; index >= 0; index -= 1) {
      const resolution = this.identifierResolutions[index]!;
      if (
        resolution.identifier === node &&
        resolution.symbol.type &&
        !isUnknownType(resolution.symbol.type)
      ) {
        return resolution.symbol.type;
      }
    }
    return inferred;
  }

  getIssues(): AnalysisIssue[] {
    return [...this.issues];
  }

  getExpressionTypes(): ReadonlyMap<Node, AnalysisType> {
    return this.expressionTypes;
  }

  getContextualObjectLiteralProperties(
    objectLiteral: ObjectLiteral
  ): ReadonlyMap<string, AnalysisType> | null {
    return this.contextualObjectLiteralProperties.get(objectLiteral) ?? null;
  }

  getContextualObjectLiteralPropertyOwnerTypeName(
    objectLiteral: ObjectLiteral,
    propertyName: string
  ): string | null {
    return this.contextualObjectLiteralPropertyOwnerTypeNames.get(objectLiteral)?.get(propertyName) ?? null;
  }

  getReceiverLambdas(): ReadonlyMap<Node, ReceiverLambdaInfo> {
    return this.receiverLambdas;
  }

  getOperatorResolutions(): readonly OperatorResolution[] {
    return this.operatorResolutions;
  }

  getExtensionPropertyResolutions(): readonly ExtensionPropertyResolution[] {
    return this.extensionPropertyResolutions;
  }

  getUnusedImportIdentifiers(): readonly Identifier[] {
    const usedImportedBindings = new Set<Node>();
    const usedImportedNames = new Set<string>();
    const importedNamesByDeclaration = new Map<Node, string[]>();
    const addImportedDeclarationName = (declaration: Node, localName: string): void => {
      const names = importedNamesByDeclaration.get(declaration) ?? [];
      names.push(localName);
      importedNamesByDeclaration.set(declaration, names);
    };
    for (const [localName, resolution] of this.importedSymbols) {
      const declaration = resolution.declarationOrigin?.statement;
      if (!declaration) {
        continue;
      }
      addImportedDeclarationName(declaration, localName);
      if ("name" in declaration && declaration.name instanceof Identifier) {
        addImportedDeclarationName(declaration.name, localName);
      }
    }
    const markDeclarationUsed = (declaration: Node): void => {
      for (const localName of importedNamesByDeclaration.get(declaration) ?? []) {
        usedImportedNames.add(localName);
      }
    };
    const markImportedExtensionNameUsed = (resolvedName: string, receiverName: string): void => {
      for (const [localName, resolution] of this.importedSymbols) {
        const origin = resolution.declarationOrigin;
        const declaration = origin?.statement;
        const declarationReceiver = declaration && "receiverType" in declaration
          ? (declaration as Statement & { receiverType?: Identifier }).receiverType
          : undefined;
        if (
          origin?.exportedName === resolvedName
          && declarationReceiver?.name === receiverName
        ) {
          usedImportedNames.add(localName);
        }
      }
    };
    for (const resolution of this.identifierResolutions) {
      if (resolution.symbol.node !== resolution.identifier) {
        usedImportedBindings.add(resolution.symbol.node);
        markDeclarationUsed(resolution.symbol.node);
      }
      if (resolution.symbol.implicitReceiverExtensionReceiver) {
        markImportedExtensionNameUsed(
          resolution.symbol.name,
          resolution.symbol.implicitReceiverExtensionReceiver
        );
      }
    }
    for (const resolution of this.operatorResolutions) {
      markDeclarationUsed(resolution.symbol.node);
    }
    for (const resolution of this.extensionPropertyResolutions) {
      markDeclarationUsed(resolution.declaration);
    }
    const importedNames = new Set<string>();
    for (const statement of this.program.body) {
      if (!(statement instanceof ImportStatement)) continue;
      const importStatement = statement as ImportStatement;
      if (importStatement.defaultImport) importedNames.add(importStatement.defaultImport.name);
      if (importStatement.namespaceImport) importedNames.add(importStatement.namespaceImport.name);
      for (const specifier of importStatement.specifiers) {
        importedNames.add((specifier.local ?? specifier.imported).name);
      }
    }
    const collectNestedTypeReferences = (node: Node): void => {
      if (node instanceof ImportStatement) return;
      if (node instanceof Identifier) {
        for (const importedName of importedNames) {
          if (
            node.name !== importedName &&
            new RegExp(`(?:^|\\W)${importedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\W)`).test(node.name)
          ) {
            usedImportedNames.add(importedName);
          }
        }
      }
      for (const child of childNodes(node)) collectNestedTypeReferences(child);
    };
    collectNestedTypeReferences(this.program);

    const unused: Identifier[] = [];
    for (const statement of this.program.body) {
      if (!(statement instanceof ImportStatement)) {
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
        if (!usedImportedBindings.has(binding) && !usedImportedNames.has(binding.name)) {
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

  getExtensionMethodType(receiverName: string, name: string): AnalysisType | undefined {
    return this.extensionMethodsByReceiver.get(receiverName)?.get(name);
  }

  getCallableTypes(): ReadonlyMap<Node, AnalysisType> {
    const result = new Map<Node, AnalysisType>();
    const pendingScopes: Scope[] = [this.rootScope];
    while (pendingScopes.length > 0) {
      const scope = pendingScopes.pop()!;
      for (const value of scope.symbols.values()) {
        const symbol: AnalysisSymbol = value;
        if (symbol.type instanceof FunctionType) {
          result.set(symbol.node, symbol.type);
        }
      }
      for (const child of scope.children) {
        pendingScopes.push(child);
      }
    }
    return result;
  }

  getResolvedCallTypes(): ReadonlyMap<Node, AnalysisType> {
    const result = new Map<Node, AnalysisType>();
    for (const resolution of this.selectedCallResolutions) {
      result.set(resolution.call, resolution.resolvedOverload);
    }
    return result;
  }

  /** Resolved identifier bindings for backend-safe symbol rewriting. */
  getIdentifierResolutions(): readonly IdentifierResolution[] {
    return this.identifierResolutions;
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
    // Contextual call analysis may revisit a lambda after its initial loose
    // pass. Prefer the latest resolution so editor features see the refined
    // parameter type rather than the provisional `unknown` symbol.
    for (let index = this.identifierResolutions.length - 1; index >= 0; index -= 1) {
      const resolution = this.identifierResolutions[index]!;
      const range = this.nodeToRange(resolution.identifier);
      if (range && this.rangeContains(range, line, character)) {
        return { symbol: resolution.symbol, range };
      }
    }

    const jsxAttribute = this.getJsxAttributeResolutionAt(line, character);
    if (jsxAttribute) {
      return { symbol: jsxAttribute.resolution.symbol, range: jsxAttribute.range };
    }

    const jsxElement = this.getJsxElementResolutionAt(line, character);
    if (jsxElement) {
      return { symbol: jsxElement.resolution.symbol, range: jsxElement.range };
    }

    const visible = this.getVisibleSymbolsAt(line, character);
    let best: AnalysisSymbolMatch | null = null;
    for (const symbol of visible) {
      if (symbol.declaredOffset < 0) {
        continue;
      }
      if (!(symbol.node instanceof Identifier)) {
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

  getJsxIntrinsicElementSymbols(): ReadonlyMap<string, AnalysisSymbol> {
    return this.jsxIntrinsicElementSymbols;
  }

  getJsxPropsAt(
    line: number,
    character: number
  ): { element: JsxElement; props: ReadonlyMap<string, AnalysisType> } | null {
    let best: { element: JsxElement; props: ReadonlyMap<string, AnalysisType>; range: AnalysisRange } | null = null;
    for (const [element, props] of this.jsxPropsByElement) {
      const range = this.nodeToRange(element);
      if (!range || !this.rangeContains(range, line, character)) {
        continue;
      }
      if (!best || this.rangeSize(range) < this.rangeSize(best.range)) {
        best = { element, props, range };
      }
    }
    return best ? { element: best.element, props: best.props } : null;
  }

  getJsxAttributeExpectedTypeAt(line: number, character: number): AnalysisType | null {
    let best: { type: AnalysisType; range: AnalysisRange } | null = null;
    for (const [element, props] of this.jsxPropsByElement) {
      for (const attribute of element.attributes) {
        if (!(attribute instanceof JsxAttribute)) {
          continue;
        }
        const type = props.get(attribute.name);
        const range = this.nodeToRange(attribute.value ?? attribute);
        if (!type || !range || !this.rangeContains(range, line, character)) {
          continue;
        }
        if (!best || this.rangeSize(range) < this.rangeSize(best.range)) {
          best = { type, range };
        }
      }
    }
    return best?.type ?? null;
  }

  getJsxAttributeResolutionAt(
    line: number,
    character: number
  ): { resolution: JsxAttributeResolution; range: AnalysisRange } | null {
    for (const resolution of this.jsxAttributeResolutions) {
      const range = this.jsxAttributeNameRange(resolution.attribute);
      if (range && this.rangeContains(range, line, character)) {
        return { resolution, range };
      }
    }
    return null;
  }

  getJsxElementResolutionAt(
    line: number,
    character: number
  ): { resolution: JsxElementResolution; range: AnalysisRange } | null {
    for (const resolution of this.jsxElementResolutions) {
      for (const range of this.jsxElementTagRanges(resolution.element)) {
        if (this.rangeContains(range, line, character)) {
          return { resolution, range };
        }
      }
    }
    return null;
  }

  /**
   * Maps a cursor on a closing JSX component tag to the same character in its
   * opening tag. Closing tags do not own a second expression node, so editor
   * navigation must reuse the opening tag's bound identifier/member reference.
   */
  getJsxOpeningTagTargetAt(line: number, character: number): JsxOpeningTagTarget | null {
    const pending: Node[] = [this.program];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node instanceof JsxElement && !node.selfClosing && node.reference) {
        const [openingRange, closingRange] = this.jsxElementTagRanges(node);
        if (openingRange && closingRange && this.rangeContains(closingRange, line, character)) {
          const offset = Math.max(
            0,
            Math.min(character - closingRange.start.character, node.tagName.length)
          );
          return {
            position: {
              line: openingRange.start.line,
              character: openingRange.start.character + offset
            },
            closingRange
          };
        }
      }
      pending.push(...childNodes(node));
    }
    return null;
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
      const typeLabel = symbolMatch.symbol.valueType;
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

  private operatorRange(expression: Node): AnalysisRange | null {
    const token = expression instanceof BinaryExpression
      ? (expression as BinaryExpression).operatorToken
      : expression instanceof UnaryExpression
        ? expression.firstToken
        : undefined;
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

  private jsxAttributeNameRange(attribute: JsxAttribute): AnalysisRange | null {
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

  private jsxElementTagRanges(element: JsxElement): AnalysisRange[] {
    const firstToken = element.firstToken;
    if (!firstToken) {
      return [];
    }
    const openingStart = firstToken.range.start.column + 1;
    const ranges: AnalysisRange[] = [{
      start: { line: firstToken.range.start.line, character: openingStart },
      end: { line: firstToken.range.start.line, character: openingStart + element.tagName.length }
    }];
    const lastToken = element.lastToken;
    if (!element.selfClosing && lastToken) {
      const closingEnd = lastToken.range.start.column;
      ranges.push({
        start: { line: lastToken.range.start.line, character: closingEnd - element.tagName.length },
        end: { line: lastToken.range.start.line, character: closingEnd }
      });
    }
    return ranges;
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
