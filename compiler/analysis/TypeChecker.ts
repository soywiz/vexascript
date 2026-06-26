import type {
  ArrowFunctionExpression,
  AnnotationApplication,
  AnnotationStatement,
  ArrayBindingPattern,
  ArrayLiteral,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  BindingName,
  BlockStatement,
  CallExpression,
  ChainExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
  EnumMember,
  EnumStatement,
  Expr,
  ExprStatement,
  ExportStatement,
  ForStatement,
  FunctionParameter,
  FunctionExpression,
  TypeParameter,
  FunctionStatement,
  InterfaceStatement,
  InterfaceMethodMember,
  IfStatement,
  Identifier,
  ImportStatement,
  LabeledStatement,
  IntLiteral,
  MemberExpression,
  MissingExpression,
  NamedArgument,
  NewExpression,
  NamespaceStatement,
  NonNullExpression,
  ObjectBindingPattern,
  ObjectLiteral,
  ObjectProperty,
  ObjectSpreadProperty,
  OverloadableOperator,
  PropertyReferenceExpression,
  StringLiteral,
  SpreadExpression,
  BooleanLiteral,
  FloatLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  SatisfiesExpression,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TypeAliasStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VariableDeclarationKind,
  VarStatement,
  WhileStatement,
  WithStatement,
  JsxElement,
  JsxFragment,
  JsxExpressionContainer,
  JsxSpreadAttribute,
  JsxAttribute
} from "compiler/ast/ast";
import { memberExpressionFromPropertyReference } from "compiler/ast/ast";
import { bindingElementPropertyName, bindingElements, bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import type { Node } from "compiler/ast/ast";
import type {
  AnalysisSymbol,
  BoundAnalysis,
  CheckedAnalysis,
  FlowContext,
  IdentifierResolution,
  JsxAttributeResolution,
  OperatorResolution,
  SelectedCallResolution,
  Scope
} from "./model";
import {
  type AnalysisType,
  type BuiltinTypeName,
  BUILTIN_TYPE_NAMES,
  UNKNOWN_TYPE,
  arrayType,
  builtinType,
  functionType,
  intersectionType,
  isSameType,
  isUnknownType,
  literalType,
  namedType,
  objectType,
  objectTypeWithProperties,
  rangeType,
  tupleType,
  typeToString,
  unionType
} from "./types";
import {
  looksLikeFunctionTypeAnnotation,
  parseAssertionTypePredicateText,
  parseReadonlyContainerTypeText,
  parseObjectTypeAnnotation,
  parseFunctionTypeAnnotation,
  parseConditionalTypeText,
  parseMappedTypeMemberText,
  parseTemplateLiteralTypeText,
  parseTypeNameShape,
  splitArraySuffixTypeName,
  splitIndexedAccessTypeName,
  splitOptionalTypeSuffix,
  splitTopLevelDelimitedTypeText,
  splitTopLevelTypeText,
  stripEnclosingTypeParens,
  tupleElementTypeText
} from "./typeNames";
import { ANALYSIS_ISSUE_CODES } from "./issueCodes";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { getVexaScriptRuntimeProgram } from "compiler/runtime/vexascriptDeclarations";
import { declarationIndexForStatements } from "./declarationIndex";
import { walkAst } from "compiler/ast/traversal";
import { boxedInterfaceNameForBuiltin, expressionSnippet, isNumberLikeType, typeToDiagnosticLabel } from "./typeDisplay";
import {
  isDynamicPropertyName,
  isReadonlyPropertyName,
  normalizePropertyName,
  propertyEntries,
  propertyNamesMatch,
  propertyTypeAllowsUndefined,
  propertyTypeFrom,
  propertyTypeWithoutUndefined,
  stripReadonlyPropertyPrefix,
  toReadonlyPropertyName
} from "./propertyNames";
import { isBigIntType, isIntType, isLongType, isNullishType, isNumberType, isNumericFamilyType, isNumericType, isPrimitiveLikeOperatorType, isStringLikeType } from "./typeClassifiers";
import { isAsyncLike, statementAllowsLabeledContinue, statementAlwaysExits, statementListAlwaysExits, statementListPreventsSwitchFallthrough } from "./controlFlow";
import { combineTypes, elementTypeFromIterable, hasNullishUnionMember, isAsyncIteratorType, removeNullishFromType, resolveLiteralTypeName, spreadArgumentElementType, unwrapPromiseType } from "./typeOperations";

type EnumResolvedValue =
  | { kind: "constant-int"; value: number }
  | { kind: "constant-string"; value: string }
  | { kind: "computed-int" }
  | { kind: "computed-string" }
  | { kind: "invalid" };

type ExtensionPropertyInfo = {
  type: AnalysisType;
  receiverTypeArguments?: Identifier[];
  typeParameterNames: string[];
};

export class TypeChecker {
  private readonly issues: CheckedAnalysis["issues"] = [];
  private readonly identifierResolutions: IdentifierResolution[] = [];
  private readonly jsxAttributeResolutions: JsxAttributeResolution[] = [];
  private readonly operatorResolutions: OperatorResolution[] = [];
  private readonly selectedCallResolutions: SelectedCallResolution[] = [];
  private readonly assertionCallEffects: WeakMap<CallExpression, { narrowings: Map<string, AnalysisType>; expressionNarrowings: Map<string, AnalysisType> }> = new WeakMap();
  private readonly expressionTypes: Map<Node, AnalysisType> = new Map();
  private readonly autoAwaitExpressions: Set<Node> = new Set();
  private readonly asyncForStatements: Set<Node> = new Set();
  private readonly classStatementsByName: Map<string, ClassStatement> = new Map();
  private readonly functionStatementsByName: Map<string, FunctionStatement> = new Map();
  private readonly extensionOperatorsByReceiver: Map<string, FunctionStatement[]> = new Map();
  private readonly extensionMethodsByReceiver: Map<string, Map<string, AnalysisType>> = new Map();
  private readonly extensionPropertiesByReceiver: Map<string, Map<string, ExtensionPropertyInfo>> = new Map();
  private readonly importedExtensionPropertyNames: Set<string> = new Set();
  private readonly importedExtensionPropertyTypes: Map<string, AnalysisType> = new Map();
  private readonly importedBindingNames: Set<string> = new Set();
  private readonly externalNamedTypeNames: Set<string> = new Set();
  private readonly nonExternalNamedTypeNames: Set<string> = new Set();
  private readonly externalDeclarationNodes: WeakSet<Node> = new WeakSet();
  // Class/interface declarations that belong to the analyzed file itself (as
  // opposed to imported, ambient, or runtime declarations). Used to scope the
  // `override`-required rule to the project's own VexaScript types.
  private readonly programDeclaredTypeNodes: WeakSet<Node> = new WeakSet();
  private readonly enumStatementsByName: Map<string, EnumStatement> = new Map();
  private readonly enumMemberResolutionCache: WeakMap<EnumMember, EnumResolvedValue> = new WeakMap();
  private readonly enumStatementMemberMapCache: WeakMap<EnumStatement, Map<string, EnumMember>> = new WeakMap();
  private readonly namespaceStatementsByName: Map<string, NamespaceStatement> = new Map();
  private readonly interfaceStatementsByName: Map<string, InterfaceStatement> = new Map();
  private readonly typeAliasStatementsByName: Map<string, TypeAliasStatement> = new Map();
  private readonly varStatementsByName: Map<string, VarStatement> = new Map();
  private readonly annotationStatementsByName: Map<string, AnnotationStatement> = new Map();
  private readonly activeTypeParameterScopes: Array<Set<string>> = [];
  private readonly activeTypeParameterConstraintScopes: Array<Map<string, AnalysisType>> = [];
  private readonly namedTypeMembersCache: Map<string, Map<string, AnalysisType> | null> = new Map();
  private readonly resolvingNamedTypeMembers: Set<string> = new Set();
  private readonly setterOnlyMembersCache: Map<string, Set<string>> = new Map();
  private readonly pureWriteTargetNodes = new WeakSet<Node>();
  private readonly activeTypeAliasNames: Set<string> = new Set();
  private readonly resolvingLooseTypeQueries: Set<string> = new Set();
  private readonly generatorFunctionStack: boolean[] = [];
  private readonly syncFunctionStack: boolean[] = [];
  // Tracks whether the innermost enclosing function is async-like (declared `async` or `sync`).
  // `await` is permitted in those bodies, and they participate in pervasive auto-await of
  // Promise-typed expressions. Plain functions do not (the stack handles nesting).
  private readonly asyncLikeFunctionStack: boolean[] = [];
  private readonly assignabilityChecksInProgress: Set<string> = new Set();
  private readonly analysisTypeIds: WeakMap<object, number> = new WeakMap();
  private readonly explicitlyUnknownIdentifiers: WeakSet<object> = new WeakSet();
  private readonly unresolvedImportedIdentifiers: WeakSet<object> = new WeakSet();
  private nextAnalysisTypeId = 1;

  constructor(
    private readonly program: Program,
    private readonly bound: BoundAnalysis,
    externalDeclarations: readonly Statement[] = [],
    ambientDeclarations: readonly Statement[] = [],
    private readonly invalidImportedBindings: ReadonlySet<string> = new Set(),
    private readonly sourceLanguage: "vexascript" | "typescript" = "vexascript"
  ) {
    const runtimeProgram = getEcmaScriptRuntimeProgram();
    const vexaRuntimeProgram = getVexaScriptRuntimeProgram();
    this.collectExternalDeclarationNodes(externalDeclarations);
    this.collectFunctionStatements(runtimeProgram.body);
    this.collectClassStatements(runtimeProgram.body, this.nonExternalNamedTypeNames);
    this.collectClassStatements(vexaRuntimeProgram.body, this.nonExternalNamedTypeNames);
    this.collectEnumStatements(runtimeProgram.body, this.nonExternalNamedTypeNames);
    this.collectInterfaceStatements(runtimeProgram.body, this.nonExternalNamedTypeNames);
    this.collectInterfaceStatements(vexaRuntimeProgram.body, this.nonExternalNamedTypeNames);
    this.collectTypeAliasStatements(runtimeProgram.body, this.nonExternalNamedTypeNames);
    this.collectTypeAliasStatements(vexaRuntimeProgram.body, this.nonExternalNamedTypeNames);
    this.collectVarStatements(vexaRuntimeProgram.body, this.nonExternalNamedTypeNames);
    this.collectAnnotationStatements(vexaRuntimeProgram.body);
    // An explicit import shadows the ambient runtime declaration of the same
    // name. Drop the runtime declarations first so the imported (external)
    // declarations registered below win, instead of being deleted by this pass.
    this.removeRuntimeDeclarationsShadowedByImports(program);
    // Imported (cross-file) declarations are registered for name/member
    // resolution only. They are never visited or re-checked because the
    // statement walk only traverses this program's body. Local declarations are
    // collected afterwards so they win on name clashes.
    this.collectFunctionStatements(ambientDeclarations);
    this.collectClassStatements(ambientDeclarations, this.nonExternalNamedTypeNames);
    this.collectEnumStatements(ambientDeclarations, this.nonExternalNamedTypeNames);
    this.collectInterfaceStatements(ambientDeclarations, this.nonExternalNamedTypeNames);
    this.collectTypeAliasStatements(ambientDeclarations, this.nonExternalNamedTypeNames);
    this.collectVarStatements(ambientDeclarations, this.nonExternalNamedTypeNames);
    this.collectNamespaceStatements(ambientDeclarations, this.nonExternalNamedTypeNames);
    this.collectAnnotationStatements(ambientDeclarations);
    this.collectFunctionStatements(externalDeclarations);
    this.collectClassStatements(externalDeclarations, this.externalNamedTypeNames);
    this.collectEnumStatements(externalDeclarations, this.externalNamedTypeNames);
    this.collectInterfaceStatements(externalDeclarations, this.externalNamedTypeNames);
    this.collectTypeAliasStatements(externalDeclarations, this.externalNamedTypeNames);
    this.collectVarStatements(externalDeclarations, this.externalNamedTypeNames);
    this.collectNamespaceStatements(externalDeclarations, this.externalNamedTypeNames);
    this.collectAnnotationStatements(externalDeclarations);
    // Also collect declarations nested inside namespace bodies so types like
    // `moment.Moment` (declared as `namespace moment { interface Moment }`) are
    // available for member resolution when referenced as namedType("Moment").
    const nestedAmbientDeclarations = this.collectNestedNamespaceDeclarations(ambientDeclarations);
    const nestedExternalDeclarations = this.collectNestedNamespaceDeclarations(externalDeclarations);
    this.collectClassStatements(nestedAmbientDeclarations, this.nonExternalNamedTypeNames);
    this.collectClassStatements(nestedExternalDeclarations, this.externalNamedTypeNames);
    this.collectInterfaceStatements(nestedAmbientDeclarations, this.nonExternalNamedTypeNames);
    this.collectInterfaceStatements(nestedExternalDeclarations, this.externalNamedTypeNames);
    this.collectTypeAliasStatements(nestedAmbientDeclarations, this.nonExternalNamedTypeNames);
    this.collectTypeAliasStatements(nestedExternalDeclarations, this.externalNamedTypeNames);
    this.collectVarStatements(nestedAmbientDeclarations, this.nonExternalNamedTypeNames);
    this.collectVarStatements(nestedExternalDeclarations, this.externalNamedTypeNames);
    // Imported extension operator overloads (e.g. `import { operator+ }`) are
    // registered so a cross-file operator like `a + b` resolves to the overload.
    this.collectExtensionOperators(ambientDeclarations);
    this.collectExtensionOperators(externalDeclarations);
    this.collectExtensionProperties(externalDeclarations, bound.rootScope);
    this.collectExtensionMethods(externalDeclarations);
    this.collectFunctionStatements(program.body);
    this.collectClassStatements(program.body, this.nonExternalNamedTypeNames);
    this.collectExtensionOperators(program);
    this.collectExtensionMethods(program);
    this.collectImportedBindingNames(program);
    this.collectUnresolvedImportedIdentifiers(program);
    this.collectImportedExtensionPropertyNames(program);
    this.collectEnumStatements(program.body, this.nonExternalNamedTypeNames);
    this.collectNamespaceStatements(program.body, this.nonExternalNamedTypeNames);
    this.collectInterfaceStatements(program.body, this.nonExternalNamedTypeNames);
    this.collectTypeAliasStatements(program.body, this.nonExternalNamedTypeNames);
    this.collectVarStatements(program.body, this.nonExternalNamedTypeNames);
    this.collectAnnotationStatements(program.body);
    for (const statement of program.body) {
      walkAst(statement, (node) => {
        if (node.kind === "ClassStatement" || node.kind === "InterfaceStatement") {
          this.programDeclaredTypeNodes.add(node);
        }
      });
    }
    this.collectExplicitlyUnknownIdentifiers(program);
  }

  private collectExplicitlyUnknownIdentifiers(program: Program): void {
    walkAst(program, (node) => {
      const candidate = node as Node & { name?: BindingName; typeAnnotation?: Node };
      const typeAnnotation = candidate.typeAnnotation as (Node & { kind: "Identifier"; name: string }) | undefined;
      if (typeAnnotation?.kind !== "Identifier" || typeAnnotation.name !== "unknown" || !candidate.name) {
        return;
      }
      for (const identifier of bindingIdentifiers(candidate.name)) {
        this.explicitlyUnknownIdentifiers.add(identifier);
      }
    });
  }

  private collectUnresolvedImportedIdentifiers(program: Program): void {
    for (const statement of program.body) {
      if (statement.kind !== "ImportStatement") continue;
      const importStatement = statement as ImportStatement;
      const bindings = [
        ...(importStatement.defaultImport ? [importStatement.defaultImport] : []),
        ...(importStatement.namespaceImport ? [importStatement.namespaceImport] : []),
        ...importStatement.specifiers.map((specifier) => specifier.local ?? specifier.imported)
      ];
      for (const binding of bindings) {
        const symbol = this.bound.rootScope.symbols.get(binding.name);
        if (this.invalidImportedBindings.has(binding.name) && symbol?.type && isUnknownType(symbol.type)) {
          this.unresolvedImportedIdentifiers.add(binding);
        }
      }
    }
  }

  private shouldReportUnknownCallable(callee: Expr, scope: Scope): boolean {
    if (callee.kind !== "Identifier") {
      return false;
    }
    const identifier = callee as Identifier;
    const usageOffset = identifier.firstToken?.range.start.offset;
    const symbol = this.resolve(identifier.name, scope, usageOffset);
    return !!symbol && this.unresolvedImportedIdentifiers.has(symbol.node);
  }

  private collectAnnotationStatements(statements: readonly Statement[]): void {
    for (const statement of declarationIndexForStatements([...statements]).annotations) {
      this.annotationStatementsByName.set(statement.name.name, statement);
    }
  }

  private knownNamedTypeExists(name: string): boolean {
    return this.typeAliasStatementsByName.has(name)
      || this.interfaceStatementsByName.has(name)
      || this.classStatementsByName.has(name)
      || this.enumStatementsByName.has(name)
      || this.namespaceStatementsByName.has(name);
  }

  private resolveQualifiedTypeMemberType(type: AnalysisType, memberName: string): AnalysisType | null {
    if (type.kind === "union") {
      const memberTypes = type.types
        .map((memberType) => this.resolveQualifiedTypeMemberType(memberType, memberName))
        .filter((memberType): memberType is AnalysisType => memberType !== null);
      if (memberTypes.length === 0) {
        return null;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (type.kind === "intersection") {
      const memberTypes = type.types
        .map((memberType) => this.resolveQualifiedTypeMemberType(memberType, memberName))
        .filter((memberType): memberType is AnalysisType => memberType !== null);
      if (memberTypes.length === 0) {
        return null;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (type.kind === "object") {
      return type.properties[memberName] ?? null;
    }
    if (type.kind === "named") {
      const members = this.resolveNamedTypeMembers(type);
      return members?.get(memberName) ?? null;
    }
    return null;
  }

  private resolveQualifiedTypeName(
    qualifiedTypeName: string,
    resolvedTypeArguments: AnalysisType[],
    node: Node,
    scope: Scope
  ): AnalysisType | null {
    const path = qualifiedTypeName.split(".").map((segment) => segment.trim()).filter(Boolean);
    if (path.length < 2) {
      return null;
    }

    const usageOffset = node.firstToken?.range.start.offset;
    const symbol = this.resolve(path[0]!, scope, usageOffset);
    let currentType = symbol?.type ?? null;
    if (!currentType) {
      return null;
    }

    for (const memberName of path.slice(1)) {
      currentType = this.resolveQualifiedTypeMemberType(currentType, memberName);
      if (!currentType) {
        return null;
      }
    }

    if (currentType.kind === "named" && resolvedTypeArguments.length > 0) {
      this.validateNamedTypeArgumentConstraints(currentType.name, resolvedTypeArguments, node, scope);
      const typeAlias = this.typeAliasStatementsByName.get(currentType.name);
      return typeAlias
        ? this.resolveTypeAliasTarget(typeAlias, resolvedTypeArguments, scope)
        : namedType(currentType.name, resolvedTypeArguments);
    }

    return currentType;
  }

  private isNameVisibleFromExternalDeclarations(name: string, node: Node): boolean {
    return this.importedBindingNames.has(name)
      || this.nonExternalNamedTypeNames.has(name)
      || !this.externalNamedTypeNames.has(name)
      || this.externalDeclarationNodes.has(node);
  }

  private collectExternalDeclarationNodes(statements: readonly Statement[]): void {
    for (const statement of statements) {
      walkAst(statement, (node) => {
        this.externalDeclarationNodes.add(node);
      });
    }
  }

  check(): CheckedAnalysis {
    this.visitProgram(this.program, this.bound.rootScope, { loopDepth: 0, switchDepth: 0, labels: [] });
    return {
      issues: [...this.issues],
      identifierResolutions: [...this.identifierResolutions],
      jsxAttributeResolutions: [...this.jsxAttributeResolutions],
      operatorResolutions: [...this.operatorResolutions],
      expressionTypes: this.expressionTypes,
      selectedCallResolutions: [...this.selectedCallResolutions],
      autoAwaitExpressions: this.autoAwaitExpressions,
      asyncForStatements: this.asyncForStatements
    };
  }

  private scopeFor(node: Node, fallback: Scope): Scope {
    if (fallback.node === node) return fallback;
    const boundScope = this.bound.scopeByNode.get(node);
    if (!boundScope) return fallback;
    const mergeFallbackNarrowings = (scope: Scope): Scope => {
      const mergedSymbols = new Map(scope.symbols);
      for (const [name, fallbackSymbol] of fallback.symbols) {
        const currentSymbol = mergedSymbols.get(name);
        if (
          !currentSymbol ||
          (currentSymbol.declaredOffset !== fallbackSymbol.declaredOffset && currentSymbol.node !== fallbackSymbol.node)
        ) {
          continue;
        }
        if (currentSymbol.type === fallbackSymbol.type && currentSymbol.valueType === fallbackSymbol.valueType) {
          continue;
        }
        mergedSymbols.set(name, {
          ...currentSymbol,
          ...(fallbackSymbol.type !== undefined ? { type: fallbackSymbol.type } : {}),
          ...(fallbackSymbol.valueType !== undefined ? { valueType: fallbackSymbol.valueType } : {})
        });
      }
      const mergedNarrowedExpressionTypes = fallback.narrowedExpressionTypes
        ? new Map(fallback.narrowedExpressionTypes)
        : scope.narrowedExpressionTypes;
      return {
        ...scope,
        symbols: mergedSymbols,
        ...(mergedNarrowedExpressionTypes ? { narrowedExpressionTypes: mergedNarrowedExpressionTypes } : {})
      };
    };
    if (boundScope.parent && boundScope.parent !== fallback) {
      return mergeFallbackNarrowings({ ...boundScope, parent: fallback });
    }
    return mergeFallbackNarrowings(boundScope);
  }

  private isInsideGeneratorFunction(): boolean {
    return this.generatorFunctionStack[this.generatorFunctionStack.length - 1] === true;
  }

  private withGeneratorFunction<T>(isGenerator: boolean, run: () => T): T {
    this.generatorFunctionStack.push(isGenerator);
    try {
      return run();
    } finally {
      this.generatorFunctionStack.pop();
    }
  }

  // True when traversal is inside a function whose innermost enclosing function is
  // async-like (declared `async` or `sync`). `await` is permitted in those bodies.
  private isInsideAsyncLikeFunction(): boolean {
    return this.asyncLikeFunctionStack[this.asyncLikeFunctionStack.length - 1] === true;
  }

  private withAsyncLikeFunction<T>(isAsyncLike: boolean, run: () => T): T {
    this.asyncLikeFunctionStack.push(isAsyncLike);
    try {
      return run();
    } finally {
      this.asyncLikeFunctionStack.pop();
    }
  }

  // True when the innermost enclosing function is `sync`. Auto-await and the `go` opt-out are only
  // meaningful inside `sync` functions (Kotlin-suspend-like); `async` behaves like TypeScript.
  private isInsideSyncFunction(): boolean {
    return this.syncFunctionStack[this.syncFunctionStack.length - 1] === true;
  }

  private withSyncFunction<T>(isSync: boolean, run: () => T): T {
    this.syncFunctionStack.push(isSync);
    try {
      return run();
    } finally {
      this.syncFunctionStack.pop();
    }
  }

  // True when traversal is inside any function body rather than module/global scope.
  // Every function visit pushes onto the sync-function stack, so a non-empty stack
  // means an enclosing function exists.
  private isInsideFunction(): boolean {
    return this.syncFunctionStack.length > 0;
  }

  private visitProgram(program: Program, scope: Scope, flow: FlowContext): void {
    for (const statement of program.body) {
      this.visitStatement(statement, scope, flow);
    }
  }

  private visitStatement(statement: Statement, scope: Scope, flow: FlowContext): void {
    this.visitStatementAnnotations(statement, scope);
    switch (statement.kind) {
      case "ExportStatement": {
        const exportStatement = statement as ExportStatement;
        if (!exportStatement.from) {
          for (const specifier of exportStatement.specifiers ?? []) {
            this.resolveIdentifierType(specifier.local ?? specifier.exported, scope);
          }
        }
        if (exportStatement.declaration) {
          this.visitStatement(exportStatement.declaration, scope, flow);
        }
        return;
      }
      case "VarStatement":
        this.visitVarStatement(statement as VarStatement, scope);
        return;
      case "FunctionStatement":
        this.visitFunctionStatement(statement as FunctionStatement, scope);
        return;
      case "ClassStatement":
        this.visitClassStatement(statement as ClassStatement, scope);
        return;
      case "EnumStatement":
        this.visitEnumStatement(statement as EnumStatement, scope);
        return;
      case "InterfaceStatement":
        this.visitInterfaceStatement(statement as InterfaceStatement, scope);
        return;
      case "TypeAliasStatement":
        this.visitTypeAliasStatement(statement as TypeAliasStatement, scope);
        return;
      case "NamespaceStatement": {
        const namespaceStatement = statement as NamespaceStatement;
        if (namespaceStatement.globalAugmentation) {
          for (const bodyStatement of namespaceStatement.body.body) {
            this.visitStatement(bodyStatement, scope, flow);
          }
          return;
        }
        const namespaceScope = this.scopeFor(namespaceStatement, scope);
        for (const bodyStatement of namespaceStatement.body.body) {
          this.visitStatement(bodyStatement, namespaceScope, flow);
        }
        return;
      }
      case "AnnotationStatement":
        return;
      case "ExprStatement":
        this.visitExprStatement(statement as ExprStatement, scope);
        return;
      case "BlockStatement":
        this.visitBlockStatement(statement as BlockStatement, scope, flow);
        return;
      case "WhileStatement": {
        const whileStatement = statement as WhileStatement;
        this.visitExpression(whileStatement.condition, scope);
        const loopFlow: FlowContext = {
          ...flow,
          loopDepth: flow.loopDepth + 1,
          switchDepth: flow.switchDepth
        };
        const loopScope = this.scopeFor(whileStatement, scope);
        this.visitStatement(whileStatement.body, loopScope, loopFlow);
        return;
      }
      case "DoWhileStatement": {
        const doWhileStatement = statement as DoWhileStatement;
        const loopFlow: FlowContext = {
          ...flow,
          loopDepth: flow.loopDepth + 1,
          switchDepth: flow.switchDepth
        };
        const loopScope = this.scopeFor(doWhileStatement, scope);
        this.visitStatement(doWhileStatement.body, loopScope, loopFlow);
        this.visitExpression(doWhileStatement.condition, scope);
        return;
      }
      case "ForStatement":
        this.visitForStatement(statement as ForStatement, scope, flow);
        return;
      case "IfStatement":
        this.visitIfStatement(statement as IfStatement, scope, flow);
        return;
      case "SwitchStatement":
        this.visitSwitchStatement(statement as SwitchStatement, scope, flow);
        return;
      case "WithStatement": {
        const withStatement = statement as WithStatement;
        this.visitExpression(withStatement.object, scope);
        const withScope = this.scopeFor(withStatement, scope);
        this.visitStatement(withStatement.body, withScope, flow);
        return;
      }
      case "LabeledStatement": {
        const labeled = statement as LabeledStatement;
        if (flow.labels?.some((label) => label.name === labeled.label.name)) {
          this.issues.push({
            message: `Duplicate active statement label '${labeled.label.name}'`,
            node: labeled.label
          });
        }
        const labels = [
          ...(flow.labels ?? []),
          { name: labeled.label.name, allowsContinue: statementAllowsLabeledContinue(labeled.body) }
        ];
        this.visitStatement(labeled.body, scope, { ...flow, labels });
        return;
      }
      case "ReturnStatement": {
        const returnStatement = statement as ReturnStatement;
        const expectedReturnType = flow.expectedReturnType;
        const preservesInferredReturnType = this.preservesInferredContextualReturnType(expectedReturnType, scope);
        const asyncReturnValueType =
          flow.inAsync === true && expectedReturnType && !preservesInferredReturnType
            ? this.getAsyncReturnValueType(expectedReturnType)
            : null;
        if (returnStatement.expression) {
          // A returned Promise is flattened by the surrounding async/sync function, so it is not
          // auto-awaited (mirroring plain `async` semantics).
          const actualReturnType = this.visitExpression(
            returnStatement.expression,
            scope,
            preservesInferredReturnType ? undefined : (asyncReturnValueType ?? expectedReturnType),
            true
          );
          if (
            expectedReturnType &&
            !preservesInferredReturnType &&
            !isUnknownType(expectedReturnType) &&
            !isUnknownType(actualReturnType) &&
            !this.returnExpressionIsAssignable(actualReturnType, expectedReturnType, asyncReturnValueType, flow.inAsync === true)
          ) {
            this.reportReturnTypeMismatch(actualReturnType, expectedReturnType, returnStatement);
          }
        } else if (
          expectedReturnType &&
          !(flow.inAsync === true
            ? this.asyncReturnValueIsOptional(expectedReturnType, asyncReturnValueType)
            : this.returnValueIsOptional(expectedReturnType))
        ) {
          this.issues.push({
            message: "A function whose declared return type is neither 'undefined' nor 'void' must return a value",
            node: returnStatement,
            code: ANALYSIS_ISSUE_CODES.RETURN_VALUE_REQUIRED
          });
        }
        return;
      }
      case "ThrowStatement": {
        const throwStatement = statement as ThrowStatement;
        this.visitExpression(throwStatement.expression, scope);
        return;
      }
      case "DeferStatement":
        this.visitExpression((statement as import("compiler/ast/ast").DeferStatement).expression, scope);
        return;
      case "TryStatement":
        this.visitTryStatement(statement as TryStatement, scope, flow);
        return;
      case "ContinueStatement": {
        const continueStatement = statement as import("compiler/ast/ast").ContinueStatement;
        if (continueStatement.label) {
          const target = flow.labels?.find((label) => label.name === continueStatement.label!.name);
          if (!target) {
            this.issues.push({
              message: `Undefined statement label '${continueStatement.label.name}'`,
              node: continueStatement.label
            });
          } else if (!target.allowsContinue) {
            this.issues.push({
              message: `Illegal 'continue' target '${continueStatement.label.name}' because the label does not reference a loop`,
              node: continueStatement.label
            });
          }
          return;
        }
        if (flow.loopDepth <= 0) {
          this.issues.push({
            message: "Illegal 'continue' statement outside of a loop",
            node: statement
          });
        }
        return;
      }
      case "BreakStatement": {
        const breakStatement = statement as import("compiler/ast/ast").BreakStatement;
        if (breakStatement.label) {
          const target = flow.labels?.find((label) => label.name === breakStatement.label!.name);
          if (!target) {
            this.issues.push({
              message: `Undefined statement label '${breakStatement.label.name}'`,
              node: breakStatement.label
            });
          }
          return;
        }
        if (flow.loopDepth <= 0 && flow.switchDepth <= 0) {
          this.issues.push({
            message: "Illegal 'break' statement outside of a loop or switch",
            node: statement
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private visitExprStatement(statement: ExprStatement, scope: Scope): void {
    this.visitExpression(statement.expression, scope);
    if (statement.expression.kind !== "CallExpression") {
      return;
    }
    const effect = this.assertionCallEffects.get(statement.expression as CallExpression);
    if (!effect) {
      return;
    }
    const narrowedScope = this.scopeWithNarrowings(scope, effect.narrowings, effect.expressionNarrowings);
    scope.symbols = narrowedScope.symbols;
    if (narrowedScope.narrowedExpressionTypes) {
      scope.narrowedExpressionTypes = narrowedScope.narrowedExpressionTypes;
    }
  }

  private visitStatementAnnotations(statement: Statement, scope: Scope): void {
    for (const annotation of statement.annotations ?? []) {
      this.visitAnnotationApplication(annotation, scope);
    }
  }

  private reportMissingParameterType(parameter: FunctionParameter): void {
    if (parameter.thisParameter === true || parameter.typeAnnotation || parameter.name.kind !== "Identifier") {
      return;
    }
    this.issues.push({
      message: `Parameter '${bindingNameText(parameter.name)}' must declare an explicit type annotation`,
      node: parameter.name,
      code: ANALYSIS_ISSUE_CODES.MISSING_PARAMETER_TYPE
    });
  }

  private visitAnnotationApplication(annotation: AnnotationApplication, scope: Scope): void {
    const usageOffset = annotation.name.firstToken?.range.start.offset;
    const symbol = this.resolve(annotation.name.name, scope, usageOffset);
    if (symbol?.kind === "annotation") {
      this.identifierResolutions.push({ identifier: annotation.name, symbol });
    }
    const declaration = this.resolveAnnotationStatement(annotation.name.name);
    if (!declaration) {
      this.issues.push({
        message: `Unknown annotation '${annotation.name.name}'`,
        node: annotation.name
      });
      for (const argument of annotation.arguments) {
        this.visitExpression(argument, scope);
      }
      return;
    }
    const parameterTypes = declaration.parameters.map((parameter) =>
      this.resolveTypeAnnotation(parameter.typeAnnotation, scope) ?? UNKNOWN_TYPE
    );
    const argumentTypes = annotation.arguments.map((argument) => this.visitExpression(argument, scope));
    this.validateAnnotationArguments(annotation, declaration, parameterTypes, argumentTypes);
  }

  private validateAnnotationArguments(
    annotation: AnnotationApplication,
    declaration: AnnotationStatement,
    parameterTypes: AnalysisType[],
    argumentTypes: AnalysisType[]
  ): void {
    const hasNamedArguments = annotation.arguments.some((arg) => arg.kind === "NamedArgument");

    if (hasNamedArguments) {
      this.validateNamedAnnotationArguments(annotation, declaration, parameterTypes, argumentTypes);
      return;
    }

    const requiredCount = declaration.parameters.filter((parameter) => parameter.defaultValue === undefined).length;
    const providedCount = annotation.arguments.length;
    const totalCount = declaration.parameters.length;

    if (providedCount < requiredCount) {
      this.issues.push({
        message: `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
        node: annotation.name
      });
    } else if (providedCount > totalCount) {
      this.issues.push({
        message: `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
        node: annotation.name
      });
      for (let index = totalCount; index < providedCount; index += 1) {
        this.issues.push({
          message: `Unexpected argument ${index + 1}; annotation expects at most ${totalCount} argument(s)`,
          node: annotation.arguments[index] ?? annotation.name
        });
      }
    }

    const comparableCount = Math.min(argumentTypes.length, parameterTypes.length);
    for (let index = 0; index < comparableCount; index += 1) {
      const expectedType = parameterTypes[index] ?? UNKNOWN_TYPE;
      const argumentType = argumentTypes[index] ?? UNKNOWN_TYPE;
      const argumentNode = annotation.arguments[index] ?? annotation.name;
      const parameter = declaration.parameters[index];
      const parameterName = parameter ? bindingNameText(parameter.name) : `arg${index + 1}`;
      if (isUnknownType(expectedType) || isUnknownType(argumentType) || this.isCallArgumentAssignable(argumentType, expectedType)) {
        continue;
      }
      this.issues.push({
        message: `Argument ${index + 1} of type '${typeToString(argumentType)}' is not assignable to parameter '${parameterName}' of type '${typeToString(expectedType)}'`,
        node: argumentNode
      });
      this.reportNestedMismatchContext(argumentType, expectedType, argumentNode);
    }
  }

  private validateNamedAnnotationArguments(
    annotation: AnnotationApplication,
    declaration: AnnotationStatement,
    parameterTypes: AnalysisType[],
    argumentTypes: AnalysisType[]
  ): void {
    const paramNames = declaration.parameters.map((p) => bindingNameText(p.name));
    const coveredIndices = new Set<number>();
    let seenNamed = false;

    for (let argIndex = 0; argIndex < annotation.arguments.length; argIndex += 1) {
      const arg = annotation.arguments[argIndex];
      const argType = argumentTypes[argIndex] ?? UNKNOWN_TYPE;

      if (arg?.kind !== "NamedArgument") {
        if (seenNamed) {
          this.issues.push({
            message: "Positional arguments cannot follow named arguments",
            node: arg ?? annotation.name
          });
          continue;
        }
        const paramIndex = argIndex;
        coveredIndices.add(paramIndex);
        const expectedType = parameterTypes[paramIndex] ?? UNKNOWN_TYPE;
        const paramName = declaration.parameters[paramIndex] ? bindingNameText(declaration.parameters[paramIndex]!.name) : `arg${paramIndex + 1}`;
        if (paramIndex >= declaration.parameters.length) {
          this.issues.push({
            message: `Unexpected argument ${paramIndex + 1}; annotation expects at most ${declaration.parameters.length} argument(s)`,
            node: arg ?? annotation.name
          });
        } else if (!isUnknownType(expectedType) && !isUnknownType(argType) && !this.isCallArgumentAssignable(argType, expectedType)) {
          this.issues.push({
            message: `Argument ${argIndex + 1} of type '${typeToString(argType)}' is not assignable to parameter '${paramName}' of type '${typeToString(expectedType)}'`,
            node: arg ?? annotation.name
          });
          this.reportNestedMismatchContext(argType, expectedType, arg ?? annotation.name);
        }
        continue;
      }

      seenNamed = true;
      const namedArg = arg as NamedArgument;
      const paramIndex = paramNames.indexOf(namedArg.name.name);

      if (paramIndex === -1) {
        this.issues.push({
          message: `Unknown named argument '${namedArg.name.name}'`,
          node: namedArg.name
        });
        continue;
      }
      if (coveredIndices.has(paramIndex)) {
        this.issues.push({
          message: `Duplicate named argument '${namedArg.name.name}'`,
          node: namedArg.name
        });
        continue;
      }
      coveredIndices.add(paramIndex);

      const expectedType = parameterTypes[paramIndex] ?? UNKNOWN_TYPE;
      if (!isUnknownType(expectedType) && !isUnknownType(argType) && !this.isCallArgumentAssignable(argType, expectedType)) {
        this.issues.push({
          message: `Argument of type '${typeToString(argType)}' is not assignable to parameter '${namedArg.name.name}' of type '${typeToString(expectedType)}'`,
          node: namedArg
        });
        this.reportNestedMismatchContext(argType, expectedType, namedArg);
      }
    }

    for (let paramIndex = 0; paramIndex < declaration.parameters.length; paramIndex += 1) {
      const parameter = declaration.parameters[paramIndex];
      if (!coveredIndices.has(paramIndex) && parameter?.defaultValue === undefined) {
        const paramName = parameter ? bindingNameText(parameter.name) : `arg${paramIndex + 1}`;
        this.issues.push({
          message: `Missing named argument '${paramName}'`,
          node: annotation.name
        });
      }
    }
  }

  private resolveAnnotationStatement(name: string): AnnotationStatement | null {
    return this.annotationStatementsByName.get(name) ?? null;
  }

  private validateVarDeclaration(
    declarationKind: VariableDeclarationKind,
    isDeclared: boolean | undefined,
    hasInitializer: boolean,
    hasDelegate: boolean,
    hasTypeAnnotation: boolean,
    nameNode: BindingName
  ): void {
    if (isDeclared) return;
    if ((declarationKind === "const" || declarationKind === "val") && !hasInitializer && !hasDelegate) {
      this.issues.push({
        message: `'${declarationKind}' declarations must be initialized`,
        node: nameNode
      });
    } else if (declarationKind === "var" && !hasInitializer && !hasDelegate && !hasTypeAnnotation) {
      this.issues.push({
        message: `Variable '${bindingNameText(nameNode)}' implicitly has an 'any' type`,
        node: nameNode
      });
    }
  }

  private visitVarStatement(statement: VarStatement, scope: Scope): void {
    if (statement.receiverType) {
      const receiverType = statement.receiverType;
      const typeParameterNames = statement.typeParameters?.map((parameter) => parameter.name.name) ?? [];
      this.withTypeParameters(typeParameterNames, () => {
        const extensionScope = this.scopeFor(statement, scope);
        this.resolveReceiverTypeAnnotation(receiverType, statement.receiverTypeArguments, extensionScope);
        const explicitType = this.resolveTypeAnnotation(statement.typeAnnotation, extensionScope);
        let initializerType = statement.initializer
          ? this.visitExpression(statement.initializer, extensionScope, explicitType)
          : UNKNOWN_TYPE;
        if (statement.accessors && statement.accessors.length > 0) {
          let getterType: AnalysisType | undefined;
          let setterType: AnalysisType | undefined;
          for (const accessor of statement.accessors) {
            if (accessor.accessorKind === "get" && accessor.parameters.length !== 0) {
              this.issues.push({
                message: `Getter '${accessor.name.name}' cannot declare parameters`,
                node: accessor.name
              });
            }
            if (accessor.accessorKind === "set" && accessor.parameters.length !== 1) {
              this.issues.push({
                message: `Setter '${accessor.name.name}' must declare exactly one parameter`,
                node: accessor.name
              });
            }

            const accessorScope = this.scopeFor(accessor, extensionScope);
            for (const parameter of accessor.parameters) {
              if (parameter.thisParameter === true) {
                continue;
              }
              this.reportMissingParameterType(parameter);
              const parameterType =
                this.resolveTypeAnnotation(parameter.typeAnnotation, accessorScope) ??
                (parameter.defaultValue ? this.visitExpression(parameter.defaultValue, accessorScope) : UNKNOWN_TYPE);
              this.validateRestParameterType(parameter, parameterType);
              for (const identifier of bindingIdentifiers(parameter.name)) {
                this.updateSymbolType(accessorScope, identifier.name, parameterType);
              }
            }

            if (accessor.accessorKind === "get") {
              const declaredGetterType = this.resolveTypeAnnotation(accessor.returnType, accessorScope);
              const actualGetterType = declaredGetterType
                ?? this.inferReturnTypeFromBlock(accessor.body);
              getterType = actualGetterType;
              if (
                explicitType &&
                actualGetterType &&
                !isUnknownType(explicitType) &&
                !isUnknownType(actualGetterType) &&
                !this.isTypeAssignable(actualGetterType, explicitType)
              ) {
                this.reportTypeMismatch(actualGetterType, explicitType, statement.name, accessor.body);
              }
            } else if (accessor.accessorKind === "set") {
              setterType = accessor.parameters[0]
                ? this.resolveTypeAnnotation(accessor.parameters[0].typeAnnotation, accessorScope) ?? UNKNOWN_TYPE
                : UNKNOWN_TYPE;
            }

            const accessorFlow: FlowContext = {
              loopDepth: 0,
              switchDepth: 0,
              labels: [],
              expectedReturnType: accessor.accessorKind === "set"
                ? builtinType("void")
                : explicitType ?? getterType ?? UNKNOWN_TYPE,
              inAsync: false,
              inGenerator: false
            };
            for (const bodyStatement of accessor.body.body) {
              this.visitStatement(bodyStatement, accessorScope, accessorFlow);
            }
          }

          if (
            explicitType &&
            setterType &&
            !isUnknownType(explicitType) &&
            !isUnknownType(setterType) &&
            !this.isTypeAssignable(setterType, explicitType)
          ) {
            this.reportTypeMismatch(setterType, explicitType, statement.name, statement.name);
          }

          initializerType = explicitType ?? getterType ?? setterType ?? UNKNOWN_TYPE;
        }
        if (
          explicitType &&
          statement.initializer &&
          !isUnknownType(explicitType) &&
          !isUnknownType(initializerType) &&
          !this.isTypeAssignable(initializerType, explicitType)
        ) {
          this.reportTypeMismatch(initializerType, explicitType, statement.name, statement.initializer ?? statement.delegate);
        }
        const propertyType = explicitType ?? initializerType;
        this.setExtensionProperty(
          receiverType,
          statement.receiverTypeArguments,
          bindingIdentifiers(statement.name)[0]!.name,
          propertyType,
          typeParameterNames
        );
      }, this.typeParameterConstraintMap(statement.typeParameters ?? [], scope));
      return;
    }
    if (statement.declarations && statement.declarations.length > 0) {
      for (const declaration of statement.declarations) {
        this.validateVarDeclaration(
          statement.declarationKind,
          statement.declared,
          !!declaration.initializer,
          !!declaration.delegate,
          !!declaration.typeAnnotation,
          declaration.name
        );
        const explicitType = this.resolveTypeAnnotation(declaration.typeAnnotation, scope);
        const delegateType = declaration.delegate
          ? this.visitExpression(declaration.delegate, scope)
          : undefined;
        const delegateValueType = delegateType ? this.variableDelegateValueType(delegateType) : undefined;
        const initializerType = declaration.initializer
          ? this.visitExpression(declaration.initializer, scope, explicitType)
          : delegateValueType;
        if (
          explicitType &&
          initializerType &&
          !isUnknownType(explicitType) &&
          !isUnknownType(initializerType) &&
          !this.isTypeAssignable(initializerType, explicitType)
        ) {
          this.reportTypeMismatch(initializerType, explicitType, declaration.name, declaration.initializer ?? declaration.delegate);
        }
        for (const element of bindingElements(declaration.name)) {
          if (element.initializer) this.visitExpression(element.initializer, scope);
        }
        if (declaration.delegate) {
          this.validateVariableDelegateType(delegateType ?? UNKNOWN_TYPE, declaration.delegate);
          if (bindingIdentifiers(declaration.name).length !== 1) {
            this.issues.push({
              message: "Delegated variables must use a single identifier binding",
              node: declaration.name
            });
          }
        }
        const inferredType = explicitType ?? initializerType ?? UNKNOWN_TYPE;
        this.validateBindingPatternSource(declaration.name, inferredType);
        this.ensureVariableBindingSymbols(scope, declaration.name, statement.declarationKind, inferredType);
        this.updateBindingSymbolTypes(scope, declaration.name, inferredType);
      }
      return;
    }

    this.validateVarDeclaration(
      statement.declarationKind,
      statement.declared,
      !!statement.initializer,
      !!statement.delegate,
      !!statement.typeAnnotation,
      statement.name
    );
    const explicitType = this.resolveTypeAnnotation(statement.typeAnnotation, scope);
    const delegateType = statement.delegate
      ? this.visitExpression(statement.delegate, scope)
      : undefined;
    const delegateValueType = delegateType ? this.variableDelegateValueType(delegateType) : undefined;
    const initializerType = statement.initializer
      ? this.visitExpression(statement.initializer, scope, explicitType)
      : delegateValueType;
    if (
      explicitType &&
      initializerType &&
      !isUnknownType(explicitType) &&
      !isUnknownType(initializerType) &&
      !this.isTypeAssignable(initializerType, explicitType)
    ) {
      this.reportTypeMismatch(initializerType, explicitType, statement.name, statement.initializer ?? statement.delegate);
    }
    for (const element of bindingElements(statement.name)) {
      if (element.initializer) this.visitExpression(element.initializer, scope);
    }
    if (statement.delegate) {
      this.validateVariableDelegateType(delegateType ?? UNKNOWN_TYPE, statement.delegate);
      if (bindingIdentifiers(statement.name).length !== 1) {
        this.issues.push({
          message: "Delegated variables must use a single identifier binding",
          node: statement.name
        });
      }
    }
    const inferredType = explicitType ?? initializerType ?? UNKNOWN_TYPE;
    this.validateBindingPatternSource(statement.name, inferredType);
    this.ensureVariableBindingSymbols(scope, statement.name, statement.declarationKind, inferredType);
    this.updateBindingSymbolTypes(scope, statement.name, inferredType);
  }

  private ensureVariableBindingSymbols(
    scope: Scope,
    binding: BindingName,
    declarationKind: VariableDeclarationKind,
    type: AnalysisType
  ): void {
    for (const identifier of bindingIdentifiers(binding)) {
      if (scope.symbols.has(identifier.name)) {
        continue;
      }
      scope.symbols.set(identifier.name, {
        name: identifier.name,
        kind: "variable",
        node: identifier,
        declaredOffset: identifier.firstToken?.range.start.offset ?? -1,
        isReadonly: declarationKind === "const" || declarationKind === "val",
        type,
        valueType: typeToString(type)
      });
    }
  }

  private validateVariableDelegateType(delegateType: AnalysisType, node: Node): void {
    if (isUnknownType(delegateType) || (delegateType.kind === "builtin" && delegateType.name === "any")) {
      return;
    }
    if (delegateType.kind === "tuple") {
      this.validateTupleDelegateShape(delegateType.elements, node);
      return;
    }
    if (delegateType.kind === "named") {
      if (this.memberTypeFromObjectType(delegateType, "value") === null) {
        this.issues.push({
          message: `Type '${delegateType.name}' is not a valid property delegate; it must have a 'value' getter or property`,
          node
        });
        return;
      }
      if (this.isSetterOnlyMember(delegateType.name, "value")) {
        this.issues.push({
          message: `Type '${delegateType.name}' is not a valid property delegate; property 'value' has no getter`,
          node
        });
        return;
      }
      return;
    }
    if (this.isValidVariableDelegateType(delegateType)) {
      return;
    }
    this.issues.push({
      message: `Type '${typeToString(delegateType)}' is not a valid property delegate; expected a function, tuple, or object with a 'value' property`,
      node
    });
  }

  private validateTupleDelegateShape(elements: AnalysisType[], node: Node): void {
    if (elements.length === 0) {
      this.issues.push({
        message: "Property delegate tuple must not be empty",
        node
      });
      return;
    }
    if (elements.length > 2) {
      this.issues.push({
        message: `Property delegate tuple must have 1 or 2 elements, got ${elements.length}`,
        node
      });
      return;
    }
    if (elements.length === 1) {
      return;
    }
    // elements.length === 2: [getter, setter]
    const setter = elements[1]!;
    const setterFunction = this.callableTypeFrom(setter);
    if (!setterFunction) {
      this.issues.push({
        message: `Second element of property delegate tuple must be a setter function, got '${typeToString(setter)}'`,
        node
      });
      return;
    }
    if (setterFunction.parameters.length === 0) {
      this.issues.push({
        message: "Setter function of property delegate tuple must have at least one parameter",
        node
      });
      return;
    }
    const getterOrValue = elements[0]!;
    const getterValueType = getterOrValue.kind === "function" ? getterOrValue.returnType : getterOrValue;
    const setterParamType = setterFunction.parameters[0]!.type;
    if (
      !isUnknownType(getterValueType) &&
      !isUnknownType(setterParamType) &&
      !this.isTypeAssignable(getterValueType, setterParamType)
    ) {
      this.issues.push({
        message: `Getter type '${typeToString(getterValueType)}' is not assignable to setter parameter type '${typeToString(setterParamType)}'`,
        node
      });
    }
  }

  private isSetterOnlyMember(typeName: string, propertyName: string): boolean {
    return this.setterOnlyMembersCache.get(typeName)?.has(propertyName) ?? false;
  }

  private isValidVariableDelegateType(delegateType: AnalysisType): boolean {
    if (isUnknownType(delegateType) || (delegateType.kind === "builtin" && delegateType.name === "any")) {
      return true;
    }
    if (delegateType.kind === "function") {
      return true;
    }
    if (delegateType.kind === "object") {
      return delegateType.properties["value"] !== undefined;
    }
    if (delegateType.kind === "named") {
      return this.memberTypeFromObjectType(delegateType, "value") !== null &&
        !this.isSetterOnlyMember(delegateType.name, "value");
    }
    if (delegateType.kind === "union") {
      return delegateType.types.every((member) => this.isValidVariableDelegateType(member));
    }
    return false;
  }

  private validateBindingPatternSource(binding: BindingName, sourceType: AnalysisType): void {
    if (binding.kind === "Identifier") {
      return;
    }
    if (binding.kind === "ArrayBindingPattern") {
      if (!this.canDestructureArrayBinding(sourceType)) {
        this.issues.push({
          message: `Type '${typeToString(sourceType)}' cannot be destructured with an array binding pattern`,
          node: binding
        });
      }
      return;
    }
    if (!this.canDestructureObjectBinding(sourceType)) {
      this.issues.push({
        message: `Type '${typeToString(sourceType)}' cannot be destructured with an object binding pattern`,
        node: binding
      });
    }
  }

  private canDestructureArrayBinding(sourceType: AnalysisType): boolean {
    if (isUnknownType(sourceType) || (sourceType.kind === "builtin" && sourceType.name === "any")) {
      return true;
    }
    if (sourceType.kind === "tuple" || sourceType.kind === "array") {
      return true;
    }
    if (sourceType.kind === "named" && sourceType.name === "Array") {
      return true;
    }
    if (sourceType.kind === "union") {
      return sourceType.types.every((member) => this.canDestructureArrayBinding(member));
    }
    return false;
  }

  private canDestructureObjectBinding(sourceType: AnalysisType): boolean {
    if (isUnknownType(sourceType) || (sourceType.kind === "builtin" && sourceType.name === "any")) {
      return true;
    }
    if (sourceType.kind === "object" || sourceType.kind === "named") {
      return true;
    }
    if (sourceType.kind === "union") {
      return sourceType.types.every((member) => this.canDestructureObjectBinding(member));
    }
    return false;
  }

  private variableDelegateValueType(delegateType: AnalysisType): AnalysisType {
    if (delegateType.kind === "function") {
      return delegateType.returnType;
    }
    if (delegateType.kind === "tuple") {
      const getterOrValueType = delegateType.elements[0] ?? UNKNOWN_TYPE;
      return getterOrValueType.kind === "function" ? getterOrValueType.returnType : getterOrValueType;
    }
    if (delegateType.kind === "object") {
      return delegateType.properties["value"] ?? UNKNOWN_TYPE;
    }
    if (delegateType.kind === "named") {
      return this.memberTypeFromObjectType(delegateType, "value") ?? UNKNOWN_TYPE;
    }
    return UNKNOWN_TYPE;
  }

  private updateBindingSymbolTypes(scope: Scope, binding: BindingName, sourceType: AnalysisType): void {
    if (binding.kind === "Identifier") {
      this.updateSymbolType(scope, binding.name, sourceType);
      return;
    }

    if (binding.kind === "ArrayBindingPattern") {
      this.updateArrayBindingSymbolTypes(scope, binding, sourceType);
      return;
    }

    this.updateObjectBindingSymbolTypes(scope, binding, sourceType);
  }

  private defineBindingParameterSymbols(scope: Scope, binding: BindingName, sourceType: AnalysisType): void {
    const define = (name: Identifier, type: AnalysisType): void => {
      scope.symbols.set(name.name, {
        name: name.name,
        kind: "parameter",
        node: name,
        declaredOffset: name.firstToken?.range.start.offset ?? -1,
        type,
        valueType: typeToString(type)
      });
    };
    this.visitBindingIdentifiersWithTypes(scope, binding, sourceType, define);
  }

  private updateArrayBindingSymbolTypes(scope: Scope, binding: ArrayBindingPattern, sourceType: AnalysisType): void {
    binding.elements.forEach((element, index) => {
      if (element.kind === "BindingHole") {
        return;
      }
      const inferredElementType = this.arrayBindingElementType(sourceType, index, element.rest === true);
      const elementType = element.typeAnnotation
        ? this.resolveTypeAnnotation(element.typeAnnotation, scope) ?? UNKNOWN_TYPE
        : inferredElementType;
      this.updateBindingSymbolTypes(scope, element.name, elementType);
    });
  }

  private updateObjectBindingSymbolTypes(scope: Scope, binding: ObjectBindingPattern, sourceType: AnalysisType): void {
    const excludedNames = new Set<string>();
    for (const element of binding.elements) {
      if (element.rest === true) {
        this.updateBindingSymbolTypes(scope, element.name, this.objectRestBindingType(sourceType, excludedNames));
        continue;
      }
      const propertyName = bindingElementPropertyName(element);
      const inferredPropertyType = propertyName ? this.memberTypeFromObjectType(sourceType, propertyName) ?? UNKNOWN_TYPE : UNKNOWN_TYPE;
      const propertyType = element.typeAnnotation
        ? this.resolveTypeAnnotation(element.typeAnnotation, scope) ?? UNKNOWN_TYPE
        : inferredPropertyType;
      if (propertyName) {
        excludedNames.add(propertyName);
      }
      this.updateBindingSymbolTypes(scope, element.name, propertyType);
    }
  }

  private visitBindingIdentifiersWithTypes(
    scope: Scope,
    binding: BindingName,
    sourceType: AnalysisType,
    visit: (identifier: Identifier, type: AnalysisType) => void
  ): void {
    if (binding.kind === "Identifier") {
      visit(binding, sourceType);
      return;
    }

    if (binding.kind === "ArrayBindingPattern") {
      binding.elements.forEach((element, index) => {
        if (element.kind === "BindingHole") {
          return;
        }
        const inferredElementType = this.arrayBindingElementType(sourceType, index, element.rest === true);
        const elementType = element.typeAnnotation
          ? this.resolveTypeAnnotation(element.typeAnnotation, scope) ?? UNKNOWN_TYPE
          : inferredElementType;
        this.visitBindingIdentifiersWithTypes(
          scope,
          element.name,
          elementType,
          visit
        );
      });
      return;
    }

    const excludedNames = new Set<string>();
    for (const element of binding.elements) {
      const propertyName = bindingElementPropertyName(element);
      const inferredPropertyType = element.rest === true
        ? this.objectRestBindingType(sourceType, excludedNames)
        : !propertyName
          ? UNKNOWN_TYPE
        : this.memberTypeFromObjectType(sourceType, propertyName) ?? UNKNOWN_TYPE;
      const propertyType = element.typeAnnotation
        ? this.resolveTypeAnnotation(element.typeAnnotation, scope) ?? UNKNOWN_TYPE
        : inferredPropertyType;
      if (!element.rest && propertyName) {
        excludedNames.add(propertyName);
      }
      this.visitBindingIdentifiersWithTypes(scope, element.name, propertyType, visit);
    }
  }

  private arrayBindingElementType(sourceType: AnalysisType, index: number, rest: boolean): AnalysisType {
    if (sourceType.kind === "tuple") {
      if (rest) {
        return this.arrayTypeFromElements(sourceType.elements.slice(index));
      }
      return sourceType.elements[index] ?? UNKNOWN_TYPE;
    }
    if (sourceType.kind === "array") {
      return rest ? sourceType : sourceType.elementType;
    }
    if (sourceType.kind === "named" && sourceType.name === "Array" && sourceType.typeArguments?.[0]) {
      const elementType = sourceType.typeArguments[0];
      return rest ? arrayType(elementType) : elementType;
    }
    if (sourceType.kind === "union") {
      const elementTypes = sourceType.types.map((member) => this.arrayBindingElementType(member, index, rest));
      return elementTypes.length === 1 ? elementTypes[0]! : unionType(elementTypes);
    }
    return UNKNOWN_TYPE;
  }

  private arrayTypeFromElements(elements: AnalysisType[]): AnalysisType {
    if (elements.length === 0) {
      return arrayType(UNKNOWN_TYPE);
    }
    return arrayType(elements.reduce((current, next) => this.commonSupertype(current, next)));
  }

  private operatorArityMessage(operator: OverloadableOperator, parameterCount: number): string | null {
    if (operator === "[]=") {
      return parameterCount >= 2 ? null : "Operator '[]=' must declare at least two parameters";
    }
    if (operator === "[]") {
      return parameterCount >= 1 ? null : "Operator '[]' must declare at least one parameter";
    }
    if (operator === "+" || operator === "-") {
      return parameterCount <= 1 ? null : `Operator '${operator}' must declare at most one parameter`;
    }
    return parameterCount === 1 ? null : `Operator '${operator}' must declare exactly one parameter`;
  }

  private visitFunctionStatement(statement: FunctionStatement, scope: Scope): void {
    if (statement.operator) {
      const nonThisParams = statement.parameters.filter((p) => p.thisParameter !== true);
      const arityMessage = this.operatorArityMessage(statement.operator, nonThisParams.length);
      if (arityMessage) {
        this.issues.push({
          message: arityMessage,
          node: statement.name
        });
      }
    }
      const asyncLike = isAsyncLike(statement);
    this.withGeneratorFunction(statement.generator === true, () => this.withSyncFunction(statement.sync === true, () => this.withAsyncLikeFunction(asyncLike, () => {
      const typeParameterNames = statement.typeParameters?.map((parameter) => parameter.name.name) ?? [];
      this.withTypeParameters(typeParameterNames, () => {
        const functionScope = this.scopeFor(statement, scope);
        if (statement.receiverType) {
          this.resolveReceiverTypeAnnotation(statement.receiverType, statement.receiverTypeArguments, functionScope);
        }
        const declaredReturnType = this.resolveTypeAnnotation(
          statement.returnType,
          statement.receiverType ? functionScope : scope
        );
        if (asyncLike) {
          this.validateAsyncReturnTypeAnnotation(declaredReturnType, statement.returnType ?? statement.name);
        }
        const returnType = declaredReturnType ?? UNKNOWN_TYPE;
        const fnType = this.buildFunctionType(statement.parameters, returnType, scope, statement.typeParameters ?? [], statement.returnType?.name);
        const existingSymbolType = scope.symbols.get(statement.name.name)?.type;
        if ((statement.missingBody !== true || statement.declared === true) && existingSymbolType?.kind !== "union") {
          this.updateSymbolType(scope, statement.name.name, fnType);
        }

        for (const parameter of statement.parameters) {
          if (parameter.thisParameter === true) {
            continue;
          }
          this.reportMissingParameterType(parameter);
          const parameterType = this.functionParameterType(parameter, functionScope);
          const effectiveParameterType = isUnknownType(parameterType) && parameter.defaultValue
            ? this.visitExpression(parameter.defaultValue, functionScope)
            : parameterType;
          this.validateRestParameterType(parameter, effectiveParameterType);
          this.updateBindingSymbolTypes(functionScope, parameter.name, effectiveParameterType);
          for (const element of bindingElements(parameter.name)) {
            if (element.initializer) this.visitExpression(element.initializer, functionScope);
          }
        }

        const functionFlow: FlowContext = {
          loopDepth: 0,
          switchDepth: 0,
          labels: [],
          expectedReturnType: returnType,
          inAsync: asyncLike,
          inGenerator: statement.generator === true
        };
        for (const bodyStatement of statement.body.body) {
          this.visitStatement(bodyStatement, functionScope, functionFlow);
        }
        const resolvedReturnType = this.finalizeFunctionReturnType(
          declaredReturnType,
          statement.body,
          asyncLike,
          statement.generator === true
        );
        if ((statement.missingBody !== true || statement.declared === true) && existingSymbolType?.kind !== "union") {
          this.updateSymbolType(
            scope,
            statement.name.name,
            this.buildFunctionType(statement.parameters, resolvedReturnType, scope, statement.typeParameters ?? [], statement.returnType?.name)
          );
        }
        if (statement.missingBody !== true) {
          this.reportMissingReturnPath(statement.body, resolvedReturnType, statement.name, asyncLike, statement.generator === true);
        }
      }, this.typeParameterConstraintMap(statement.typeParameters ?? [], scope));
    })));
  }

  private visitEnumStatement(statement: EnumStatement, scope: Scope): void {
    const enumScope = this.scopeFor(statement, scope);
    for (const [index, member] of statement.members.entries()) {
      if (member.initializer) {
        const initializerType = this.visitExpression(member.initializer, enumScope);
        if (!this.isTypeAssignable(initializerType, builtinType("int")) && !this.isTypeAssignable(initializerType, builtinType("string"))) {
          this.issues.push({
            message: `Enum member '${member.name.name}' initializer must be assignable to int or string`,
            node: member.initializer
          });
        }
        this.resolveEnumMemberValue(statement, member);
        continue;
      }

      if (index === 0) {
        this.enumMemberResolutionCache.set(member, { kind: "constant-int", value: 0 });
        continue;
      }

      const previous = statement.members[index - 1];
      const previousValue: EnumResolvedValue = previous
        ? this.resolveEnumMemberValue(statement, previous)
        : { kind: "invalid" };
      if (previousValue.kind === "constant-int") {
        this.enumMemberResolutionCache.set(member, {
          kind: "constant-int",
          value: previousValue.value + 1
        });
        continue;
      }

      this.enumMemberResolutionCache.set(member, { kind: "invalid" });
      this.issues.push({
        message: `Enum member '${member.name.name}' must have an initializer because the previous member is not a numeric constant`,
        node: member.name
      });
    }
  }

  private visitInterfaceStatement(statement: InterfaceStatement, scope: Scope): void {
    const interfaceScope = this.scopeFor(statement, scope);
    this.withTypeParameters(statement.typeParameters?.map((parameter) => parameter.name.name) ?? [], () => {
      for (const parentType of statement.extendsTypes ?? []) {
        this.resolveTypeAnnotation(parentType, interfaceScope);
      }
      for (const member of statement.members) {
        if (member.kind === "InterfacePropertyMember") {
          this.resolveTypeAnnotation(member.typeAnnotation, interfaceScope);
          continue;
        }
        const methodTypeParameterNames = member.typeParameters?.map((parameter) => parameter.name.name) ?? [];
        this.withTypeParameters(methodTypeParameterNames, () => {
          for (const parameter of member.parameters) {
            if (parameter.thisParameter === true) {
              continue;
            }
            this.resolveTypeAnnotation(parameter.typeAnnotation, interfaceScope);
          }
          if (member.returnType?.name !== "this") {
            this.resolveTypeAnnotation(member.returnType, interfaceScope);
          }
        }, this.typeParameterConstraintMap(member.typeParameters ?? [], interfaceScope));
      }
    }, this.typeParameterConstraintMap(statement.typeParameters ?? [], scope));
  }

  private visitTypeAliasStatement(statement: TypeAliasStatement, scope: Scope): void {
    this.withTypeParameters(statement.typeParameters?.map((parameter) => parameter.name.name) ?? [], () => {
      this.resolveTypeAnnotation(statement.targetType, scope);
    }, this.typeParameterConstraintMap(statement.typeParameters ?? [], scope));
  }

  private visitClassStatement(statement: ClassStatement, scope: Scope): void {
    const classType = namedType(statement.name.name);
    this.updateSymbolType(scope, statement.name.name, classType);

    const classScope = this.scopeFor(statement, scope);
    this.withTypeParameters(statement.typeParameters?.map((parameter) => parameter.name.name) ?? [], () => {
      if (statement.extendsType) {
        this.resolveTypeAnnotation(statement.extendsType, classScope);
      }
      for (const implementedType of statement.implementsTypes ?? []) {
        this.resolveTypeAnnotation(implementedType, classScope);
      }
      for (const parameter of statement.primaryConstructorParameters ?? []) {
        const parameterType = this.resolveTypeAnnotation(parameter.typeAnnotation, classScope)
          ?? (parameter.defaultValue ? this.visitExpression(parameter.defaultValue, classScope) : UNKNOWN_TYPE);
        if (
          parameter.typeAnnotation &&
          parameter.defaultValue &&
          !isUnknownType(parameterType)
        ) {
          const defaultValueType = this.visitExpression(parameter.defaultValue, classScope, parameterType);
          if (!isUnknownType(defaultValueType) && !this.isTypeAssignable(defaultValueType, parameterType)) {
            this.reportTypeMismatch(defaultValueType, parameterType, parameter.name, parameter.defaultValue);
          }
        }
      }
      for (const classDelegate of statement.classDelegates ?? []) {
        const expectedDelegateType = this.resolveTypeAnnotation(classDelegate.typeAnnotation, classScope);
        const expressionType = this.classDelegateExpressionType(classDelegate.expression, classScope, expectedDelegateType);
        if (expectedDelegateType && !isUnknownType(expressionType) && !this.isTypeAssignable(expressionType, expectedDelegateType)) {
          this.issues.push({
            message: `Class delegate for '${classDelegate.typeAnnotation.name}' has type '${typeToDiagnosticLabel(expressionType)}' but expected '${typeToDiagnosticLabel(expectedDelegateType)}'`,
            node: classDelegate.expression
          });
        }
        if (expectedDelegateType?.kind === "named") {
          for (const [memberName, memberType] of this.resolveNamedTypeMembers(expectedDelegateType)?.entries() ?? []) {
            if (!classScope.symbols.has(memberName)) {
              classScope.symbols.set(memberName, {
                name: memberName,
                kind: memberType.kind === "function" ? "method" : "variable",
                node: classDelegate.typeAnnotation,
                implicitReceiver: true,
                declaredOffset: -1,
                type: memberType,
                valueType: typeToString(memberType)
              });
              continue;
            }
            this.updateSymbolType(classScope, memberName, memberType);
          }
        }
      }

      for (const member of statement.members) {
        for (const annotation of member.annotations ?? []) {
          this.visitAnnotationApplication(annotation, classScope);
        }
        if (member.kind === "ClassFieldMember") {
          const field = member as ClassFieldMember;
          const annotationType = field.typeAnnotation
            ? this.resolveTypeAnnotation(field.typeAnnotation, classScope)
            : undefined;
          if (field.initializer) {
            const inferredType = this.visitExpression(field.initializer, classScope);
            if (!annotationType) {
              this.updateSymbolType(classScope, field.name.name, inferredType);
              this.namedTypeMembersCache.clear();
            }
          }
          continue;
        }

        const method = member as ClassMethodMember;
        if (method.abstract === true && statement.abstract !== true && statement.declared !== true) {
          this.issues.push({
            message: `Abstract member '${method.name.name}' can only appear within an abstract class`,
            node: method.name
          });
        }
        if (method.missingBody === true && statement.declared !== true && method.abstract !== true) {
          this.issues.push({
            message: `Class method '${method.name.name}' must have a body`,
            node: method.name
          });
        }
        if (method.accessorKind === "get" && method.parameters.length !== 0) {
          this.issues.push({
            message: `Getter '${method.name.name}' cannot declare parameters`,
            node: method.name
          });
        }
        if (method.accessorKind === "set" && method.parameters.length !== 1) {
          this.issues.push({
            message: `Setter '${method.name.name}' must declare exactly one parameter`,
            node: method.name
          });
        }
        if (method.operator) {
          const arityMessage = this.operatorArityMessage(method.operator, method.parameters.length);
          if (arityMessage) {
            this.issues.push({
              message: arityMessage,
              node: method.name
            });
          }
        }
        const methodTypeParameterNames = method.typeParameters?.map((parameter) => parameter.name.name) ?? [];
        const methodIsAsyncLike = isAsyncLike(method);
        this.withGeneratorFunction(method.generator === true, () => this.withSyncFunction(method.sync === true, () => this.withAsyncLikeFunction(methodIsAsyncLike, () => {
          this.withTypeParameters(methodTypeParameterNames, () => {
            const declaredMethodReturnType = this.resolveTypeAnnotation(method.returnType, classScope);
            if (methodIsAsyncLike) {
              this.validateAsyncReturnTypeAnnotation(declaredMethodReturnType, method.returnType ?? method.name);
            }
            const methodType = this.buildFunctionType(
              method.parameters,
              declaredMethodReturnType ?? builtinType("void"),
              classScope,
              method.typeParameters ?? [],
              method.returnType?.name
            );
            this.updateSymbolType(classScope, method.name.name, methodType);
            this.namedTypeMembersCache.clear();

            const methodScope = this.scopeFor(method, classScope);
            for (const parameter of method.parameters) {
              if (parameter.thisParameter === true) {
                continue;
              }
              this.reportMissingParameterType(parameter);
              const parameterType =
                this.resolveTypeAnnotation(parameter.typeAnnotation, methodScope) ??
                (parameter.defaultValue ? this.visitExpression(parameter.defaultValue, methodScope) : UNKNOWN_TYPE);
              this.validateRestParameterType(parameter, parameterType);
              for (const identifier of bindingIdentifiers(parameter.name)) this.updateSymbolType(methodScope, identifier.name, parameterType);
              for (const element of bindingElements(parameter.name)) {
                if (element.initializer) this.visitExpression(element.initializer, methodScope);
              }
            }
            const methodReturnType = declaredMethodReturnType ?? UNKNOWN_TYPE;
            const methodFlow: FlowContext = {
              loopDepth: 0,
              switchDepth: 0,
              labels: [],
              expectedReturnType: methodReturnType,
              inAsync: methodIsAsyncLike,
              inGenerator: method.generator === true
            };
            for (const bodyStatement of method.body.body) {
              this.visitStatement(bodyStatement, methodScope, methodFlow);
            }
            const resolvedMethodReturnType = this.finalizeFunctionReturnType(
              declaredMethodReturnType,
              method.body,
              methodIsAsyncLike,
              method.generator === true
            );
            this.updateSymbolType(
              classScope,
                method.name.name,
                this.buildFunctionType(
                  method.parameters,
                  resolvedMethodReturnType,
                  classScope,
                  method.typeParameters ?? [],
                  method.returnType?.name
                )
              );
            this.namedTypeMembersCache.clear();
            if (statement.declared !== true && method.missingBody !== true && method.abstract !== true) {
              this.reportMissingReturnPath(method.body, resolvedMethodReturnType, method.name, methodIsAsyncLike, method.generator === true);
            }
          }, this.typeParameterConstraintMap(method.typeParameters ?? [], classScope));
        })));
      }

      this.validateHeritageClauses(statement);
      this.validateOverrideMembers(statement);
      this.validateMissingOverrideModifiers(statement);
      this.validateImplementedInterfaces(statement);
      this.validateAbstractMemberImplementations(statement);
    }, this.typeParameterConstraintMap(statement.typeParameters ?? [], scope));
  }

  private classDelegateExpressionType(expression: Expr, scope: Scope, expectedType: AnalysisType | undefined): AnalysisType {
    if (expression.kind === "ObjectLiteral") {
      const objectLiteral = expression as ObjectLiteral;
      if (objectLiteral.properties.length === 1) {
        const property = objectLiteral.properties[0]!;
        if (property.kind === "ObjectProperty" && (property as ObjectProperty).shorthand === true) {
          return this.visitExpression((property as ObjectProperty).value, scope, expectedType);
        }
      }
    }

    const expressionType = this.visitExpression(expression, scope, expectedType);
    if (expressionType.kind === "function" && expressionType.parameters.length === 0) {
      return expressionType.returnType;
    }
    return expressionType;
  }

  private visitBlockStatement(statement: BlockStatement, scope: Scope, flow: FlowContext): void {
    const blockScope = this.scopeFor(statement, scope);
    for (const child of statement.body) {
      this.visitStatement(child, blockScope, flow);
    }
  }

  private visitForStatement(statement: ForStatement, scope: Scope, flow: FlowContext): void {
    const loopScope = this.scopeFor(statement, scope);
    const loopFlow: FlowContext = {
      ...flow,
      loopDepth: flow.loopDepth + 1,
      switchDepth: flow.switchDepth
    };

    if (statement.iterationKind && statement.iterator && statement.iterable) {
      if (statement.iterator.kind !== "VarStatement" && statement.iterator.kind !== "Identifier") {
        this.visitExpression(statement.iterator as Expr, loopScope);
      }

      const iterableType = this.visitExpression(statement.iterable, loopScope);
      if (isAsyncIteratorType(iterableType)) {
        this.asyncForStatements.add(statement);
      }
      const iteratorType = elementTypeFromIterable(iterableType);
      this.propagateIteratorType(statement.iterator, iteratorType, loopScope);
      this.visitStatement(statement.body, loopScope, loopFlow);
      return;
    }

    if (statement.initializer) {
      if (statement.initializer.kind === "VarStatement") {
        this.visitVarStatement(statement.initializer as VarStatement, loopScope);
      } else {
        this.visitExpression(statement.initializer as Expr, loopScope);
      }
    }
    if (statement.condition) {
      this.visitExpression(statement.condition, loopScope);
    }
    if (statement.update) {
      this.visitExpression(statement.update, loopScope);
    }
    this.visitStatement(statement.body, loopScope, loopFlow);
  }

  private visitIfStatement(statement: IfStatement, scope: Scope, flow: FlowContext): void {
    this.visitExpression(statement.condition, scope);
    const truthyNarrowings = this.conditionNarrowings(statement.condition, scope, true);
    const truthyExpressionNarrowings = this.conditionExpressionNarrowings(statement.condition, scope, true);
    const thenScope = this.scopeWithNarrowings(
      this.scopeFor(statement.thenBranch, scope),
      truthyNarrowings,
      truthyExpressionNarrowings
    );
    this.visitStatement(statement.thenBranch, thenScope, flow);

    const falsyNarrowings = this.conditionNarrowings(statement.condition, scope, false);
    const falsyExpressionNarrowings = this.conditionExpressionNarrowings(statement.condition, scope, false);
    if (statement.elseBranch) {
      const elseScope = this.scopeWithNarrowings(
        this.scopeFor(statement.elseBranch, scope),
        falsyNarrowings,
        falsyExpressionNarrowings
      );
      this.visitStatement(statement.elseBranch, elseScope, flow);
      if (statementAlwaysExits(statement.thenBranch) && !statementAlwaysExits(statement.elseBranch)) {
        this.applyFlowNarrowings(scope, falsyNarrowings, falsyExpressionNarrowings);
      } else if (!statementAlwaysExits(statement.thenBranch) && statementAlwaysExits(statement.elseBranch)) {
        this.applyFlowNarrowings(scope, truthyNarrowings, truthyExpressionNarrowings);
      }
      return;
    }

    if (statementAlwaysExits(statement.thenBranch)) {
      this.applyFlowNarrowings(scope, falsyNarrowings, falsyExpressionNarrowings);
    }
  }

  private applyFlowNarrowings(
    scope: Scope,
    narrowings: Map<string, AnalysisType>,
    expressionNarrowings: Map<string, AnalysisType>
  ): void {
    const narrowedScope = this.scopeWithNarrowings(scope, narrowings, expressionNarrowings);
    scope.symbols = narrowedScope.symbols;
    if (narrowedScope.narrowedExpressionTypes) {
      scope.narrowedExpressionTypes = narrowedScope.narrowedExpressionTypes;
    }
  }

  private scopeWithNarrowings(
    scope: Scope,
    narrowings: Map<string, AnalysisType>,
    expressionNarrowings: Map<string, AnalysisType> = new Map()
  ): Scope {
    if (narrowings.size === 0 && expressionNarrowings.size === 0) return scope;
    const narrowedScope: Scope = {
      ...(scope.parent ? { parent: scope.parent } : {}),
      node: scope.node,
      symbols: new Map(scope.symbols),
      ...(scope.narrowedExpressionTypes ? { narrowedExpressionTypes: new Map(scope.narrowedExpressionTypes) } : {}),
      children: scope.children
    };
    for (const [name, type] of narrowings) {
      const symbol = this.resolve(name, scope, undefined);
      if (!symbol) continue;
      narrowedScope.symbols.set(name, { ...symbol, type, valueType: typeToString(type) });
    }
    if (expressionNarrowings.size > 0) {
      const narrowedExpressionTypes = narrowedScope.narrowedExpressionTypes ?? new Map<string, AnalysisType>();
      for (const [key, type] of expressionNarrowings) {
        narrowedExpressionTypes.set(key, type);
      }
      narrowedScope.narrowedExpressionTypes = narrowedExpressionTypes;
    }
    return narrowedScope;
  }

  private conditionNarrowings(condition: Expr, scope: Scope, truthy: boolean): Map<string, AnalysisType> {
    if (condition.kind === "UnaryExpression" && (condition as UnaryExpression).operator === "!") {
      return this.conditionNarrowings((condition as UnaryExpression).argument, scope, !truthy);
    }
    if (condition.kind === "Identifier") {
      const identifier = condition as Identifier;
      const originalType = this.resolve(identifier.name, scope, identifier.firstToken?.range.start.offset)?.type ?? UNKNOWN_TYPE;
      const narrowedType = this.truthinessNarrowedType(originalType, truthy);
      if (!narrowedType || isSameType(narrowedType, originalType)) {
        return new Map();
      }
      return new Map([[identifier.name, narrowedType]]);
    }
    if (condition.kind !== "BinaryExpression") return new Map();
    const binary = condition as BinaryExpression;
    if ((binary.operator === "&&" && truthy) || (binary.operator === "||" && !truthy)) {
      return new Map([
        ...this.conditionNarrowings(binary.left, scope, truthy),
        ...this.conditionNarrowings(binary.right, scope, truthy)
      ]);
    }
    if (binary.left.kind !== "Identifier") return new Map();
    const identifier = binary.left as Identifier;
    const originalType = this.resolve(identifier.name, scope, identifier.firstToken?.range.start.offset)?.type ?? UNKNOWN_TYPE;
    let checkedType: AnalysisType | undefined;
    if ((binary.operator === "instanceof" || binary.operator === "is") && binary.right.kind === "Identifier") {
      checkedType = namedType((binary.right as Identifier).name);
    } else if (binary.operator === "in") {
      const range = this.visitExpression(binary.right, scope);
      if (range.kind === "range") checkedType = range.elementType;
    }
    if (!checkedType) return new Map();
    if (truthy) return new Map([[identifier.name, checkedType]]);
    if (originalType.kind !== "union") return new Map();
    const remaining = originalType.types.filter((member) => !this.isTypeAssignable(member, checkedType!));
    return new Map([[identifier.name, remaining.length === 1 ? remaining[0]! : unionType(remaining)]]);
  }

  private conditionExpressionNarrowings(condition: Expr, scope: Scope, truthy: boolean): Map<string, AnalysisType> {
    if (condition.kind === "UnaryExpression" && (condition as UnaryExpression).operator === "!") {
      return this.conditionExpressionNarrowings((condition as UnaryExpression).argument, scope, !truthy);
    }
    if (condition.kind === "BinaryExpression") {
      const binary = condition as BinaryExpression;
      if ((binary.operator === "&&" && truthy) || (binary.operator === "||" && !truthy)) {
        return new Map([
          ...this.conditionExpressionNarrowings(binary.left, scope, truthy),
          ...this.conditionExpressionNarrowings(binary.right, scope, truthy)
        ]);
      }
      return new Map();
    }

    const stableKey = this.stableExpressionKey(condition);
    if (!stableKey) {
      return new Map();
    }
    const originalType = this.expressionTypeForNarrowing(condition, scope);
    const narrowedType = this.truthinessNarrowedType(originalType, truthy);
    if (!narrowedType || isSameType(narrowedType, originalType)) {
      return new Map();
    }
    return new Map([[stableKey, narrowedType]]);
  }

  private expressionTypeForNarrowing(expression: Expr, scope: Scope): AnalysisType {
    const cached = this.expressionTypes.get(expression);
    if (cached) {
      return cached;
    }
    return this.visitExpression(expression, scope);
  }

  private truthinessNarrowedType(type: AnalysisType, truthy: boolean): AnalysisType | null {
    if (!hasNullishUnionMember(type)) {
      return null;
    }
    if (truthy) {
      return removeNullishFromType(type);
    }
    if (type.kind !== "union") {
      return null;
    }
    const nullishMembers = type.types.filter((member) => isNullishType(member));
    if (nullishMembers.length === 0) {
      return null;
    }
    return nullishMembers.length === 1 ? nullishMembers[0]! : unionType(nullishMembers);
  }

  private stableExpressionKey(expression: Expr): string | null {
    switch (expression.kind) {
      case "Identifier":
        return (expression as Identifier).name;
      case "MemberExpression": {
        const member = expression as MemberExpression;
        if (member.optional === true || member.computed) {
          return null;
        }
        const objectKey = this.stableExpressionKey(member.object);
        if (!objectKey) {
          return null;
        }
        if (member.property.kind === "Identifier") {
          return `${objectKey}.${(member.property as Identifier).name}`;
        }
        if (member.property.kind === "StringLiteral") {
          return `${objectKey}.${(member.property as StringLiteral).value}`;
        }
        if (member.property.kind === "IntLiteral" || member.property.kind === "FloatLiteral") {
          return `${objectKey}.${String((member.property as IntLiteral | FloatLiteral).value)}`;
        }
        return null;
      }
      case "NonNullExpression":
        return this.stableExpressionKey((expression as NonNullExpression).expression);
      case "AsExpression":
        return this.stableExpressionKey((expression as AsExpression).expression);
      case "SatisfiesExpression":
        return this.stableExpressionKey((expression as SatisfiesExpression).expression);
      default:
        return null;
    }
  }

  private narrowedExpressionType(scope: Scope, expression: Expr): AnalysisType | null {
    const stableKey = this.stableExpressionKey(expression);
    if (!stableKey) {
      return null;
    }
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const narrowed = current.narrowedExpressionTypes?.get(stableKey);
      if (narrowed) {
        return narrowed;
      }
    }
    return null;
  }

  private assertionEffectForCall(
    call: CallExpression,
    calleeType: AnalysisType & { kind: "function" },
    scope: Scope
  ): { narrowings: Map<string, AnalysisType>; expressionNarrowings: Map<string, AnalysisType> } | null {
    const assertion = calleeType.assertion;
    if (!assertion) {
      return null;
    }
    const targetExpression = this.assertionTargetExpression(call, calleeType, assertion.target);
    if (!targetExpression) {
      return null;
    }
    const originalType = this.expressionTypeForNarrowing(targetExpression, scope);
    const narrowedType = assertion.type
      ?? this.truthinessNarrowedType(originalType, true);
    if (!narrowedType || isSameType(narrowedType, originalType)) {
      return null;
    }

    const narrowings = new Map<string, AnalysisType>();
    const expressionNarrowings = new Map<string, AnalysisType>();
    if (targetExpression.kind === "Identifier") {
      narrowings.set((targetExpression as Identifier).name, narrowedType);
    }
    const stableKey = this.stableExpressionKey(targetExpression);
    if (stableKey) {
      expressionNarrowings.set(stableKey, narrowedType);
    }
    return narrowings.size > 0 || expressionNarrowings.size > 0
      ? { narrowings, expressionNarrowings }
      : null;
  }

  private assertionTargetExpression(
    call: CallExpression,
    calleeType: AnalysisType & { kind: "function" },
    targetName: string
  ): Expr | null {
    if (targetName === "this") {
      return call.callee.kind === "MemberExpression"
        ? (call.callee as MemberExpression).object
        : null;
    }

    const parameterIndex = calleeType.parameters.findIndex((parameter) => parameter.name === targetName);
    if (parameterIndex < 0) {
      return null;
    }
    const parameter = calleeType.parameters[parameterIndex]!;
    const argument = call.arguments.find((candidate, index) =>
      candidate.kind === "NamedArgument"
        ? ((candidate as NamedArgument).name.name === targetName)
        : index === parameterIndex && !call.arguments.some((other) => other.kind === "NamedArgument")
    );
    if (!argument) {
      return null;
    }
    return argument.kind === "NamedArgument"
      ? (argument as NamedArgument).value
      : parameter.rest === true && argument.kind === "SpreadExpression"
        ? (argument as SpreadExpression).argument
        : argument;
  }

  private visitSwitchStatement(statement: SwitchStatement, scope: Scope, flow: FlowContext): void {
    this.visitExpression(statement.discriminant, scope);
    let sawDefaultCase = false;
    for (let index = 0; index < statement.cases.length; index++) {
      const switchCase = statement.cases[index]!;
      if (!switchCase.test) {
        if (sawDefaultCase) {
          this.issues.push({
            message: "Switch statement cannot contain multiple default clauses",
            node: switchCase,
            code: ANALYSIS_ISSUE_CODES.DUPLICATE_SWITCH_DEFAULT
          });
        }
        sawDefaultCase = true;
      }
      if (
        index < statement.cases.length - 1 &&
        switchCase.consequent.length > 0 &&
        !statementListPreventsSwitchFallthrough(switchCase.consequent)
      ) {
        this.issues.push({
          message: "Switch case falls through to the next case; add 'break', 'return', 'throw', or 'continue' to make control flow explicit",
          node: switchCase,
          code: ANALYSIS_ISSUE_CODES.SWITCH_CASE_FALLTHROUGH
        });
      }
    }
    const switchScope = this.scopeFor(statement, scope);
    const switchFlow: FlowContext = {
      ...flow,
      loopDepth: flow.loopDepth,
      switchDepth: flow.switchDepth + 1
    };

    for (const switchCase of statement.cases) {
      const caseScope = this.scopeFor(switchCase, switchScope);
      if (switchCase.test) {
        this.visitExpression(switchCase.test, caseScope);
      }
      for (const consequent of switchCase.consequent) {
        this.visitStatement(consequent, caseScope, switchFlow);
      }
    }
  }

  private visitTryStatement(statement: TryStatement, scope: Scope, flow: FlowContext): void {
    const tryScope = this.scopeFor(statement.tryBlock, scope);
    for (const child of statement.tryBlock.body) {
      this.visitStatement(child, tryScope, flow);
    }

    if (statement.catchClause) {
      const catchScope = this.scopeFor(statement.catchClause, scope);
      for (const child of statement.catchClause.body.body) {
        this.visitStatement(child, catchScope, flow);
      }
    }

    if (statement.finallyBlock) {
      const finallyScope = this.scopeFor(statement.finallyBlock, scope);
      for (const child of statement.finallyBlock.body) {
        this.visitStatement(child, finallyScope, flow);
      }
    }
  }

  private visitExpression(
    expression: Expr,
    scope: Scope,
    expectedType?: AnalysisType,
    suppressAutoAwait: boolean = false
  ): AnalysisType {
    let result: AnalysisType = UNKNOWN_TYPE;
    switch (expression.kind) {
      case "CommaExpression": {
        const comma = expression as CommaExpression;
        result = UNKNOWN_TYPE;
        for (let index = 0; index < comma.expressions.length; index += 1) {
          const childExpectedType = index === comma.expressions.length - 1 ? expectedType : undefined;
          result = this.visitExpression(comma.expressions[index]!, scope, childExpectedType);
        }
        break;
      }
      case "BinaryExpression": {
        const binary = expression as BinaryExpression;
        const leftType = this.visitExpression(binary.left, scope);
        const rightType = this.visitExpression(binary.right, scope);
        const overload = this.resolveOperatorOverload(binary.operator, leftType, rightType, scope);
        if (overload) {
          this.operatorResolutions.push({
            expression: binary,
            symbol: overload.symbol
          });
          result = overload.type;
        } else {
          result = this.inferBinaryType(binary.operator, leftType, rightType);
          if (this.shouldReportUndefinedOperator(binary.operator, leftType, rightType, result)) {
            this.issues.push({
              message: `Operator '${binary.operator}' is not defined for types '${typeToDiagnosticLabel(leftType)}' and '${typeToDiagnosticLabel(rightType)}'`,
              node: this.operatorDiagnosticNode(binary),
              code: ANALYSIS_ISSUE_CODES.OPERATOR_NOT_DEFINED
            });
          } else if (this.shouldReportUndefinedComparison(binary.operator, leftType, rightType, scope)) {
            this.reportMissingOperatorOverload(
              binary.operator,
              this.operatorDiagnosticNode(binary),
              leftType,
              [rightType]
            );
          }
        }
        break;
      }
      case "RangeExpression": {
        const range = expression as RangeExpression;
        this.visitExpression(range.start, scope);
        this.visitExpression(range.end, scope);
        result = rangeType(builtinType("int"));
        break;
      }
      case "ChainExpression": {
        const chain = expression as ChainExpression;
        result = this.visitExpression(chain.receiver, scope, expectedType);
        for (const operation of chain.operations) {
          this.visitExpression(operation, scope);
        }
        break;
      }
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
        if (!this.isAssignmentTargetExpression(assignment.left)) {
          this.issues.push({
            message: "Invalid assignment target: left side must be an identifier or member access",
            node: assignment.left
          });
        }
        this.validateReadonlyAssignmentTarget(assignment.left, scope);
        if (assignment.operator === "=" && assignment.left.kind === "MemberExpression") {
          this.pureWriteTargetNodes.add(assignment.left);
        }
        const leftType = this.visitExpression(assignment.left, scope);
        const rightType = this.visitExpression(assignment.right, scope, leftType);
        const indexSetterOverload = assignment.operator === "="
          ? this.resolveIndexSetterOperatorOverload(assignment.left, rightType, scope)
          : null;
        const hasIndexSetterCandidates = assignment.operator === "=" &&
          this.hasIndexOperatorCandidates(assignment.left, "[]=");
        if (!indexSetterOverload && hasIndexSetterCandidates && assignment.left.kind === "MemberExpression") {
          const member = assignment.left as MemberExpression;
          const rawObjectType = this.expressionTypes.get(member.object as unknown as Node) ?? UNKNOWN_TYPE;
          const objectType = member.nonNullAsserted === true ? removeNullishFromType(rawObjectType) : rawObjectType;
          const indexTypes = this.computedMemberIndexArgumentTypes(member);
          this.reportMissingOperatorOverload("[]=", assignment.left, objectType, [rightType, ...indexTypes]);
        }
        if (
          !indexSetterOverload &&
          !hasIndexSetterCandidates &&
          !isUnknownType(leftType) &&
          !isUnknownType(rightType) &&
          !this.isTypeAssignable(rightType, leftType)
        ) {
          const definedLeftType = propertyTypeWithoutUndefined(leftType);
          if (!definedLeftType || !this.isTypeAssignable(rightType, definedLeftType)) {
            this.reportTypeMismatch(rightType, leftType, assignment.right, assignment.right);
          }
        }
        if (assignment.left.kind === "Identifier" && isUnknownType(leftType) && !isUnknownType(rightType)) {
          const identifier = assignment.left as Node & { kind: "Identifier"; name: string };
          this.updateResolvedSymbolType(scope, identifier, rightType);
        }
        result = this.hasOptionalAssignmentTarget(assignment.left)
          ? unionType([rightType, builtinType("undefined")])
          : rightType;
        break;
      }
      case "AsExpression": {
        const assertion = expression as AsExpression;
        const expressionType = this.visitExpression(assertion.expression, scope);
        if (assertion.typeAnnotation.name === "const") {
          result = expressionType;
          break;
        }
        const assertedType = this.resolveTypeAnnotation(assertion.typeAnnotation, scope) ?? UNKNOWN_TYPE;
        if (
          !isUnknownType(expressionType) &&
          !isUnknownType(assertedType) &&
          !this.isTypeAssignable(expressionType, assertedType) &&
          !this.isTypeAssignable(assertedType, expressionType)
        ) {
          this.issues.push({
            message: `Type assertion from '${typeToDiagnosticLabel(expressionType)}' to '${typeToDiagnosticLabel(assertedType)}' may be unsafe because neither type is assignable to the other`,
            node: assertion.typeAnnotation
          });
        }
        result = assertedType;
        break;
      }
      case "SatisfiesExpression": {
        const satisfies = expression as SatisfiesExpression;
        const expressionType = this.visitExpression(satisfies.expression, scope);
        const targetType = this.resolveTypeAnnotation(satisfies.typeAnnotation, scope) ?? UNKNOWN_TYPE;
        if (
          !isUnknownType(expressionType) &&
          !isUnknownType(targetType) &&
          !this.isTypeAssignable(expressionType, targetType)
        ) {
          this.issues.push({
            message: `Type '${typeToDiagnosticLabel(expressionType)}' does not satisfy target type '${typeToDiagnosticLabel(targetType)}'`,
            node: satisfies.typeAnnotation
          });
          this.reportNestedMismatchContext(expressionType, targetType, satisfies.expression);
        }
        result = expressionType;
        break;
      }
      case "NonNullExpression": {
        const nonNull = expression as NonNullExpression;
        result = removeNullishFromType(this.visitExpression(nonNull.expression, scope));
        break;
      }
      case "NamedArgument": {
        // A named call argument (`name: value`) carries the type of its value;
        // matching it to the target parameter happens during call validation.
        result = this.visitExpression((expression as NamedArgument).value, scope, expectedType);
        break;
      }
      case "ConditionalExpression": {
        const conditional = expression as ConditionalExpression;
        this.visitExpression(conditional.test, scope);
        const consequentType = this.visitExpression(conditional.consequent, scope, expectedType);
        const alternateType = this.visitExpression(conditional.alternate, scope, expectedType);
        if (this.isTypeAssignable(consequentType, alternateType)) {
          result = alternateType;
          break;
        }
        if (this.isTypeAssignable(alternateType, consequentType)) {
          result = consequentType;
          break;
        }
        result = UNKNOWN_TYPE;
        break;
      }
      case "MemberExpression": {
        const member = expression as MemberExpression;
        // Accessing `.then`/`.catch`/`.finally` means the Promise is being consumed explicitly, so
        // the receiver keeps its Promise type instead of being auto-awaited.
        const suppressObjectAutoAwait =
          !member.computed &&
          member.property.kind === "Identifier" &&
          this.isPromiseMethodName((member.property as Identifier).name);
        const rawObjectType = this.visitExpression(member.object, scope, undefined, suppressObjectAutoAwait);
        this.validateNullableMemberAccess(member, rawObjectType);
        const objectType = member.nonNullAsserted === true ? removeNullishFromType(rawObjectType) : rawObjectType;
        if (member.computed) {
          if (
            objectType.kind === "named" &&
            member.property.kind === "StringLiteral" &&
            this.enumStatementsByName.get(objectType.name)?.members.some(
              (enumMember) => enumMember.name.name === (member.property as StringLiteral).value
            )
          ) {
            result = namedType(objectType.name);
            break;
          }
          const propertyType = this.visitExpression(member.property, scope);
          const indexArgumentTypes = this.computedMemberIndexArgumentTypes(member, propertyType);
          if (objectType.kind === "named") {
            const enumStatement = this.enumStatementsByName.get(objectType.name);
            if (enumStatement) {
              result = this.resolveOptionalAccessType(
                this.resolveEnumComputedAccessType(enumStatement, member.property, propertyType),
                member.optional === true
              );
              break;
            }
          }
          const indexGetterOverload = this.resolveOperatorOverloadForArguments("[]", objectType, indexArgumentTypes, scope);
          if (indexGetterOverload) {
            result = this.resolveOptionalAccessType(indexGetterOverload.type, member.optional === true);
            result = this.narrowedExpressionType(scope, member) ?? result;
            break;
          }
          if (!this.pureWriteTargetNodes.has(member) && this.hasOperatorOverloadCandidates("[]", objectType)) {
            this.reportMissingOperatorOverload("[]", member, objectType, indexArgumentTypes);
          }
          result = this.resolveOptionalAccessType(this.resolveComputedMemberType(objectType, propertyType), member.optional === true);
          result = this.narrowedExpressionType(scope, member) ?? result;
          break;
        }
        this.validateKnownMemberAccess(member, objectType, scope);
        const memberSymbol = this.resolveKnownMemberSymbol(member, objectType);
        if (memberSymbol && member.property.kind === "Identifier") {
          this.identifierResolutions.push({
            identifier: member.property as Node & { kind: "Identifier"; name: string },
            symbol: memberSymbol
          });
        }
        result = this.resolveOptionalAccessType(this.resolveKnownMemberType(member, objectType) ?? UNKNOWN_TYPE, member.optional === true);
        result = this.narrowedExpressionType(scope, member) ?? result;
        break;
      }
      case "PropertyReferenceExpression": {
        const propertyReference = expression as PropertyReferenceExpression;
        const member = memberExpressionFromPropertyReference(propertyReference);
        const rawObjectType = this.visitExpression(propertyReference.object, scope);
        this.validateNullableMemberAccess(member, rawObjectType);
        this.validateKnownMemberAccess(member, rawObjectType, scope);
        const memberSymbol = this.resolveKnownMemberSymbol(member, rawObjectType);
        if (memberSymbol) {
          this.identifierResolutions.push({
            identifier: propertyReference.property,
            symbol: memberSymbol
          });
        }
        result = namedType("Property", [this.resolveKnownMemberType(member, rawObjectType) ?? UNKNOWN_TYPE]);
        break;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        const calleeType = this.visitExpression(call.callee, scope);
        const argumentTypes: AnalysisType[] = [];
        const initialArgumentIssueRanges: Array<{ start: number; end: number } | null> = [];
        for (const argument of call.arguments) {
          const issueStart = this.issues.length;
          argumentTypes.push(this.visitExpression(argument, scope));
          const issueEnd = this.issues.length;
          initialArgumentIssueRanges.push(issueEnd > issueStart ? { start: issueStart, end: issueEnd } : null);
        }
        const overloadArgumentTypes = this.preserveCallLiteralArgumentTypes(call.arguments, argumentTypes);
        const calledClass =
          call.optional !== true && call.callee.kind === "Identifier"
            ? this.classStatementsByName.get((call.callee as Identifier).name)
            : undefined;
        if (calledClass) {
          const explicitTypeArguments = (call.typeArguments ?? []).map((typeArgument) =>
            this.resolveTypeAnnotation(typeArgument, scope) ?? UNKNOWN_TYPE
          );
          this.validateNamedTypeArgumentConstraints(
            calledClass.name.name,
            explicitTypeArguments,
            call.callee,
            scope
          );
          result = this.inferConstructedType(
            call,
            calledClass,
            explicitTypeArguments,
            scope
          );
          break;
        }
        const callableType = this.callableTypeFrom(calleeType, argumentTypes);
        const literalCallableType = overloadArgumentTypes === argumentTypes
          ? callableType
          : this.callableTypeFrom(calleeType, overloadArgumentTypes);
        const callableTypeMatched = callableType ? this.isCallableOverloadMatch(callableType, argumentTypes) : false;
        const literalCallableTypeMatched = literalCallableType
          ? this.isCallableOverloadMatch(literalCallableType, overloadArgumentTypes)
          : false;
        const selectedCallableType = literalCallableTypeMatched && literalCallableType && literalCallableType !== callableType
          ? literalCallableType
          : (!callableTypeMatched && literalCallableTypeMatched
          ? literalCallableType
          : (callableType ?? literalCallableType));
        if (selectedCallableType) {
          const explicitTypeArguments = (call.typeArguments ?? []).map((typeArgument) =>
            this.resolveTypeAnnotation(typeArgument, scope) ?? UNKNOWN_TYPE
          );
          this.validateExplicitTypeArgumentArity(
            selectedCallableType.typeParameters?.length ?? 0,
            explicitTypeArguments.length,
            call.callee
          );
          const hasNamedArguments = call.arguments.some((argument) => argument.kind === "NamedArgument");
          // Named arguments are written in any order; reorder their types into
          // the callee's positional parameter order so generic inference and
          // argument validation operate as if the call were positional.
          const preferredInferenceArguments =
            literalCallableTypeMatched && literalCallableType && literalCallableType !== callableType
              ? overloadArgumentTypes
              : (!callableTypeMatched && literalCallableTypeMatched
              ? overloadArgumentTypes
              : argumentTypes);
          const callableCandidates = this.callableCandidatesFrom(calleeType);
          const bestCallableType = this.selectBestCallableCandidate(
            callableCandidates.length > 0 ? callableCandidates : [selectedCallableType],
            call,
            scope,
            explicitTypeArguments,
            argumentTypes,
            preferredInferenceArguments,
            expectedType
          ) ?? selectedCallableType;
          const overloadIndex = Math.max(0, callableCandidates.findIndex((candidate) => candidate === bestCallableType));
          this.selectedCallResolutions.push({
            call,
            callee: call.callee,
            overload: bestCallableType,
            overloadIndex
          });
          const inferenceArgumentTypes = hasNamedArguments
            ? this.reorderNamedArgumentTypes(call.arguments, preferredInferenceArguments, bestCallableType)
            : this.literalSensitiveInferenceArgumentTypes(
                bestCallableType,
                call.arguments,
                preferredInferenceArguments
              );
          const firstPassCalleeType = this.instantiateFunctionType(
            bestCallableType,
            explicitTypeArguments,
            inferenceArgumentTypes,
            expectedType,
            false
          );
          const contextualArgumentTypes = hasNamedArguments
            ? inferenceArgumentTypes
            : this.applyCallArgumentContext(
                call,
                scope,
                firstPassCalleeType,
                argumentTypes
              );
          if (!hasNamedArguments) {
            const contextualizedIndices: number[] = [];
            for (let index = 0; index < call.arguments.length && index < firstPassCalleeType.parameters.length; index += 1) {
              const contextualExpectedType = this.contextualExpectedTypeForCallArgument(
                call.arguments[index]!,
                firstPassCalleeType.parameters[index]?.type,
                firstPassCalleeType.typeParameters ?? []
              );
              if (contextualExpectedType) {
                contextualizedIndices.push(index);
              }
            }
            for (const index of [...contextualizedIndices].reverse()) {
              const range = initialArgumentIssueRanges[index];
              if (!range) {
                continue;
              }
              this.issues.splice(range.start, range.end - range.start);
            }
          }
          const instantiatedCalleeType = contextualArgumentTypes === argumentTypes
            ? firstPassCalleeType
            : this.instantiateFunctionType(bestCallableType, explicitTypeArguments, contextualArgumentTypes, expectedType);
          const constraintDiagnosticNode = call.callee.kind === "MemberExpression"
            ? (call.callee as MemberExpression).property
            : call.callee;
          this.validateFunctionTypeArgumentConstraints(bestCallableType, instantiatedCalleeType, constraintDiagnosticNode);
          if (hasNamedArguments) {
            this.validateNamedCallArguments(call, instantiatedCalleeType, argumentTypes);
          } else {
            this.validateCallArguments(call, instantiatedCalleeType, contextualArgumentTypes);
          }
          this.evolveArrayElementTypeFromMutation(call, scope, contextualArgumentTypes);
          const assertionEffect = this.assertionEffectForCall(call, instantiatedCalleeType, scope);
          if (assertionEffect) {
            this.assertionCallEffects.set(call, assertionEffect);
          }
          let resolvedReturnType = instantiatedCalleeType.returnType;
          if (call.callee.kind === "MemberExpression") {
            const memberExpression = call.callee as MemberExpression;
            const property = memberExpression.property as Expr;
            if (property.kind === "Identifier" && (property as Identifier).name === "parse") {
              const receiverType = this.visitExpression(memberExpression.object, scope);
              const syntheticOutputType = this.syntheticSchemaOutputType(receiverType);
              if (syntheticOutputType) {
                resolvedReturnType = syntheticOutputType;
              }
            }
          }
          result = this.resolveOptionalAccessType(
            resolvedReturnType,
            call.optional === true || hasNullishUnionMember(calleeType)
          );
          break;
        }
        if (calleeType.kind === "builtin" && calleeType.name === "any") {
          result = calleeType;
          break;
        }
        const constructableOnlyType = this.interfaceConstructorTypeForNewExpression(call, calleeType, scope);
        if (constructableOnlyType) {
          const explicitTypeArguments = (call.typeArguments ?? []).map((typeArgument) =>
            this.resolveTypeAnnotation(typeArgument, scope) ?? UNKNOWN_TYPE
          );
          this.validateExplicitTypeArgumentArity(
            constructableOnlyType.typeParameters?.length ?? 0,
            explicitTypeArguments.length,
            call.callee
          );
          const isPromiseConstructor =
            call.callee.kind === "Identifier" &&
            (call.callee as Identifier).name === "Promise";
          if (!isPromiseConstructor) {
            const inferenceArgumentTypes = (call.arguments ?? []).map((argument) =>
              this.visitExpression(argument, scope)
            );
            const instantiatedConstructorType = this.instantiateFunctionType(
              constructableOnlyType,
              explicitTypeArguments,
              inferenceArgumentTypes,
              expectedType,
              false
            );
            const contextualArgumentTypes = this.applyCallArgumentContext(
              call,
              scope,
              instantiatedConstructorType,
              inferenceArgumentTypes
            );
            this.validateFunctionTypeArgumentConstraints(constructableOnlyType, instantiatedConstructorType, call);
            this.validateCallArguments(call, instantiatedConstructorType, contextualArgumentTypes);
            result = instantiatedConstructorType.returnType;
            break;
          }
          const typeParameterNames = constructableOnlyType.typeParameters ?? [];
          const substitutions = new Map<string, AnalysisType>();
          const explicitTypeParameterNames = new Set<string>();
          for (let index = 0; index < typeParameterNames.length; index += 1) {
            const typeParameterName = typeParameterNames[index]!;
            const explicitTypeArgument = explicitTypeArguments[index];
            if (explicitTypeArgument) {
              substitutions.set(typeParameterName, explicitTypeArgument);
              explicitTypeParameterNames.add(typeParameterName);
            } else {
              substitutions.set(typeParameterName, namedType(typeParameterName));
            }
          }
          this.inferPromiseConstructorTypeArgumentFromExecutor(
            call,
            substitutions,
            explicitTypeParameterNames
          );
          const instantiatedConstructorType = this.substituteTypeParameters(
            constructableOnlyType,
            substitutions
          ) as AnalysisType & { kind: "function" };
          const contextualArgumentTypes = this.visitConstructorArgumentsWithContext(
            call,
            scope,
            instantiatedConstructorType
          );
          this.validateFunctionTypeArgumentConstraints(constructableOnlyType, instantiatedConstructorType, call);
          this.validateCallArguments(call, instantiatedConstructorType, contextualArgumentTypes);
          result = instantiatedConstructorType.returnType;
          break;
        }
        if (!isUnknownType(calleeType) || this.shouldReportUnknownCallable(call.callee, scope)) {
          this.issues.push({
            message: `Type '${typeToDiagnosticLabel(calleeType)}' is not callable`,
            node: call.callee,
            code: ANALYSIS_ISSUE_CODES.TYPE_NOT_CALLABLE
          });
        }
        result = UNKNOWN_TYPE;
        break;
      }
      case "NewExpression": {
        const newExpression = expression as NewExpression;
        const calleeType = this.visitExpression(newExpression.callee, scope);
        const explicitTypeArguments = (newExpression.typeArguments ?? []).map((typeArgument) =>
          this.resolveTypeAnnotation(typeArgument, scope) ?? UNKNOWN_TYPE
        );

        const classStatement = this.classStatementForNewExpression(newExpression, calleeType);
        if (classStatement) {
          this.validateNamedTypeArgumentConstraints(
            classStatement.name.name,
            explicitTypeArguments,
            newExpression.callee,
            scope
          );
          const constructedType = this.inferConstructedType(
            newExpression,
            classStatement,
            explicitTypeArguments,
            scope
          );
          result = constructedType;
          break;
        }

        const constructorInterfaceType = this.interfaceConstructorTypeForNewExpression(newExpression, calleeType, scope);
        if (constructorInterfaceType) {
          const typeParameterNames = constructorInterfaceType.typeParameters ?? [];
          const substitutions = new Map<string, AnalysisType>();
          const explicitTypeParameterNames = new Set<string>();
          for (let index = 0; index < typeParameterNames.length; index += 1) {
            const typeParameterName = typeParameterNames[index]!;
            const explicitTypeArgument = explicitTypeArguments[index];
            if (explicitTypeArgument) {
              substitutions.set(typeParameterName, explicitTypeArgument);
              explicitTypeParameterNames.add(typeParameterName);
            } else {
              substitutions.set(typeParameterName, namedType(typeParameterName));
            }
          }
          const isPromiseConstructor =
            newExpression.callee.kind === "Identifier" &&
            (newExpression.callee as Identifier).name === "Promise";
          if (isPromiseConstructor) {
            this.inferPromiseConstructorTypeArgumentFromExecutor(
              newExpression,
              substitutions,
              explicitTypeParameterNames
            );
          }
          let provisionalConstructorType = this.substituteTypeParameters(
            constructorInterfaceType,
            substitutions
          ) as AnalysisType & { kind: "function" };
          let argumentTypes = this.visitConstructorArgumentsWithContext(
            newExpression,
            scope,
            provisionalConstructorType
          );
          if (!isPromiseConstructor) {
            const typeParameterSet = new Set(typeParameterNames);
            for (let index = 0; index < provisionalConstructorType.parameters.length && index < argumentTypes.length; index += 1) {
              this.inferTypeParameterSubstitutions(
                provisionalConstructorType.parameters[index]!.type,
                argumentTypes[index]!,
                typeParameterSet,
                explicitTypeParameterNames,
                substitutions
              );
            }
          }
          const finalConstructorType = this.substituteTypeParameters(
            constructorInterfaceType,
            substitutions
          ) as AnalysisType & { kind: "function" };
          argumentTypes = this.visitConstructorArgumentsWithContext(
            newExpression,
            scope,
            finalConstructorType
          );
          this.validateCallArguments(newExpression, finalConstructorType, argumentTypes);
          result = finalConstructorType.returnType;
          break;
        }

        for (const argument of newExpression.arguments ?? []) {
          this.visitExpression(argument, scope);
        }
        if (calleeType.kind === "builtin" && calleeType.name === "any") {
          result = calleeType;
          break;
        }
        if (!isUnknownType(calleeType)) {
          if (calleeType.kind === "function") {
            result = calleeType.returnType;
            break;
          }
          this.issues.push({
            message: `Type '${typeToDiagnosticLabel(calleeType)}' is not constructable`,
            node: newExpression.callee,
            code: ANALYSIS_ISSUE_CODES.TYPE_NOT_CONSTRUCTABLE
          });
          result = calleeType;
          break;
        }

        if (newExpression.callee.kind === "Identifier") {
          const calleeIdentifier = newExpression.callee as Node & { kind: "Identifier"; name: string };
          this.validateNamedTypeArgumentConstraints(
            calleeIdentifier.name,
            explicitTypeArguments,
            calleeIdentifier,
            scope
          );
          result = namedType(calleeIdentifier.name, explicitTypeArguments);
          break;
        }

        result = calleeType;
        break;
      }
      case "UnaryExpression": {
        const unary = expression as UnaryExpression;
        // `await x` and `go x` consume the Promise directly, so their operand must not be
        // auto-awaited (which would otherwise unwrap it before they see it).
        const suppressArgumentAutoAwait = unary.operator === "await" || unary.operator === "go";
        const argumentType = this.visitExpression(unary.argument, scope, undefined, suppressArgumentAutoAwait);
        if (unary.operator === "!") {
          result = builtinType("boolean");
          break;
        }
        if (unary.operator === "typeof") {
          result = builtinType("string");
          break;
        }
        if (unary.operator === "void") {
          result = builtinType("undefined");
          break;
        }
        if (unary.operator === "delete") {
          result = builtinType("boolean");
          break;
        }
        if (unary.operator === "await") {
          // `await` is allowed at module/global scope and inside async or sync functions,
          // but not inside normal functions or normal (non-async) generators.
          if (this.isInsideFunction() && !this.isInsideAsyncLikeFunction()) {
            this.issues.push({
              message: "The 'await' keyword is only allowed inside async or sync functions or at the top level",
              node: expression,
              code: ANALYSIS_ISSUE_CODES.AWAIT_OUTSIDE_ASYNC
            });
            result = UNKNOWN_TYPE;
            break;
          }
          result = unwrapPromiseType(argumentType) ?? argumentType;
          break;
        }
        if (unary.operator === "go") {
          // `go expr` opts out of sync auto-await and yields the underlying Promise unchanged.
          // It is only meaningful inside sync functions: not in normal or async functions, and
          // not at the top level.
          if (!this.isInsideSyncFunction()) {
            this.issues.push({
              message: "The 'go' operator is only allowed inside sync functions",
              node: expression,
              code: ANALYSIS_ISSUE_CODES.GO_OUTSIDE_SYNC
            });
            result = UNKNOWN_TYPE;
            break;
          }
          result = argumentType;
          break;
        }
        if (unary.operator === "yield" || unary.operator === "yield*") {
          if (!this.isInsideGeneratorFunction()) {
            this.issues.push({
              message: "The 'yield' keyword is only allowed inside generator functions",
              node: expression,
              code: ANALYSIS_ISSUE_CODES.YIELD_OUTSIDE_GENERATOR
            });
            result = UNKNOWN_TYPE;
            break;
          }
          result = argumentType;
          break;
        }
        if ((unary.operator === "+" || unary.operator === "-") && isIntType(argumentType)) {
          result = builtinType("int");
          break;
        }
        if (unary.operator === "+" || unary.operator === "-") {
          const overload = this.resolveUnaryOperatorOverload(unary.operator, argumentType, scope);
          if (overload) {
            result = overload.type;
            break;
          }
          if (argumentType.kind === "named") {
            this.issues.push({
              message: `Unary operator '${unary.operator}' is not defined for type '${typeToDiagnosticLabel(argumentType)}'`,
              node: unary,
              code: ANALYSIS_ISSUE_CODES.OPERATOR_NOT_DEFINED
            });
          }
        }
        result = UNKNOWN_TYPE;
        break;
      }
      case "SpreadExpression": {
        const spread = expression as SpreadExpression;
        result = this.visitExpression(spread.argument, scope);
        break;
      }
      case "UpdateExpression": {
        const updateExpr = expression as UpdateExpression;
        if (!this.isLValueExpression(updateExpr.argument)) {
          this.issues.push({
            message: `The left-hand side of an increment/decrement operator must be a variable or property access`,
            node: updateExpr.argument
          });
        }
        this.validateReadonlyAssignmentTarget(updateExpr.argument, scope);
        const updateOperandType = this.visitExpression(updateExpr.argument, scope);
        if (!isUnknownType(updateOperandType) && !isNumericFamilyType(updateOperandType)) {
          this.issues.push({
            message: `Operator '${updateExpr.operator}' cannot be applied to type '${typeToString(updateOperandType)}'`,
            node: updateExpr.argument,
            code: ANALYSIS_ISSUE_CODES.OPERATOR_NOT_APPLICABLE
          });
        }
        result = builtinType("int");
        break;
      }
      case "ArrayLiteral":
        result = this.inferArrayLiteralType(expression as ArrayLiteral, scope, expectedType);
        break;
      case "ArrayHole":
        result = builtinType("undefined");
        break;
      case "ObjectLiteral":
        result = this.inferObjectLiteralType(expression as ObjectLiteral, scope, expectedType);
        break;
      case "ArrowFunctionExpression": {
        const arrow = expression as ArrowFunctionExpression;
        const arrowIsAsyncLike = isAsyncLike(arrow);
        this.withGeneratorFunction(false, () => this.withSyncFunction(arrow.sync === true, () => this.withAsyncLikeFunction(arrowIsAsyncLike, () => {
          const expectedFunctionType = this.contextualFunctionTypeForExpression(
            this.contextualFunctionExpectedType(expectedType),
            scope
          );
          if (arrow.contextualObjectLiteral && expectedType && !expectedFunctionType) {
            result = this.inferObjectLiteralType(arrow.contextualObjectLiteral, scope, expectedType);
            return;
          }
          const arrowScope = this.createFunctionLikeExpressionScope(scope, arrow, arrow.parameters, expectedFunctionType);
          let returnType: AnalysisType;
          if (arrow.body.kind === "BlockStatement") {
            const expectedReturnType = expectedFunctionType?.returnType ?? UNKNOWN_TYPE;
            const arrowFlow: FlowContext = {
              loopDepth: 0,
              switchDepth: 0,
              labels: [],
              expectedReturnType,
              inAsync: arrowIsAsyncLike,
              inGenerator: false
            };
            for (const bodyStatement of (arrow.body as BlockStatement).body) {
              this.visitStatement(bodyStatement, arrowScope, arrowFlow);
            }
            const preservesInferredReturnType = arrowIsAsyncLike || this.preservesInferredContextualReturnType(
              expectedFunctionType?.returnType,
              arrowScope
            );
            returnType = this.finalizeFunctionReturnType(
              preservesInferredReturnType ? undefined : expectedFunctionType?.returnType,
              arrow.body as BlockStatement,
              arrowIsAsyncLike
            );
            this.reportMissingReturnPath(arrow.body as BlockStatement, returnType, arrow, arrowIsAsyncLike);
          } else {
            returnType = this.visitExpression(arrow.body as Expr, arrowScope, expectedFunctionType?.returnType);
            if (arrowIsAsyncLike && (!expectedFunctionType || isUnknownType(expectedFunctionType.returnType))) {
              returnType = namedType("Promise", [returnType]);
            }
            if (
              expectedFunctionType &&
              !isUnknownType(expectedFunctionType.returnType) &&
              this.returnValueIsOptional(expectedFunctionType.returnType)
            ) {
              returnType = expectedFunctionType.returnType;
            } else if (
              expectedFunctionType &&
              !isUnknownType(returnType) &&
              !isUnknownType(expectedFunctionType.returnType) &&
              !(arrowIsAsyncLike || this.preservesInferredContextualReturnType(expectedFunctionType.returnType, arrowScope)) &&
              !this.isTypeAssignable(returnType, expectedFunctionType.returnType)
            ) {
              this.reportReturnTypeMismatch(returnType, expectedFunctionType.returnType, arrow.body as Expr);
              returnType = expectedFunctionType.returnType;
            }
          }
          result = this.buildFunctionType(arrow.parameters, returnType, arrowScope, [], arrow.returnType?.name);
        })));
        break;
      }
      case "FunctionExpression": {
        const fn = expression as FunctionExpression;
        const fnIsAsyncLike = isAsyncLike(fn);
        this.withGeneratorFunction(fn.generator === true, () => this.withSyncFunction(fn.sync === true, () => this.withAsyncLikeFunction(fnIsAsyncLike, () => {
          const expectedFunctionType = this.contextualFunctionTypeForExpression(
            this.contextualFunctionExpectedType(expectedType),
            scope
          );
          const functionScope = this.createFunctionLikeExpressionScope(scope, fn, fn.parameters, expectedFunctionType);
          const declaredReturnType = this.resolveTypeAnnotation(fn.returnType, functionScope);
          if (fnIsAsyncLike) {
            this.validateAsyncReturnTypeAnnotation(declaredReturnType, fn.returnType ?? fn.name ?? fn);
          }
          const expectedReturnType =
            declaredReturnType ?? expectedFunctionType?.returnType ?? UNKNOWN_TYPE;
          const functionFlow: FlowContext = {
            loopDepth: 0,
            switchDepth: 0,
            labels: [],
            expectedReturnType,
            inAsync: fnIsAsyncLike,
            inGenerator: fn.generator === true
          };
          for (const bodyStatement of fn.body.body) {
            this.visitStatement(bodyStatement, functionScope, functionFlow);
          }
          const preservesInferredReturnType = declaredReturnType === undefined && (
            fnIsAsyncLike || this.preservesInferredContextualReturnType(
            expectedFunctionType?.returnType,
            functionScope
          ));
          const returnType = this.finalizeFunctionReturnType(
            declaredReturnType ?? (preservesInferredReturnType ? undefined : expectedFunctionType?.returnType),
            fn.body,
            fnIsAsyncLike,
            fn.generator === true
          );
          this.reportMissingReturnPath(fn.body, returnType, fn.name ?? fn, fnIsAsyncLike, fn.generator === true);
          result = this.buildFunctionType(fn.parameters, returnType, functionScope, [], fn.returnType?.name);
        })));
        break;
      }
      case "Identifier":
        result = this.resolveIdentifierType(expression as Node & { kind: "Identifier"; name: string }, scope);
        break;
      case "MissingExpression":
        this.issues.push({
          message: "Expected an expression",
          node: expression as MissingExpression
        });
        result = UNKNOWN_TYPE;
        break;
      case "IntLiteral":
        result = this.contextualLiteralType(
          literalType("number", (expression as IntLiteral).value),
          expectedType
        ) ?? builtinType("int");
        break;
      case "FloatLiteral":
        result = this.contextualLiteralType(
          literalType("number", (expression as FloatLiteral).value),
          expectedType
        ) ?? builtinType("number");
        break;
      case "BigIntLiteral":
        result = builtinType("bigint");
        break;
      case "LongLiteral":
        result = builtinType("long");
        break;
      case "StringLiteral":
        result = this.contextualLiteralType(
          literalType("string", (expression as StringLiteral).value),
          expectedType
        ) ?? builtinType("string");
        break;
      case "RegExpLiteral":
        result = namedType("RegExp");
        break;
      case "BooleanLiteral":
        result = this.contextualLiteralType(
          literalType("boolean", (expression as BooleanLiteral).value),
          expectedType
        ) ?? builtinType("boolean");
        break;
      case "NullLiteral":
        result = builtinType("null");
        break;
      case "UndefinedLiteral":
        result = builtinType("undefined");
        break;
      case "JsxExpressionContainer":
        result = this.visitExpression((expression as JsxExpressionContainer).expression, scope);
        break;
      case "JsxElement": {
        const jsxElement = expression as JsxElement;
        const componentType = jsxElement.reference ? this.visitExpression(jsxElement.reference, scope) : undefined;
        const callableComponentType = componentType ? this.callableTypeFrom(componentType) : null;
        this.validateJsxComponentAttributes(jsxElement, callableComponentType, scope);
        for (const child of jsxElement.children) {
          if (child.kind === "JsxExpressionContainer") {
            this.visitExpression((child as JsxExpressionContainer).expression, scope);
          } else if (child.kind === "JsxElement" || child.kind === "JsxFragment") {
            this.visitExpression(child, scope);
          }
        }
        result = this.resolveJsxResultType(scope) ?? namedType("JSX.Element");
        break;
      }
      case "JsxFragment": {
        for (const child of (expression as JsxFragment).children) {
          if (child.kind === "JsxExpressionContainer") {
            this.visitExpression((child as JsxExpressionContainer).expression, scope);
          } else if (child.kind === "JsxElement" || child.kind === "JsxFragment") {
            this.visitExpression(child, scope);
          }
        }
        result = this.resolveJsxResultType(scope) ?? namedType("JSX.Element");
        break;
      }
      default:
        result = UNKNOWN_TYPE;
        break;
    }

    // Pervasive auto-await: inside a `sync` function body (Kotlin-suspend-like), any expression
    // that evaluates to a Promise is implicitly awaited wherever it is used as a value (call
    // arguments, operands, initializers, ...). `async` functions behave like TypeScript and require
    // explicit `await`. Callers (and tooling such as hover/inlay hints) observe the unwrapped value
    // type, while the set of auto-awaited nodes tells the emitter where to insert `await`. `go expr`
    // opts out (it is never added here), and positions such as `await`/`go` operands, `.then`-style
    // member receivers and `return` expressions pass `suppressAutoAwait`.
    if (
      !suppressAutoAwait &&
      this.isInsideSyncFunction() &&
      !this.isGoExpression(expression) &&
      !this.isLocalValueReference(expression, scope) &&
      result.kind === "named" &&
      result.name === "Promise"
    ) {
      this.autoAwaitExpressions.add(expression);
      result = unwrapPromiseType(result) ?? result;
    }

    this.expressionTypes.set(expression, result);
    return result;
  }

  private isGoExpression(expression: Expr): boolean {
    return expression.kind === "UnaryExpression" && (expression as UnaryExpression).operator === "go";
  }

  private resolveJsxResultType(scope: Scope): AnalysisType | null {
    const jsxFactory = this.resolve("h", scope, undefined);
    if (!jsxFactory?.type || jsxFactory.type.kind !== "function") {
      return null;
    }
    return jsxFactory.type.returnType;
  }

  // A bare reference to a local variable or parameter is never auto-awaited: once a Promise has
  // been stored in a variable, it keeps its `Promise<T>` type until it is awaited explicitly (or
  // consumed inline). Auto-await only applies to expressions that *produce* a Promise (calls, ...).
  private isLocalValueReference(expression: Expr, scope: Scope): boolean {
    if (expression.kind !== "Identifier") {
      return false;
    }
    const identifier = expression as Node & { kind: "Identifier"; name: string };
    const symbol = this.resolve(identifier.name, scope, identifier.firstToken?.range.start.offset);
    return symbol?.kind === "variable" || symbol?.kind === "parameter";
  }

  private isPromiseMethodName(name: string): boolean {
    return name === "then" || name === "catch" || name === "finally";
  }

  private resolveOperatorOverload(
    operator: BinaryExpression["operator"],
    leftType: AnalysisType,
    rightType: AnalysisType,
    scope: Scope
  ): { type: AnalysisType; symbol: AnalysisSymbol } | null {
    return this.resolveOperatorOverloadForArguments(operator, leftType, [rightType], scope);
  }

  private resolveOperatorOverloadForArguments(
    operator: OverloadableOperator,
    leftType: AnalysisType,
    argumentTypes: AnalysisType[],
    scope: Scope
  ): { type: AnalysisType; symbol: AnalysisSymbol } | null {
    if (leftType.kind !== "named") {
      return null;
    }
    const classStatement = this.classStatementsByName.get(leftType.name);
    const classSubstitutions = classStatement
      ? this.typeParameterSubstitutions(classStatement.typeParameters ?? [], leftType)
      : new Map<string, AnalysisType>();
    for (const member of classStatement?.members ?? []) {
      if (member.kind !== "ClassMethodMember") {
        continue;
      }
      const method = member as ClassMethodMember;
      if (method.operator !== operator || !this.operatorParametersMatch(method.parameters, argumentTypes, scope, classSubstitutions)) {
        continue;
      }
      return {
        type: method.returnType
          ? this.resolveOperatorTypeAnnotation(method.returnType, scope, classSubstitutions) ?? UNKNOWN_TYPE
          : namedType(leftType.name),
        symbol: this.createMethodSymbol(method)
      };
    }
    for (const extension of this.extensionOperatorsByReceiver.get(leftType.name) ?? []) {
      if (extension.operator !== operator || !this.operatorParametersMatch(extension.parameters, argumentTypes, scope)) {
        continue;
      }
      return {
        type: extension.returnType
          ? this.resolveTypeAnnotation(extension.returnType, scope) ?? UNKNOWN_TYPE
          : namedType(leftType.name),
        symbol: this.createFunctionSymbol(extension)
      };
    }
    return null;
  }

  private resolveIndexSetterOperatorOverload(
    left: Expr,
    valueType: AnalysisType,
    scope: Scope
  ): { type: AnalysisType; symbol: AnalysisSymbol } | null {
    if (left.kind !== "MemberExpression") {
      return null;
    }
    const member = left as MemberExpression;
    if (!member.computed) {
      return null;
    }
    const rawObjectType = this.expressionTypes.get(member.object as unknown as Node) ?? UNKNOWN_TYPE;
    const objectType = member.nonNullAsserted === true ? removeNullishFromType(rawObjectType) : rawObjectType;
    const indexTypes = this.computedMemberIndexArgumentTypes(member);
    return this.resolveOperatorOverloadForArguments("[]=", objectType, [valueType, ...indexTypes], scope);
  }

  private computedMemberIndexArguments(member: MemberExpression): Expr[] {
    return member.property.kind === "CommaExpression"
      ? (member.property as CommaExpression).expressions
      : [member.property];
  }

  private computedMemberIndexArgumentTypes(
    member: MemberExpression,
    singlePropertyType?: AnalysisType
  ): AnalysisType[] {
    const indexArguments = this.computedMemberIndexArguments(member);
    if (indexArguments.length === 1 && indexArguments[0] === member.property && singlePropertyType) {
      return [singlePropertyType];
    }
    return indexArguments.map((argument) => this.expressionTypes.get(argument as unknown as Node) ?? UNKNOWN_TYPE);
  }

  private hasIndexOperatorCandidates(left: Expr, operator: "[]" | "[]="): boolean {
    if (left.kind !== "MemberExpression") {
      return false;
    }
    const member = left as MemberExpression;
    if (!member.computed) {
      return false;
    }
    const rawObjectType = this.expressionTypes.get(member.object as unknown as Node) ?? UNKNOWN_TYPE;
    const objectType = member.nonNullAsserted === true ? removeNullishFromType(rawObjectType) : rawObjectType;
    return this.hasOperatorOverloadCandidates(operator, objectType);
  }

  private hasOperatorOverloadCandidates(operator: OverloadableOperator, leftType: AnalysisType): boolean {
    if (leftType.kind !== "named") {
      return false;
    }
    const classStatement = this.classStatementsByName.get(leftType.name);
    if (classStatement?.members.some((member) =>
      member.kind === "ClassMethodMember" && (member as ClassMethodMember).operator === operator
    )) {
      return true;
    }
    return (this.extensionOperatorsByReceiver.get(leftType.name) ?? []).some((extension) => extension.operator === operator);
  }

  private reportMissingOperatorOverload(
    operator: OverloadableOperator,
    node: Node,
    leftType: AnalysisType,
    argumentTypes: readonly AnalysisType[]
  ): void {
    if ([leftType, ...argumentTypes].some(isUnknownType)) {
      return;
    }
    const labels = [leftType, ...argumentTypes].map((type) => `'${typeToDiagnosticLabel(type)}'`);
    const joinedLabels = labels.length <= 2
      ? labels.join(" and ")
      : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
    this.issues.push({
      message: `Operator '${operator}' is not defined for types ${joinedLabels}`,
      node,
      code: ANALYSIS_ISSUE_CODES.OPERATOR_NOT_DEFINED
    });
  }

  private resolveUnaryOperatorOverload(
    operator: "+" | "-",
    argumentType: AnalysisType,
    scope: Scope
  ): { type: AnalysisType } | null {
    if (argumentType.kind !== "named") {
      return null;
    }
    const classStatement = this.classStatementsByName.get(argumentType.name);
    for (const member of classStatement?.members ?? []) {
      if (member.kind !== "ClassMethodMember") {
        continue;
      }
      const method = member as ClassMethodMember;
      if (method.operator === operator && method.parameters.length === 0) {
        return {
          type: method.returnType
            ? this.resolveTypeAnnotation(method.returnType, scope) ?? UNKNOWN_TYPE
            : namedType(argumentType.name)
        };
      }
    }
    for (const extension of this.extensionOperatorsByReceiver.get(argumentType.name) ?? []) {
      if (extension.operator === operator && extension.parameters.length === 0) {
        return {
          type: extension.returnType
            ? this.resolveTypeAnnotation(extension.returnType, scope) ?? UNKNOWN_TYPE
            : namedType(argumentType.name)
        };
      }
    }
    return null;
  }

  private shouldReportUndefinedOperator(
    operator: BinaryExpression["operator"],
    leftType: AnalysisType,
    rightType: AnalysisType,
    inferredType: AnalysisType
  ): boolean {
    if (inferredType.kind !== "unknown") {
      return false;
    }
    if (leftType.kind === "unknown" && isPrimitiveLikeOperatorType(rightType)) {
      return false;
    }
    if (rightType.kind === "unknown" && isPrimitiveLikeOperatorType(leftType)) {
      return false;
    }
    return operator === "+" ||
      operator === "-" ||
      operator === "*" ||
      operator === "/" ||
      operator === "%" ||
      operator === "**" ||
      operator === "<<" ||
      operator === ">>" ||
      operator === ">>>" ||
      operator === "&" ||
      operator === "|" ||
      operator === "^";
  }

  private isOrderingComparisonOperator(operator: BinaryExpression["operator"]): boolean {
    return (
      operator === "<" ||
      operator === ">" ||
      operator === "<=" ||
      operator === ">=" ||
      operator === "<=>"
    );
  }

  /**
   * Operands whose comparison capabilities cannot (or should not) be policed:
   * `any`, untyped (`unknown`) expressions, and bare generic type parameters
   * (which may be instantiated with a comparable type). These never trigger an
   * undefined-comparison diagnostic.
   */
  private isUncheckableComparisonOperand(type: AnalysisType): boolean {
    if (isUnknownType(type) || (type.kind === "builtin" && type.name === "any")) {
      return true;
    }
    return type.kind === "named" && this.isActiveTypeParameter(type.name);
  }

  /**
   * Native ordering category of a type. Numbers (the whole numeric family plus
   * int-backed enums) and strings are the only built-ins that support
   * `< > <= >= <=>` without an operator overload; both sides must share the
   * same category. Returns null for anything else.
   */
  private nativeOrderingCategory(type: AnalysisType): "numeric" | "string" | null {
    const expanded = this.expandTypeAliases(type);
    if (isStringLikeType(expanded)) {
      return "string";
    }
    if (isNumericFamilyType(expanded) || this.isIntEnumLikeType(expanded)) {
      return "numeric";
    }
    return null;
  }

  /**
   * Ordering comparisons (`< > <= >= <=>`) are only meaningful when an operator
   * overload applies or the operands are natively comparable. A direct overload
   * has already been resolved (and consumed) by the caller, so this additionally
   * honours `operator<=>` (which derives the four relational operators) and the
   * native-type rule: number-with-number, string-with-string, or an
   * `any`/untyped/generic operand. Comparing two unrelated class instances, or a
   * `string` against a `number`, is reported as an undefined operator.
   */
  private shouldReportUndefinedComparison(
    operator: BinaryExpression["operator"],
    leftType: AnalysisType,
    rightType: AnalysisType,
    scope: Scope
  ): boolean {
    if (!this.isOrderingComparisonOperator(operator)) {
      return false;
    }
    if (this.isUncheckableComparisonOperand(leftType) || this.isUncheckableComparisonOperand(rightType)) {
      return false;
    }
    if (operator !== "<=>" && this.resolveOperatorOverload("<=>", leftType, rightType, scope)) {
      return false;
    }
    const leftCategory = this.nativeOrderingCategory(leftType);
    return leftCategory === null || leftCategory !== this.nativeOrderingCategory(rightType);
  }

  private operatorDiagnosticNode(binary: BinaryExpression): Node {
    const token = binary.operatorToken;
    if (!token) {
      return binary;
    }
    return {
      kind: "BinaryExpression",
      firstToken: token,
      lastToken: token
    } as Node;
  }

  private createMethodSymbol(method: ClassMethodMember): AnalysisSymbol {
    if (method.accessorKind === "get") {
      const propertyType = this.typeFromAnnotationLoose(method.returnType, this.classNameForMember(method)) ?? UNKNOWN_TYPE;
      return {
        name: method.name.name,
        kind: "variable",
        node: method.name,
        declaredOffset: method.name.firstToken?.range.start.offset ?? -1,
        type: propertyType,
        valueType: typeToString(propertyType)
      };
    }
    if (method.accessorKind === "set") {
      const propertyType = this.typeFromAnnotationLoose(method.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
      return {
        name: method.name.name,
        kind: "variable",
        node: method.name,
        declaredOffset: method.name.firstToken?.range.start.offset ?? -1,
        type: propertyType,
        valueType: typeToString(propertyType)
      };
    }

    const symbolType = functionType(
      method.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
        name: bindingNameText(parameter.name),
        type: this.functionParameterTypeLoose(parameter),
        optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
        rest: parameter.rest === true
      })),
      this.typeFromAnnotationLoose(method.returnType, this.classNameForMember(method)) ?? UNKNOWN_TYPE,
      method.typeParameters?.map((parameter) => parameter.name.name)
    );
    return {
      name: method.name.name,
      kind: "method",
      node: method.name,
      declaredOffset: method.name.firstToken?.range.start.offset ?? -1,
      type: symbolType,
      valueType: typeToString(symbolType)
    };
  }

  private createFunctionSymbol(statement: FunctionStatement): AnalysisSymbol {
    const symbolType = functionType(
      statement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
        name: bindingNameText(parameter.name),
        type: this.functionParameterTypeLoose(parameter),
        optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
        rest: parameter.rest === true
      })),
      this.typeFromAnnotationLoose(statement.returnType, statement.receiverType?.name) ?? UNKNOWN_TYPE,
      statement.typeParameters?.map((parameter) => parameter.name.name)
    );
    return {
      name: statement.name.name,
      kind: "function",
      node: statement.name,
      declaredOffset: statement.name.firstToken?.range.start.offset ?? -1,
      type: symbolType,
      valueType: typeToString(symbolType)
    };
  }


  private functionParameterTypeLoose(parameter: FunctionParameter): AnalysisType {
    if (parameter.typeAnnotation) {
      return this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
    }
    return this.bindingPatternAnnotationTypeLoose(parameter.name) ?? UNKNOWN_TYPE;
  }

  private bindingPatternAnnotationTypeLoose(binding: BindingName): AnalysisType | null {
    if (binding.kind === "Identifier") {
      return null;
    }
    if (binding.kind === "ObjectBindingPattern") {
      const properties: Record<string, AnalysisType> = {};
      let hasTypedProperty = false;
      for (const element of binding.elements) {
        if (element.rest === true) {
          continue;
        }
        const propertyName = bindingElementPropertyName(element);
        if (!propertyName) {
          continue;
        }
        const annotatedType = element.typeAnnotation
          ? this.typeFromAnnotationLoose(element.typeAnnotation) ?? UNKNOWN_TYPE
          : this.bindingPatternAnnotationTypeLoose(element.name);
        if (!annotatedType) {
          continue;
        }
        properties[propertyName] = annotatedType;
        hasTypedProperty = true;
      }
      return hasTypedProperty ? objectTypeWithProperties(properties) : null;
    }

    const elements: AnalysisType[] = [];
    let hasTypedElement = false;
    binding.elements.forEach((element, index) => {
      if (element.kind === "BindingHole") {
        elements[index] = UNKNOWN_TYPE;
        return;
      }
      const annotatedType = element.typeAnnotation
        ? this.typeFromAnnotationLoose(element.typeAnnotation) ?? UNKNOWN_TYPE
        : this.bindingPatternAnnotationTypeLoose(element.name);
      elements[index] = annotatedType ?? UNKNOWN_TYPE;
      if (annotatedType) {
        hasTypedElement = true;
      }
    });
    return hasTypedElement ? tupleType(elements) : null;
  }

  private operatorParameterMatches(parameter: FunctionParameter | undefined, rightType: AnalysisType, scope: Scope): boolean {
    const parameterType = this.operatorParameterType(parameter, scope);
    return isUnknownType(parameterType) || isUnknownType(rightType) || this.isTypeAssignable(rightType, parameterType);
  }

  private operatorParameterType(
    parameter: FunctionParameter | undefined,
    scope: Scope,
    substitutions: Map<string, AnalysisType> = new Map()
  ): AnalysisType {
    if (!parameter) {
      return UNKNOWN_TYPE;
    }
    if (!parameter.typeAnnotation) {
      return UNKNOWN_TYPE;
    }
    return this.resolveOperatorTypeAnnotation(parameter.typeAnnotation, scope, substitutions) ?? UNKNOWN_TYPE;
  }

  private resolveOperatorTypeAnnotation(
    annotation: Identifier | undefined,
    scope: Scope,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType | undefined {
    if (!annotation) {
      return undefined;
    }
    if (substitutions.has(annotation.name)) {
      return substitutions.get(annotation.name);
    }
    if (substitutions.size > 0) {
      return this.substituteTypeParameters(this.typeFromTypeNameLoose(annotation.name), substitutions);
    }
    return this.resolveTypeAnnotation(annotation, scope);
  }

  private operatorParametersMatch(
    parameters: readonly FunctionParameter[],
    argumentTypes: readonly AnalysisType[],
    scope: Scope,
    substitutions: Map<string, AnalysisType> = new Map()
  ): boolean {
    const restParameter = parameters[parameters.length - 1]?.rest === true
      ? parameters[parameters.length - 1]
      : undefined;
    const fixedParameters = restParameter ? parameters.slice(0, -1) : parameters;
    if (argumentTypes.length < fixedParameters.filter((parameter) =>
      parameter.optional !== true && parameter.defaultValue === undefined
    ).length) {
      return false;
    }
    if (!restParameter && argumentTypes.length > fixedParameters.length) {
      return false;
    }
    for (const [index, parameter] of fixedParameters.entries()) {
      const argumentType = argumentTypes[index];
      if (!argumentType) {
        if (parameter.optional === true || parameter.defaultValue !== undefined) {
          continue;
        }
        return false;
      }
      if (!this.operatorParameterMatchesWithSubstitutions(parameter, argumentType, scope, substitutions)) {
        return false;
      }
    }
    if (!restParameter) {
      return true;
    }
    const restParameterType = this.operatorParameterType(restParameter, scope, substitutions);
    for (let index = fixedParameters.length; index < argumentTypes.length; index += 1) {
      const expectedType = this.restParameterExpectedTypeAt(restParameterType, index - fixedParameters.length);
      if (
        !isUnknownType(expectedType) &&
        !isUnknownType(argumentTypes[index]!) &&
        !this.isTypeAssignable(argumentTypes[index]!, expectedType)
      ) {
        return false;
      }
    }
    return true;
  }

  private operatorParameterMatchesWithSubstitutions(
    parameter: FunctionParameter | undefined,
    argumentType: AnalysisType,
    scope: Scope,
    substitutions: Map<string, AnalysisType>
  ): boolean {
    if (substitutions.size === 0) {
      return this.operatorParameterMatches(parameter, argumentType, scope);
    }
    const parameterType = this.operatorParameterType(parameter, scope, substitutions);
    return isUnknownType(parameterType) || isUnknownType(argumentType) || this.isTypeAssignable(argumentType, parameterType);
  }

  private inferBinaryType(
    operator: BinaryExpression["operator"],
    leftType: AnalysisType,
    rightType: AnalysisType
  ): AnalysisType {
    if (
      operator === "+" &&
      (isStringLikeType(leftType) || isStringLikeType(rightType))
    ) {
      return builtinType("string");
    }

    if (
      operator === "+" ||
      operator === "-" ||
      operator === "*" ||
      operator === "/" ||
      operator === "%" ||
      operator === "**" ||
      operator === "<<" ||
      operator === ">>" ||
      operator === ">>>" ||
      operator === "&" ||
      operator === "|" ||
      operator === "^"
    ) {
      if (this.isIntEnumLikeType(leftType) && this.isIntEnumLikeType(rightType)) {
        return builtinType("int");
      }
      if (isIntType(leftType) && isIntType(rightType)) {
        return builtinType("int");
      }
      if (isNumberType(leftType) && isNumberType(rightType)) {
        return builtinType("number");
      }
      if (isNumberLikeType(leftType) || isNumberLikeType(rightType)) {
        return builtinType("number");
      }
      if (isBigIntType(leftType) && isBigIntType(rightType)) {
        return builtinType("bigint");
      }
      if (isLongType(leftType) && isLongType(rightType)) {
        return builtinType("long");
      }
      return UNKNOWN_TYPE;
    }

    if (operator === "??") {
      if (isUnknownType(leftType)) {
        return rightType;
      }
      return leftType;
    }

    // The three-way comparison (spaceship) operator yields an ordering: -1, 0,
    // or 1.
    if (operator === "<=>") {
      return builtinType("int");
    }

    if (
      operator === "<" ||
      operator === ">" ||
      operator === "<=" ||
      operator === ">=" ||
      operator === "in" ||
      operator === "is" ||
      operator === "instanceof" ||
      operator === "==" ||
      operator === "!=" ||
      operator === "===" ||
      operator === "!==" ||
      operator === "||" ||
      operator === "&&"
    ) {
      return builtinType("boolean");
    }

    return UNKNOWN_TYPE;
  }

  private isTypeAssignable(sourceType: AnalysisType, targetType: AnalysisType): boolean {
    const assignabilityKey = `${this.analysisTypeId(sourceType)}=>${this.analysisTypeId(targetType)}`;
    if (this.assignabilityChecksInProgress.has(assignabilityKey)) {
      return true;
    }
    this.assignabilityChecksInProgress.add(assignabilityKey);
    try {
    const expandedSourceType = this.expandTypeAliases(sourceType);
    const expandedTargetType = this.expandTypeAliases(targetType);
    if (!isSameType(expandedSourceType, sourceType) || !isSameType(expandedTargetType, targetType)) {
      return this.isTypeAssignable(expandedSourceType, expandedTargetType);
    }

    const normalizedSourceType = this.normalizeLooseNamedType(sourceType);
    const normalizedTargetType = this.normalizeLooseNamedType(targetType);
    if (!isSameType(normalizedSourceType, sourceType) || !isSameType(normalizedTargetType, targetType)) {
      return this.isTypeAssignable(normalizedSourceType, normalizedTargetType);
    }

    if (isSameType(sourceType, targetType)) {
      return true;
    }

    if (targetType.kind === "named" && this.isActiveTypeParameter(targetType.name)) {
      return true;
    }

    if (sourceType.kind === "named" && this.isActiveTypeParameter(sourceType.name)) {
      return true;
    }

    if (targetType.kind === "union") {
      return targetType.types.some((member) => this.isTypeAssignable(sourceType, member));
    }

    if (sourceType.kind === "union") {
      return sourceType.types.every((member) => this.isTypeAssignable(member, targetType));
    }

    if (targetType.kind === "intersection") {
      return targetType.types.every((member) => this.isTypeAssignable(sourceType, member));
    }

    if (sourceType.kind === "intersection") {
      return sourceType.types.some((member) => this.isTypeAssignable(member, targetType));
    }

    if (sourceType.kind === "literal") {
      if (targetType.kind === "literal") {
        return sourceType.base === targetType.base && sourceType.value === targetType.value;
      }
      if (targetType.kind === "builtin" && targetType.name === sourceType.base) {
        return true;
      }
      if (
        targetType.kind === "builtin" &&
        targetType.name === "int" &&
        sourceType.base === "number" &&
        Number.isInteger(sourceType.value)
      ) {
        return true;
      }
    }

    if (sourceType.kind === "tuple" && targetType.kind === "array") {
      if (sourceType.readonly === true && targetType.readonly !== true) {
        return false;
      }
      const targetElementType = targetType.elementType;
      if (
        isUnknownType(targetElementType)
        || (targetElementType.kind === "builtin" && targetElementType.name === "unknown")
      ) {
        return true;
      }
      return sourceType.elements.every((element) => this.isTypeAssignable(element, targetType.elementType));
    }

    if (sourceType.kind === "tuple" && targetType.kind === "tuple") {
      if (sourceType.readonly === true && targetType.readonly !== true) {
        return false;
      }
      if (sourceType.elements.length !== targetType.elements.length) {
        return false;
      }
      return sourceType.elements.every((element, index) =>
        this.isTypeAssignable(element, targetType.elements[index]!)
      );
    }

    if (sourceType.kind === "array" && targetType.kind === "tuple") {
      return this.arrayTypeIsAssignableToTuple(sourceType, targetType);
    }

    if (targetType.kind === "builtin" && targetType.name === "any") {
      return true;
    }

    if (sourceType.kind === "builtin" && sourceType.name === "any") {
      return true;
    }

    if (sourceType.kind === "builtin" && sourceType.name === "never") {
      return true;
    }

    if (targetType.kind === "builtin" && targetType.name === "unknown") {
      return true;
    }

    if (sourceType.kind === "named") {
      const expandedSourceType = this.expandTypeAliases(sourceType);
      if ((expandedSourceType.kind !== "named" || !isSameType(expandedSourceType, sourceType))) {
        return this.isTypeAssignable(expandedSourceType, targetType);
      }
    }

    if (targetType.kind === "named") {
      const expandedTargetType = this.expandTypeAliases(targetType);
      if ((expandedTargetType.kind !== "named" || !isSameType(expandedTargetType, targetType))) {
        return this.isTypeAssignable(sourceType, expandedTargetType);
      }
    }

    if (
      sourceType.kind === "function" &&
      targetType.kind === "named" &&
      (targetType.name === "Function" || targetType.name === "CallableFunction" || targetType.name === "NewableFunction")
    ) {
      return true;
    }

    if (
      targetType.kind === "builtin" &&
      targetType.name === "object" &&
      (
        sourceType.kind === "object" ||
        sourceType.kind === "named" ||
        sourceType.kind === "array" ||
        sourceType.kind === "function"
      )
    ) {
      return true;
    }

    if (sourceType.kind === "function" && targetType.kind === "function") {
      if (targetType.parameters.length === 0 && this.returnValueIsOptional(targetType.returnType)) {
        return true;
      }
      const targetRequiredCount = targetType.parameters.filter((parameter) => !parameter.optional).length;
      if (sourceType.parameters.length < targetRequiredCount) {
        return false;
      }

      for (let index = 0; index < targetType.parameters.length; index += 1) {
        const targetParameter = targetType.parameters[index];
        const sourceParameter = sourceType.parameters[index];
        if (!targetParameter || !sourceParameter) {
          return false;
        }
        const parameterAssignable =
          this.isTypeAssignable(targetParameter.type, sourceParameter.type)
          || this.isTypeAssignable(sourceParameter.type, targetParameter.type);
        if (!parameterAssignable) {
          return false;
        }
        if ((targetParameter.optional ?? false) === false && (sourceParameter.optional ?? false) === true) {
          return false;
        }
      }

      return this.isTypeAssignable(sourceType.returnType, targetType.returnType);
    }

    if (sourceType.kind === "array" && targetType.kind === "array") {
      if (sourceType.readonly === true && targetType.readonly !== true) {
        return false;
      }
      // An array whose element type is `unknown` (for example the empty array
      // literal `[]`, or an explicit `unknown[]`) is assignable to any array
      // type, mirroring how an empty array can be widened to any element type.
      const element = sourceType.elementType;
      if (isUnknownType(element) || (element.kind === "builtin" && element.name === "unknown")) {
        return true;
      }
      return this.isTypeAssignable(sourceType.elementType, targetType.elementType);
    }

    if (sourceType.kind === "range" && targetType.kind === "range") {
      return this.isTypeAssignable(sourceType.elementType, targetType.elementType);
    }

    if (sourceType.kind === "range" && targetType.kind === "array") {
      return this.isTypeAssignable(sourceType.elementType, targetType.elementType);
    }

    if (sourceType.kind === "object" && targetType.kind === "object") {
      return this.objectPropertiesAreAssignable(sourceType.properties, targetType.properties);
    }

    if (sourceType.kind === "named" && targetType.kind === "object") {
      const sourceMembers = this.resolveNamedTypeMembers(sourceType);
      if (!sourceMembers) {
        return false;
      }
      return this.objectPropertiesAreAssignable(sourceMembers, targetType.properties);
    }

    if (sourceType.kind === "object" && targetType.kind === "named") {
      const namedMembers = this.resolveNamedTypeMembers(targetType);
      if (!namedMembers) {
        return false;
      }
      return this.objectPropertiesAreAssignable(sourceType.properties, namedMembers);
    }

    if (sourceType.kind === "array" && targetType.kind === "named") {
      if (
        targetType.name === "ReadonlyArray"
        && (targetType.typeArguments?.length ?? 0) === 1
      ) {
        return this.isTypeAssignable(sourceType.elementType, targetType.typeArguments![0]!);
      }
      return this.isTypeAssignable(namedType("Array", [sourceType.elementType]), targetType);
    }

    if (
      sourceType.kind === "tuple"
      && targetType.kind === "named"
      && (sourceType.elements.length === 0 || targetType.typeArguments?.[0])
      && (targetType.name === "Array" || targetType.name === "ReadonlyArray")
    ) {
      if (sourceType.readonly === true && targetType.name !== "ReadonlyArray") {
        return false;
      }
      const targetElementType = targetType.typeArguments?.[0] ?? UNKNOWN_TYPE;
      if (
        isUnknownType(targetElementType)
        || (targetElementType.kind === "builtin" && targetElementType.name === "unknown")
      ) {
        return true;
      }
      return sourceType.elements.every((element) => this.isTypeAssignable(element, targetElementType));
    }

    if (
      sourceType.kind === "named"
      && targetType.kind === "array"
      && sourceType.name === "Array"
      && (sourceType.typeArguments?.length ?? 0) === 1
    ) {
      return this.isTypeAssignable(sourceType.typeArguments![0]!, targetType.elementType);
    }

    if (sourceType.kind === "named" && targetType.kind === "named") {
      if (this.isDomNodeAssignableToContainerLikeType(sourceType, targetType)) {
        return true;
      }
      if (sourceType.name === "JSX.Element" && targetType.name === "VNode") {
        return true;
      }
      if (sourceType.name === targetType.name) {
        const sourceTypeArguments = sourceType.typeArguments ?? [];
        const targetTypeArguments = targetType.typeArguments ?? [];
        return this.areNamedTypeArgumentsAssignable(sourceTypeArguments, targetTypeArguments);
      }
      if (this.isNamedTypeAssignableByDeclaration(sourceType, targetType)) {
        return true;
      }
      return this.isNamedTypeStructurallyAssignable(sourceType, targetType);
    }

    if (isIntType(sourceType) && isNumberType(targetType)) {
      return true;
    }

    if (isLongType(sourceType) && isBigIntType(targetType)) {
      return true;
    }

    // `numeric` is the common supertype of the integer (`int`/`number`) and
    // big-integer (`long`/`bigint`) numeric families.
    if (isNumericType(targetType) && isNumericFamilyType(sourceType)) {
      return true;
    }

    return false;
    } finally {
      this.assignabilityChecksInProgress.delete(assignabilityKey);
    }
  }

  private arrayTypeIsAssignableToTuple(
    sourceType: AnalysisType & { kind: "array" },
    targetType: AnalysisType & { kind: "tuple" }
  ): boolean {
    if (sourceType.readonly === true && targetType.readonly !== true) {
      return false;
    }
    if (targetType.elements.length === 0) {
      return false;
    }
    const sourceElementType = sourceType.elementType;
    if (isUnknownType(sourceElementType) || (sourceElementType.kind === "builtin" && sourceElementType.name === "unknown")) {
      return true;
    }

    const collapsedRestElementType = this.collapsedRestTupleElementType(targetType);
    if (collapsedRestElementType) {
      const fixedElements = targetType.elements.slice(0, -1);
      return fixedElements.every((element) => this.isTypeAssignable(sourceElementType, element))
        && this.isTypeAssignable(sourceElementType, collapsedRestElementType);
    }

    return targetType.elements.every((element) => this.isTypeAssignable(sourceElementType, element));
  }

  private collapsedRestTupleElementType(targetType: AnalysisType & { kind: "tuple" }): AnalysisType | null {
    const lastElement = targetType.elements[targetType.elements.length - 1];
    if (!lastElement) {
      return null;
    }
    const normalizedLastElement = this.normalizeLooseNamedType(this.expandTypeAliases(lastElement));
    if (normalizedLastElement.kind === "array") {
      return normalizedLastElement.elementType;
    }
    if (
      normalizedLastElement.kind === "named"
      && (normalizedLastElement.name === "Array" || normalizedLastElement.name === "ReadonlyArray")
      && normalizedLastElement.typeArguments?.[0]
    ) {
      return normalizedLastElement.typeArguments[0];
    }
    return null;
  }

  private isDomNodeAssignableToContainerLikeType(
    sourceType: AnalysisType & { kind: "named" },
    targetType: AnalysisType & { kind: "named" }
  ): boolean {
    if (!this.isDomNodeLikeNamedType(sourceType) || !this.isContainerNodeLikeNamedType(targetType)) {
      return false;
    }
    return true;
  }

  private isDomNodeLikeNamedType(type: AnalysisType & { kind: "named" }): boolean {
    return type.name === "Node" || this.isNamedTypeAssignableByDeclaration(type, namedType("Node"));
  }

  private isContainerNodeLikeNamedType(type: AnalysisType & { kind: "named" }): boolean {
    const members = this.resolveNamedTypeMembers(type);
    if (!members) {
      return false;
    }
    for (const memberName of ["nodeType", "parentNode", "firstChild", "childNodes", "contains", "insertBefore", "appendChild", "removeChild"]) {
      if (!members.has(memberName)) {
        return false;
      }
    }
    return true;
  }

  private normalizeLooseNamedType(type: AnalysisType): AnalysisType {
    if (type.kind !== "named") {
      return type;
    }
    const computed = this.typeFromComputedTypeNameLoose(type.name);
    if (computed) {
      return computed;
    }
    const functionType = this.functionTypeFromAnnotationText(type.name);
    if (functionType) {
      return functionType;
    }
    const objectType = this.objectTypeFromAnnotationText(type.name);
    if (objectType) {
      return objectType;
    }
    return type;
  }

  private analysisTypeId(type: AnalysisType): number {
    const objectType = type as object;
    const existingId = this.analysisTypeIds.get(objectType);
    if (existingId !== undefined) {
      return existingId;
    }
    const newId = this.nextAnalysisTypeId;
    this.nextAnalysisTypeId += 1;
    this.analysisTypeIds.set(objectType, newId);
    return newId;
  }

  private isNamedTypeStructurallyAssignable(
    sourceType: AnalysisType & { kind: "named" },
    targetType: AnalysisType & { kind: "named" }
  ): boolean {
    const targetMembers = this.resolveNamedTypeMembers(targetType);
    if (!targetMembers) {
      return false;
    }
    const sourceMembers = this.resolveNamedTypeMembers(sourceType);
    if (!sourceMembers) {
      return false;
    }
    return this.objectPropertiesAreAssignable(sourceMembers, targetMembers);
  }

  private isNamedTypeAssignableByDeclaration(
    sourceType: AnalysisType & { kind: "named" },
    targetType: AnalysisType & { kind: "named" },
    visited = new Set<string>()
  ): boolean {
    const visitKey = `${typeToString(sourceType)}=>${typeToString(targetType)}`;
    if (visited.has(visitKey)) {
      return false;
    }
    visited.add(visitKey);

    for (const parentType of this.directNamedSuperTypes(sourceType)) {
      if (parentType.name === targetType.name) {
        const parentArguments = parentType.typeArguments ?? [];
        const targetArguments = targetType.typeArguments ?? [];
        if (this.areNamedTypeArgumentsAssignable(parentArguments, targetArguments)) {
          return true;
        }
      }
      if (this.isNamedTypeAssignableByDeclaration(parentType, targetType, visited)) {
        return true;
      }
    }

    return false;
  }

  private areNamedTypeArgumentsAssignable(sourceArguments: AnalysisType[], targetArguments: AnalysisType[]): boolean {
    if (targetArguments.length === 0) {
      return true;
    }
    if (sourceArguments.length === targetArguments.length) {
      return sourceArguments.every((sourceArgument, index) =>
        this.isTypeAssignable(sourceArgument, targetArguments[index]!)
      );
    }
    return sourceArguments.length === 0 && targetArguments.every((targetArgument) =>
      targetArgument.kind === "builtin" && targetArgument.name === "any"
    );
  }

  private directNamedSuperTypes(type: AnalysisType & { kind: "named" }): Array<AnalysisType & { kind: "named" }> {
    const parents: Array<AnalysisType & { kind: "named" }> = [];
    const pushParent = (parentType: AnalysisType): void => {
      if (parentType.kind === "named") {
        parents.push(parentType);
      }
    };

    const classStatement = this.classStatementsByName.get(type.name);
    if (classStatement) {
      const substitutions = this.typeParameterSubstitutions(classStatement.typeParameters ?? [], type);
      if (classStatement.extendsType) {
        pushParent(this.typeFromTypeNameLooseWithSubstitutions(classStatement.extendsType.name, substitutions));
      }
      for (const implementedType of classStatement.implementsTypes ?? []) {
        pushParent(this.typeFromTypeNameLooseWithSubstitutions(implementedType.name, substitutions));
      }
    }

    const interfaceStatement = this.interfaceStatementsByName.get(type.name);
    if (interfaceStatement) {
      const substitutions = this.typeParameterSubstitutions(interfaceStatement.typeParameters ?? [], type);
      for (const parentType of interfaceStatement.extendsTypes ?? []) {
        pushParent(this.typeFromTypeNameLooseWithSubstitutions(parentType.name, substitutions));
      }
    }

    return parents;
  }

  private objectPropertiesAreAssignable(
    sourceProperties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
    targetProperties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>
  ): boolean {
    const targetEntries = propertyEntries(targetProperties);
    const explicitTargetEntries = targetEntries.filter(([propertyName]) => !isDynamicPropertyName(propertyName));
    const explicitTargetPropertyNames = explicitTargetEntries.map(([propertyName]) => propertyName);
    const dynamicTargetPropertyTypes = targetEntries
      .filter(([propertyName]) => isDynamicPropertyName(propertyName))
      .map(([, propertyType]) => propertyType);

    for (const [propertyName, targetPropertyType] of explicitTargetEntries) {
      const sourcePropertyType = propertyTypeFrom(sourceProperties, propertyName);
      if (!sourcePropertyType) {
        if (propertyTypeAllowsUndefined(targetPropertyType)) {
          continue;
        }
        return false;
      }
      if (this.isTypeAssignable(sourcePropertyType, targetPropertyType)) {
        continue;
      }
      const definedTargetPropertyType = propertyTypeWithoutUndefined(targetPropertyType);
      if (definedTargetPropertyType && this.isTypeAssignable(sourcePropertyType, definedTargetPropertyType)) {
        continue;
      }
      if (!this.isTypeAssignable(sourcePropertyType, targetPropertyType)) {
        return false;
      }
    }

    if (dynamicTargetPropertyTypes.length === 0) {
      return true;
    }

    for (const [sourcePropertyName, sourcePropertyType] of propertyEntries(sourceProperties)) {
      if (explicitTargetPropertyNames.some((targetPropertyName) => propertyNamesMatch(targetPropertyName, sourcePropertyName))) {
        continue;
      }
      if (!dynamicTargetPropertyTypes.some((dynamicTargetPropertyType) =>
        this.isPropertyAssignableToTargetType(sourcePropertyType, dynamicTargetPropertyType)
      )) {
        return false;
      }
    }
    return true;
  }

  private isPropertyAssignableToTargetType(sourceType: AnalysisType, targetType: AnalysisType): boolean {
    if (this.isTypeAssignable(sourceType, targetType)) {
      return true;
    }
    const definedTargetType = propertyTypeWithoutUndefined(targetType);
    return definedTargetType ? this.isTypeAssignable(sourceType, definedTargetType) : false;
  }

  private buildFunctionType(
    parameters: FunctionParameter[],
    returnType: AnalysisType,
    scope: Scope,
    typeParameters: TypeParameter[] = [],
    returnTypeText?: string
  ): AnalysisType {
    return functionType(
      parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
        name: bindingNameText(parameter.name),
        type: this.functionParameterType(parameter, scope),
        optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
        rest: parameter.rest === true
      })),
      returnType,
      typeParameters.map((parameter) => parameter.name.name),
      this.typeParameterConstraintMap(typeParameters, scope),
      this.typeParameterDefaultMap(typeParameters, scope),
      this.assertionTypeFromText(returnTypeText, scope)
    );
  }

  private functionParameterType(parameter: FunctionParameter, scope: Scope): AnalysisType {
    if (parameter.typeAnnotation) {
      return this.resolveTypeAnnotation(parameter.typeAnnotation, scope) ?? UNKNOWN_TYPE;
    }
    const patternType = this.bindingPatternAnnotationType(parameter.name, scope);
    if (patternType) {
      return patternType;
    }
    return scope.symbols.get(bindingNameText(parameter.name))?.type ?? UNKNOWN_TYPE;
  }

  private assertionTypeFromText(
    returnTypeText: string | undefined,
    scope: Scope
  ): { target: string; type?: AnalysisType } | undefined {
    if (!returnTypeText) {
      return undefined;
    }
    const parsed = parseAssertionTypePredicateText(returnTypeText);
    if (!parsed) {
      return undefined;
    }
    return {
      target: parsed.targetText,
      ...(parsed.assertedTypeText
        ? { type: this.resolveTypeNameText(parsed.assertedTypeText, scope.node, scope, false) }
        : {})
    };
  }

  private bindingPatternAnnotationType(binding: BindingName, scope: Scope): AnalysisType | null {
    if (binding.kind === "Identifier") {
      return null;
    }
    if (binding.kind === "ObjectBindingPattern") {
      const properties: Record<string, AnalysisType> = {};
      let hasTypedProperty = false;
      for (const element of binding.elements) {
        if (element.rest === true) {
          continue;
        }
        const propertyName = bindingElementPropertyName(element);
        if (!propertyName) {
          continue;
        }
        const annotatedType = element.typeAnnotation
          ? this.resolveTypeAnnotation(element.typeAnnotation, scope) ?? UNKNOWN_TYPE
          : this.bindingPatternAnnotationType(element.name, scope);
        if (!annotatedType) {
          continue;
        }
        properties[propertyName] = annotatedType;
        hasTypedProperty = true;
      }
      return hasTypedProperty ? objectTypeWithProperties(properties) : null;
    }

    const elements: AnalysisType[] = [];
    let hasTypedElement = false;
    binding.elements.forEach((element, index) => {
      if (element.kind === "BindingHole") {
        elements[index] = UNKNOWN_TYPE;
        return;
      }
      const annotatedType = element.typeAnnotation
        ? this.resolveTypeAnnotation(element.typeAnnotation, scope) ?? UNKNOWN_TYPE
        : this.bindingPatternAnnotationType(element.name, scope);
      elements[index] = annotatedType ?? UNKNOWN_TYPE;
      if (annotatedType) {
        hasTypedElement = true;
      }
    });
    return hasTypedElement ? tupleType(elements) : null;
  }

  private typeParameterConstraintMap(
    typeParameters: TypeParameter[],
    scope: Scope
  ): Record<string, AnalysisType> | undefined {
    const constraints: Record<string, AnalysisType> = {};
    for (const typeParameter of typeParameters) {
      if (!typeParameter.constraint) {
        continue;
      }
      constraints[typeParameter.name.name] = this.resolveTypeAnnotation(typeParameter.constraint, scope) ?? UNKNOWN_TYPE;
    }
    return Object.keys(constraints).length > 0 ? constraints : undefined;
  }

  private typeParameterDefaultMap(
    typeParameters: TypeParameter[],
    scope: Scope
  ): Record<string, AnalysisType> | undefined {
    const defaults: Record<string, AnalysisType> = {};
    for (const typeParameter of typeParameters) {
      if (!typeParameter.defaultType) {
        continue;
      }
      defaults[typeParameter.name.name] = this.resolveTypeAnnotation(typeParameter.defaultType, scope) ?? UNKNOWN_TYPE;
    }
    return Object.keys(defaults).length > 0 ? defaults : undefined;
  }

  private typeFromAnnotationLooseWithTypeParameters(
    typeAnnotation: Identifier | undefined,
    localTypeParameterNames: readonly string[],
    contextualThisTypeName?: string
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    return this.typeFromTypeNameLooseWithTypeParameters(
      typeAnnotation.name,
      new Set(localTypeParameterNames),
      contextualThisTypeName
    );
  }

  private typeFromTypeNameLooseWithTypeParameters(
    typeName: string | undefined,
    localTypeParameterNames: ReadonlySet<string>,
    contextualThisTypeName?: string
  ): AnalysisType | undefined {
    if (!typeName) {
      return undefined;
    }
    const normalizedTypeName = typeName.trim();
    if (normalizedTypeName === "this" && contextualThisTypeName) {
      return this.typeFromTypeNameLoose(contextualThisTypeName);
    }
    const functionType = this.functionTypeFromAnnotationText(typeName);
    if (functionType) {
      return functionType;
    }
    const objectType = this.objectTypeFromAnnotationText(typeName);
    if (objectType) {
      return objectType;
    }
    const typeQueryType = this.typeFromTypeQueryNameLoose(typeName);
    if (typeQueryType) {
      return typeQueryType;
    }
    if (looksLikeFunctionTypeAnnotation(typeName)) {
      return UNKNOWN_TYPE;
    }
    const readonlyContainer = parseReadonlyContainerTypeText(normalizedTypeName);
    if (readonlyContainer?.kind === "tuple") {
      return tupleType(
        (readonlyContainer.tupleElementTypeTexts ?? []).map((part) =>
          this.typeFromTypeNameLooseWithTypeParameters(part, localTypeParameterNames, contextualThisTypeName) ?? UNKNOWN_TYPE
        ),
        true
      );
    }
    if (readonlyContainer?.kind === "array" && readonlyContainer.elementTypeText) {
      return arrayType(
        this.typeFromTypeNameLooseWithTypeParameters(
          readonlyContainer.elementTypeText,
          localTypeParameterNames,
          contextualThisTypeName
        ) ?? UNKNOWN_TYPE,
        true
      );
    }
    const optionalSuffix = splitOptionalTypeSuffix(normalizedTypeName);
    if (optionalSuffix.optional) {
      return unionType([
        this.typeFromTypeNameLooseWithTypeParameters(
          optionalSuffix.typeName,
          localTypeParameterNames,
          contextualThisTypeName
        ) ?? UNKNOWN_TYPE,
        builtinType("undefined")
      ]);
    }
    const arraySuffix = splitArraySuffixTypeName(normalizedTypeName);
    if (arraySuffix) {
      let elementType = this.typeFromTypeNameLooseWithTypeParameters(
        arraySuffix.elementTypeName,
        localTypeParameterNames,
        contextualThisTypeName
      ) ?? UNKNOWN_TYPE;
      for (let i = 0; i < arraySuffix.arrayDepth; i += 1) {
        elementType = arrayType(elementType);
      }
      return elementType;
    }
    const literal = resolveLiteralTypeName(normalizedTypeName);
    if (literal) {
      return literal;
    }
    if (normalizedTypeName.startsWith("keyof ")) {
      const targetType = this.typeFromTypeNameLooseWithTypeParameters(
        normalizedTypeName.slice("keyof ".length).trim(),
        localTypeParameterNames,
        contextualThisTypeName
      ) ?? UNKNOWN_TYPE;
      return this.keyofType(targetType);
    }
    if (normalizedTypeName.startsWith("typeof ")) {
      return this.typeFromTypeQueryNameLoose(normalizedTypeName) ?? UNKNOWN_TYPE;
    }
    const indexedAccess = splitIndexedAccessTypeName(normalizedTypeName);
    if (indexedAccess) {
      if (localTypeParameterNames.has(indexedAccess.indexTypeName.trim())) {
        return namedType(normalizedTypeName);
      }
      const objectType = this.typeFromTypeNameLooseWithTypeParameters(
        indexedAccess.objectTypeName,
        localTypeParameterNames,
        contextualThisTypeName
      ) ?? UNKNOWN_TYPE;
      const indexType = this.typeFromTypeNameLooseWithTypeParameters(
        indexedAccess.indexTypeName,
        localTypeParameterNames,
        contextualThisTypeName
      ) ?? UNKNOWN_TYPE;
      return this.indexedAccessType(objectType, indexType);
    }
    const computedType = this.typeFromComputedTypeNameLoose(typeName);
    if (computedType) {
      return computedType;
    }
    const unionParts = splitTopLevelTypeText(normalizedTypeName, "|");
    if (unionParts.length > 1) {
      return unionType(unionParts.map((part) =>
        this.typeFromTypeNameLooseWithTypeParameters(part, localTypeParameterNames, contextualThisTypeName) ?? UNKNOWN_TYPE
      ));
    }
    const intersectionParts = splitTopLevelTypeText(normalizedTypeName, "&");
    if (intersectionParts.length > 1) {
      return intersectionType(intersectionParts.map((part) =>
        this.typeFromTypeNameLooseWithTypeParameters(part, localTypeParameterNames, contextualThisTypeName) ?? UNKNOWN_TYPE
      ));
    }
    if (normalizedTypeName.startsWith("[") && normalizedTypeName.endsWith("]")) {
      const tupleBody = normalizedTypeName.slice(1, -1).trim();
      return tupleType(
        tupleBody.length === 0
          ? []
          : splitTopLevelTypeText(tupleBody, ",").map((part) =>
            this.typeFromTypeNameLooseWithTypeParameters(
              tupleElementTypeText(part),
              localTypeParameterNames,
              contextualThisTypeName
            ) ?? UNKNOWN_TYPE
          )
      );
    }
    const parsed = parseTypeNameShape(normalizedTypeName);
    const resolvedTypeArguments = parsed.typeArguments.map((typeArgument) =>
      this.typeFromTypeNameLooseWithTypeParameters(typeArgument, localTypeParameterNames, contextualThisTypeName) ?? UNKNOWN_TYPE
    );
    if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      let resolved: AnalysisType = builtinType(parsed.baseName as BuiltinTypeName);
      for (let i = 0; i < parsed.arrayDepth; i += 1) {
        resolved = arrayType(resolved);
      }
      return resolved;
    }
    if (localTypeParameterNames.has(parsed.baseName) || this.isActiveTypeParameter(parsed.baseName)) {
      let resolved: AnalysisType = namedType(parsed.baseName, resolvedTypeArguments);
      for (let i = 0; i < parsed.arrayDepth; i += 1) {
        resolved = arrayType(resolved);
      }
      return resolved;
    }
    if (this.knownNamedTypeExists(parsed.baseName)) {
      let resolved: AnalysisType = namedType(parsed.baseName, resolvedTypeArguments);
      for (let i = 0; i < parsed.arrayDepth; i += 1) {
        resolved = arrayType(resolved);
      }
      return this.expandTypeAliases(resolved);
    }
    return this.typeFromTypeNameLoose(typeName);
  }


  private typeParameterConstraintMapLoose(
    typeParameters: TypeParameter[],
    localTypeParameterNames: readonly string[]
  ): Record<string, AnalysisType> | undefined {
    const constraints: Record<string, AnalysisType> = {};
    for (const typeParameter of typeParameters) {
      if (!typeParameter.constraint) {
        continue;
      }
      constraints[typeParameter.name.name] = this.typeFromAnnotationLooseWithTypeParameters(
        typeParameter.constraint,
        localTypeParameterNames
      ) ?? UNKNOWN_TYPE;
    }
    return Object.keys(constraints).length > 0 ? constraints : undefined;
  }

  private typeParameterDefaultMapLoose(
    typeParameters: TypeParameter[],
    localTypeParameterNames: readonly string[]
  ): Record<string, AnalysisType> | undefined {
    const defaults: Record<string, AnalysisType> = {};
    for (const typeParameter of typeParameters) {
      if (!typeParameter.defaultType) {
        continue;
      }
      defaults[typeParameter.name.name] = this.typeFromAnnotationLooseWithTypeParameters(
        typeParameter.defaultType,
        localTypeParameterNames
      ) ?? UNKNOWN_TYPE;
    }
    return Object.keys(defaults).length > 0 ? defaults : undefined;
  }

  private applyCallArgumentContext(
    call: CallExpression,
    scope: Scope,
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): AnalysisType[] {
    let contextualArgumentTypes: AnalysisType[] | undefined;

    for (let index = 0; index < call.arguments.length && index < calleeType.parameters.length; index += 1) {
      const argument = call.arguments[index]!;
      const contextualExpectedType = this.contextualExpectedTypeForCallArgument(
        argument,
        calleeType.parameters[index]?.type,
        calleeType.typeParameters ?? []
      );
      if (!contextualExpectedType) {
        continue;
      }

      const contextualArgumentType = this.visitExpression(argument, scope, contextualExpectedType);
      if (!contextualArgumentTypes) {
        contextualArgumentTypes = [...argumentTypes];
      }
      contextualArgumentTypes[index] = contextualArgumentType;
    }

    return contextualArgumentTypes ?? argumentTypes;
  }

  private contextualExpectedTypeForCallArgument(
    argument: Expr,
    expectedParameterType: AnalysisType | undefined,
    typeParameters: string[]
  ): AnalysisType | null {
    return expectedParameterType
      ? this.contextualTypeForExpressionArgument(
          argument,
          this.contextualTypeWithoutUnresolvedReturnType(expectedParameterType, typeParameters)
        )
      : null;
  }

  private preserveCallLiteralArgumentTypes(args: readonly Expr[], argumentTypes: AnalysisType[]): AnalysisType[] {
    let preserved: AnalysisType[] | null = null;
    for (let index = 0; index < args.length; index += 1) {
      const narrowed = this.literalArgumentType(args[index]!, argumentTypes[index] ?? UNKNOWN_TYPE);
      if (narrowed === argumentTypes[index]) {
        continue;
      }
      if (!preserved) {
        preserved = [...argumentTypes];
      }
      preserved[index] = narrowed;
    }
    return preserved ?? argumentTypes;
  }

  private literalSensitiveInferenceArgumentTypes(
    calleeType: AnalysisType & { kind: "function" },
    args: readonly Expr[],
    argumentTypes: AnalysisType[]
  ): AnalysisType[] {
    const constraints = calleeType.typeParameterConstraints;
    if (!constraints || args.length === 0) {
      return argumentTypes;
    }
    let preserved: AnalysisType[] | null = null;
    for (let index = 0; index < args.length && index < calleeType.parameters.length; index += 1) {
      const parameterType = calleeType.parameters[index]?.type;
      if (parameterType?.kind !== "named") {
        continue;
      }
      const constraint = constraints[parameterType.name];
      if (!constraint || !this.expectedTypeDependsOnLiteral(constraint)) {
        continue;
      }
      const narrowed = this.literalArgumentType(args[index]!, argumentTypes[index] ?? UNKNOWN_TYPE);
      if (narrowed === argumentTypes[index]) {
        continue;
      }
      if (!preserved) {
        preserved = [...argumentTypes];
      }
      preserved[index] = narrowed;
    }
    return preserved ?? argumentTypes;
  }

  private literalArgumentType(argument: Expr, fallback: AnalysisType): AnalysisType {
    if (argument.kind === "NamedArgument") {
      return this.literalArgumentType((argument as NamedArgument).value, fallback);
    }
    switch (argument.kind) {
      case "StringLiteral":
        return literalType("string", (argument as StringLiteral).value);
      case "ObjectLiteral": {
        let changed = false;
        const properties: Record<string, AnalysisType> = fallback.kind === "object"
          ? { ...fallback.properties }
          : {};
        for (const property of (argument as ObjectLiteral).properties) {
          if (property.kind !== "ObjectProperty") {
            continue;
          }
          const objectProperty = property as ObjectProperty;
          const propertyName = this.staticObjectPropertyName(objectProperty);
          if (!propertyName) {
            continue;
          }
          const currentType = properties[propertyName] ?? this.expressionTypes.get(objectProperty.value) ?? UNKNOWN_TYPE;
          const narrowedType = this.literalArgumentType(objectProperty.value, currentType);
          changed = changed || narrowedType !== currentType || fallback.kind !== "object";
          properties[propertyName] = narrowedType;
        }
        if (!changed) {
          return fallback;
        }
        return objectTypeWithProperties(properties);
      }
      default:
        return fallback;
    }
  }

  private contextualTypeWithoutUnresolvedReturnType(
    expectedType: AnalysisType,
    typeParameters: string[]
  ): AnalysisType {
    if (
      expectedType.kind !== "function" ||
      !this.shouldEraseContextualFunctionReturnType(expectedType.returnType, typeParameters)
    ) {
      return expectedType;
    }

    return {
      ...expectedType,
      returnType: UNKNOWN_TYPE
    };
  }

  private shouldEraseContextualFunctionReturnType(
    returnType: AnalysisType,
    typeParameters: string[]
  ): boolean {
    if (returnType.kind !== "named") {
      return false;
    }
    if (typeParameters.includes(returnType.name)) {
      return true;
    }
    return this.isTypePredicateType(returnType);
  }

  private isTypePredicateType(type: AnalysisType): boolean {
    return type.kind === "named" && /\bis\b/.test(type.name);
  }

  private isFunctionLikeExpression(expression: Expr): boolean {
    return expression.kind === "ArrowFunctionExpression" || expression.kind === "FunctionExpression";
  }

  private contextualTypeForExpressionArgument(
    argument: Expr,
    expectedType: AnalysisType
  ): AnalysisType | null {
    if (argument.kind === "CallExpression" || argument.kind === "NewExpression") {
      return expectedType;
    }
    if (this.isFunctionLikeExpression(argument)) {
      const arrow = argument.kind === "ArrowFunctionExpression" ? argument as ArrowFunctionExpression : undefined;
      return this.contextualFunctionExpectedType(expectedType) ?? (arrow?.contextualObjectLiteral ? expectedType : null);
    }
    if (argument.kind === "ObjectLiteral") {
      return this.contextualObjectLiteralExpectedType(expectedType);
    }
    if (argument.kind === "ArrayLiteral") {
      return expectedType.kind === "array" || expectedType.kind === "range" || expectedType.kind === "tuple" ? expectedType : null;
    }
    return null;
  }

  private contextualObjectLiteralExpectedType(expectedType: AnalysisType): AnalysisType | null {
    const expandedExpectedType = this.expandTypeAliases(this.normalizeLooseNamedType(expectedType));
    if (expandedExpectedType.kind === "object" || expandedExpectedType.kind === "named") {
      return expandedExpectedType;
    }
    if (expandedExpectedType.kind === "intersection") {
      const contextualMembers = expandedExpectedType.types
        .map((member) => this.contextualObjectLiteralExpectedType(member))
        .filter((member): member is AnalysisType => member !== null);
      if (contextualMembers.length === 0) {
        return null;
      }
      return contextualMembers.length === 1 ? contextualMembers[0]! : intersectionType(contextualMembers);
    }
    if (expandedExpectedType.kind === "union") {
      const contextualMembers = expandedExpectedType.types
        .map((member) => this.contextualObjectLiteralExpectedType(member))
        .filter((member): member is AnalysisType => member !== null);
      if (contextualMembers.length === 0) {
        return null;
      }
      return contextualMembers.length === 1 ? contextualMembers[0]! : unionType(contextualMembers);
    }
    return null;
  }

  private contextualFunctionExpectedType(
    expectedType: AnalysisType | undefined
  ): (AnalysisType & { kind: "function" }) | undefined {
    if (!expectedType || isUnknownType(expectedType)) {
      return undefined;
    }
    const expandedExpectedType = this.expandTypeAliases(this.normalizeLooseNamedType(expectedType));
    if (expandedExpectedType.kind !== "union") {
      return expandedExpectedType.kind === "function"
        ? expandedExpectedType
        : undefined;
    }

    const nonNullishMembers = expandedExpectedType.types.filter((member) => !isNullishType(member));
    if (nonNullishMembers.length !== 1) {
      return undefined;
    }
    const onlyMember = nonNullishMembers[0]!;
    return onlyMember.kind === "function"
      ? onlyMember
      : undefined;
  }

  private preservesInferredContextualReturnType(
    expectedReturnType: AnalysisType | undefined,
    scope: Scope
  ): boolean {
    return !!expectedReturnType
      && !isUnknownType(expectedReturnType)
      && this.typeContainsUnresolvedNamedReference(expectedReturnType, scope, new Set<string>());
  }

  private contextualFunctionTypeForExpression(
    expectedFunctionType: (AnalysisType & { kind: "function" }) | undefined,
    scope: Scope
  ): (AnalysisType & { kind: "function" }) | undefined {
    if (!expectedFunctionType) {
      return undefined;
    }
    if (!this.typeContainsUnresolvedNamedReference(expectedFunctionType.returnType, scope, new Set(expectedFunctionType.typeParameters ?? []))) {
      return expectedFunctionType;
    }
    return {
      ...expectedFunctionType,
      returnType: UNKNOWN_TYPE
    };
  }

  private instantiateFunctionType(
    calleeType: AnalysisType & { kind: "function" },
    explicitTypeArguments: AnalysisType[],
    argumentTypes: AnalysisType[],
    expectedReturnType?: AnalysisType,
    resolveDependentSubstitutions: boolean = true
  ): AnalysisType & { kind: "function" } {
    const typeParameters = calleeType.typeParameters ?? [];
    if (typeParameters.length === 0) {
      return calleeType;
    }

    const substitutions = new Map<string, AnalysisType>();
    const explicitlyProvidedTypeParameters = new Set<string>();
    for (let index = 0; index < typeParameters.length; index += 1) {
      const parameterName = typeParameters[index]!;
      const explicitTypeArgument = explicitTypeArguments[index];
      if (!explicitTypeArgument) {
        continue;
      }
      substitutions.set(parameterName, explicitTypeArgument);
      explicitlyProvidedTypeParameters.add(parameterName);
    }

    const typeParameterSet = new Set(typeParameters);
    for (let index = 0; index < calleeType.parameters.length; index += 1) {
      const parameter = calleeType.parameters[index]!;
      const argumentType = parameter.rest
        ? tupleType(argumentTypes.slice(index))
        : argumentTypes[index];
      if (!argumentType) {
        continue;
      }
      this.inferTypeParameterSubstitutions(
        parameter.type,
        argumentType,
        typeParameterSet,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      if (parameter.rest) {
        break;
      }
    }

    if (expectedReturnType && !isUnknownType(expectedReturnType)) {
      this.inferTypeParameterSubstitutions(
        calleeType.returnType,
        expectedReturnType,
        typeParameterSet,
        explicitlyProvidedTypeParameters,
        substitutions
      );
    }

    for (const typeParameter of typeParameters) {
      if (!substitutions.has(typeParameter)) {
        substitutions.set(
          typeParameter,
          calleeType.typeParameterDefaults?.[typeParameter] ?? namedType(typeParameter)
        );
      }
    }
    if (resolveDependentSubstitutions) {
      this.resolveSubstitutionDependencies(substitutions);
    }

    const substituted = this.substituteTypeParameters(calleeType, substitutions) as AnalysisType & { kind: "function" };
    return functionType(
      substituted.parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        ...(parameter.optional !== undefined ? { optional: parameter.optional } : {}),
        ...(parameter.rest ? { rest: true } : {})
      })),
      substituted.returnType,
      substituted.typeParameters,
      substituted.typeParameterConstraints,
      substituted.typeParameterDefaults,
      substituted.assertion
    );
  }

  private resolveSubstitutionDependencies(substitutions: Map<string, AnalysisType>): void {
    for (let pass = 0; pass < substitutions.size; pass += 1) {
      let changed = false;
      for (const [name, type] of substitutions) {
        const resolved = this.substituteTypeParameters(type, substitutions);
        if (typeToString(resolved) === typeToString(type)) {
          continue;
        }
        substitutions.set(name, resolved);
        changed = true;
      }
      if (!changed) {
        break;
      }
    }
  }

  private validateExplicitTypeArgumentArity(
    typeParameterCount: number,
    typeArgumentCount: number,
    node: Node
  ): void {
    if (typeArgumentCount <= typeParameterCount) {
      return;
    }
    this.issues.push({
      message: `Expected at most ${typeParameterCount} type argument(s), but got ${typeArgumentCount}`,
      node
    });
  }

  private inferTypeParameterSubstitutions(
    parameterType: AnalysisType,
    argumentType: AnalysisType,
    typeParameters: Set<string>,
    explicitlyProvidedTypeParameters: Set<string>,
    substitutions: Map<string, AnalysisType>
  ): void {
    if (isUnknownType(parameterType) || isUnknownType(argumentType)) {
      return;
    }

    const expandedParameterType = parameterType.kind === "named"
      ? this.expandTypeAliases(this.normalizeLooseNamedType(parameterType))
      : parameterType;
    if (!isSameType(expandedParameterType, parameterType)) {
      this.inferTypeParameterSubstitutions(
        expandedParameterType,
        argumentType,
        typeParameters,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      return;
    }

    const expandedArgumentType = argumentType.kind === "named"
      ? this.expandTypeAliases(this.normalizeLooseNamedType(argumentType))
      : argumentType;
    if (!isSameType(expandedArgumentType, argumentType)) {
      this.inferTypeParameterSubstitutions(
        parameterType,
        expandedArgumentType,
        typeParameters,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      return;
    }

    if (parameterType.kind === "union") {
      if (argumentType.kind === "union") {
        for (let index = 0; index < parameterType.types.length && index < argumentType.types.length; index += 1) {
          this.inferTypeParameterSubstitutions(
            parameterType.types[index]!,
            argumentType.types[index]!,
            typeParameters,
            explicitlyProvidedTypeParameters,
            substitutions
          );
        }
        return;
      }
      const branchesWithTypeParameters = parameterType.types.filter((branch) =>
        this.typeContainsTypeParameterReference(branch, typeParameters)
      );
      const structurallyMatchingBranches = branchesWithTypeParameters.filter((branch) =>
        this.inferenceBranchCanMatchArgument(branch, argumentType, typeParameters)
      );
      const candidateBranches = structurallyMatchingBranches.length > 0
        ? structurallyMatchingBranches
        : branchesWithTypeParameters;
      for (const branch of candidateBranches) {
        if (!this.typeContainsTypeParameterReference(branch, typeParameters)) {
          continue;
        }
        this.inferTypeParameterSubstitutions(
          branch,
          argumentType,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      return;
    }

    if (parameterType.kind === "intersection") {
      if (argumentType.kind === "intersection") {
        for (let index = 0; index < parameterType.types.length && index < argumentType.types.length; index += 1) {
          this.inferTypeParameterSubstitutions(
            parameterType.types[index]!,
            argumentType.types[index]!,
            typeParameters,
            explicitlyProvidedTypeParameters,
            substitutions
          );
        }
        return;
      }
      for (const branch of parameterType.types) {
        if (!this.typeContainsTypeParameterReference(branch, typeParameters)) {
          continue;
        }
        this.inferTypeParameterSubstitutions(
          branch,
          argumentType,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      return;
    }

    if (parameterType.kind === "named" && typeParameters.has(parameterType.name)) {
      if (explicitlyProvidedTypeParameters.has(parameterType.name)) {
        return;
      }
      this.mergeInferredTypeParameterSubstitution(parameterType.name, argumentType, substitutions);
      return;
    }

    if (parameterType.kind === "array" && argumentType.kind === "array") {
      this.inferTypeParameterSubstitutions(
        parameterType.elementType,
        argumentType.elementType,
        typeParameters,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      return;
    }

    if (parameterType.kind === "range" && argumentType.kind === "range") {
      this.inferTypeParameterSubstitutions(
        parameterType.elementType,
        argumentType.elementType,
        typeParameters,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      return;
    }

    if (parameterType.kind === "tuple" && argumentType.kind === "tuple") {
      for (let index = 0; index < parameterType.elements.length && index < argumentType.elements.length; index += 1) {
        this.inferTypeParameterSubstitutions(
          parameterType.elements[index]!,
          argumentType.elements[index]!,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      return;
    }

    if (parameterType.kind === "named" && argumentType.kind === "object") {
      const parameterMembers = this.resolveNamedTypeMembers(parameterType);
      if (!parameterMembers) {
        return;
      }
      for (const [propertyName, nestedParameterType] of parameterMembers) {
        const nestedArgumentType = argumentType.properties[propertyName];
        if (!nestedArgumentType) {
          continue;
        }
        this.inferTypeParameterSubstitutions(
          nestedParameterType,
          nestedArgumentType,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      return;
    }

    if (parameterType.kind === "object" && argumentType.kind === "named") {
      const argumentMembers = this.resolveNamedTypeMembers(argumentType);
      if (!argumentMembers) {
        return;
      }
      for (const [propertyName, nestedParameterType] of Object.entries(parameterType.properties)) {
        const nestedArgumentType = argumentMembers.get(propertyName);
        if (!nestedArgumentType) {
          continue;
        }
        this.inferTypeParameterSubstitutions(
          nestedParameterType,
          nestedArgumentType,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      return;
    }

    if (parameterType.kind === "named" && argumentType.kind === "named") {
      const parameterTypeArguments = parameterType.typeArguments ?? [];
      const argumentTypeArguments = argumentType.typeArguments ?? [];
      if (parameterType.name !== argumentType.name || parameterTypeArguments.length !== argumentTypeArguments.length) {
        return;
      }
      for (let index = 0; index < parameterTypeArguments.length; index += 1) {
        this.inferTypeParameterSubstitutions(
          parameterTypeArguments[index]!,
          argumentTypeArguments[index]!,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      return;
    }

    if (parameterType.kind === "function" && argumentType.kind === "function") {
      for (let index = 0; index < parameterType.parameters.length && index < argumentType.parameters.length; index += 1) {
        this.inferTypeParameterSubstitutions(
          parameterType.parameters[index]!.type,
          argumentType.parameters[index]!.type,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
      this.inferTypeParameterSubstitutions(
        parameterType.returnType,
        argumentType.returnType,
        typeParameters,
        explicitlyProvidedTypeParameters,
        substitutions
      );
      return;
    }

    if (parameterType.kind === "object" && argumentType.kind === "object") {
      for (const [propertyName, nestedParameterType] of Object.entries(parameterType.properties)) {
        const nestedArgumentType = argumentType.properties[propertyName];
        if (!nestedArgumentType) {
          continue;
        }
        this.inferTypeParameterSubstitutions(
          nestedParameterType,
          nestedArgumentType,
          typeParameters,
          explicitlyProvidedTypeParameters,
          substitutions
        );
      }
    }
  }

  private inferenceBranchCanMatchArgument(
    parameterType: AnalysisType,
    argumentType: AnalysisType,
    typeParameters: Set<string>
  ): boolean {
    if (parameterType.kind === "named" && typeParameters.has(parameterType.name)) {
      return false;
    }

    const expandedParameterType = parameterType.kind === "named"
      ? this.expandTypeAliases(this.normalizeLooseNamedType(parameterType))
      : parameterType;
    const expandedArgumentType = argumentType.kind === "named"
      ? this.expandTypeAliases(this.normalizeLooseNamedType(argumentType))
      : argumentType;

    if (!isSameType(expandedParameterType, parameterType)) {
      return this.inferenceBranchCanMatchArgument(expandedParameterType, expandedArgumentType, typeParameters);
    }
    if (!isSameType(expandedArgumentType, argumentType)) {
      return this.inferenceBranchCanMatchArgument(expandedParameterType, expandedArgumentType, typeParameters);
    }

    if (expandedParameterType.kind === "named" && expandedArgumentType.kind === "named") {
      if (expandedParameterType.name !== expandedArgumentType.name) {
        return false;
      }
      const parameterTypeArguments = expandedParameterType.typeArguments ?? [];
      const argumentTypeArguments = expandedArgumentType.typeArguments ?? [];
      return parameterTypeArguments.length === argumentTypeArguments.length;
    }

    if (expandedParameterType.kind === "array" && expandedArgumentType.kind === "array") {
      return true;
    }
    if (expandedParameterType.kind === "range" && expandedArgumentType.kind === "range") {
      return true;
    }
    if (expandedParameterType.kind === "tuple" && expandedArgumentType.kind === "tuple") {
      return true;
    }
    if (expandedParameterType.kind === "function" && expandedArgumentType.kind === "function") {
      return true;
    }
    if (expandedParameterType.kind === "object" && expandedArgumentType.kind === "object") {
      return true;
    }
    if (expandedParameterType.kind === "named" && expandedArgumentType.kind === "object") {
      return this.resolveNamedTypeMembers(expandedParameterType) !== null;
    }
    if (expandedParameterType.kind === "object" && expandedArgumentType.kind === "named") {
      return this.resolveNamedTypeMembers(expandedArgumentType) !== null;
    }
    return false;
  }

  private typeContainsUnresolvedNamedReference(
    type: AnalysisType,
    scope: Scope,
    localTypeParameters: ReadonlySet<string>
  ): boolean {
    if (isUnknownType(type)) {
      return false;
    }
    if (type.kind === "named") {
      if (
        (type.typeArguments?.length ?? 0) === 0 &&
        !localTypeParameters.has(type.name) &&
        !BUILTIN_TYPE_NAMES.has(type.name as BuiltinTypeName) &&
        !this.classStatementsByName.has(type.name) &&
        !this.interfaceStatementsByName.has(type.name) &&
        !this.typeAliasStatementsByName.has(type.name) &&
        !this.enumStatementsByName.has(type.name) &&
        !this.namespaceStatementsByName.has(type.name) &&
        !this.varStatementsByName.has(type.name) &&
        !this.resolve(type.name, scope, undefined)
      ) {
        return true;
      }
      return (type.typeArguments ?? []).some((argument) =>
        this.typeContainsUnresolvedNamedReference(argument, scope, localTypeParameters)
      );
    }
    if (type.kind === "array" || type.kind === "range") {
      return this.typeContainsUnresolvedNamedReference(type.elementType, scope, localTypeParameters);
    }
    if (type.kind === "tuple") {
      return type.elements.some((element) => this.typeContainsUnresolvedNamedReference(element, scope, localTypeParameters));
    }
    if (type.kind === "union" || type.kind === "intersection") {
      return type.types.some((member) => this.typeContainsUnresolvedNamedReference(member, scope, localTypeParameters));
    }
    if (type.kind === "function") {
      const nestedTypeParameters = new Set(localTypeParameters);
      for (const typeParameter of type.typeParameters ?? []) {
        nestedTypeParameters.add(typeParameter);
      }
      return type.parameters.some((parameter) => this.typeContainsUnresolvedNamedReference(parameter.type, scope, nestedTypeParameters)) ||
        this.typeContainsUnresolvedNamedReference(type.returnType, scope, nestedTypeParameters);
    }
    if (type.kind === "object") {
      return Object.values(type.properties).some((property) =>
        this.typeContainsUnresolvedNamedReference(property, scope, localTypeParameters)
      );
    }
    return false;
  }

  private typeContainsTypeParameterReference(
    type: AnalysisType,
    typeParameters: ReadonlySet<string>
  ): boolean {
    if (type.kind === "named") {
      if (typeParameters.has(type.name)) {
        return true;
      }
      return (type.typeArguments ?? []).some((argument) =>
        this.typeContainsTypeParameterReference(argument, typeParameters)
      );
    }
    if (type.kind === "array" || type.kind === "range") {
      return this.typeContainsTypeParameterReference(type.elementType, typeParameters);
    }
    if (type.kind === "tuple") {
      return type.elements.some((element) => this.typeContainsTypeParameterReference(element, typeParameters));
    }
    if (type.kind === "union" || type.kind === "intersection") {
      return type.types.some((member) => this.typeContainsTypeParameterReference(member, typeParameters));
    }
    if (type.kind === "function") {
      return type.parameters.some((parameter) => this.typeContainsTypeParameterReference(parameter.type, typeParameters)) ||
        this.typeContainsTypeParameterReference(type.returnType, typeParameters);
    }
    if (type.kind === "object") {
      return Object.values(type.properties).some((property) =>
        this.typeContainsTypeParameterReference(property, typeParameters)
      );
    }
    return false;
  }

  private mergeInferredTypeParameterSubstitution(
    typeParameter: string,
    inferredType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): void {
    const previousType = substitutions.get(typeParameter);
    if (!previousType) {
      substitutions.set(typeParameter, inferredType);
      return;
    }

    if (previousType.kind === "named" && previousType.name === typeParameter) {
      substitutions.set(typeParameter, inferredType);
      return;
    }

    if (isUnknownType(previousType) && !isUnknownType(inferredType)) {
      substitutions.set(typeParameter, inferredType);
      return;
    }

    if (!isUnknownType(previousType) && isUnknownType(inferredType)) {
      return;
    }

    if (this.isTypeAssignable(inferredType, previousType)) {
      return;
    }

    if (this.isTypeAssignable(previousType, inferredType)) {
      substitutions.set(typeParameter, inferredType);
    }
  }

  private validateFunctionTypeArgumentConstraints(
    genericType: AnalysisType & { kind: "function" },
    instantiatedType: AnalysisType & { kind: "function" },
    node: Node
  ): void {
    const typeParameters = genericType.typeParameters ?? [];
    const constraints = genericType.typeParameterConstraints;
    if (!constraints || typeParameters.length === 0) {
      return;
    }
    const substitutions = this.inferredFunctionTypeConstraintSubstitutions(genericType, instantiatedType);
    if (!substitutions) {
      return;
    }
    this.withTypeParameters(typeParameters, () => {
      for (const typeParameter of typeParameters) {
        const constraint = constraints[typeParameter];
        const typeArgument = substitutions.get(typeParameter);
        if (!constraint || !typeArgument) {
          continue;
        }
        if (typeArgument.kind === "named" && typeParameters.includes(typeArgument.name)) {
          continue;
        }
        this.validateTypeArgumentConstraint(
          typeParameter,
          typeArgument,
          this.substituteTypeParameters(constraint, substitutions),
          node
        );
      }
    }, constraints);
  }

  private inferredFunctionTypeConstraintSubstitutions(
    genericType: AnalysisType & { kind: "function" },
    instantiatedType: AnalysisType & { kind: "function" }
  ): Map<string, AnalysisType> | null {
    const typeParameters = genericType.typeParameters ?? [];
    if (typeParameters.length === 0) {
      return null;
    }
    const substitutions = new Map<string, AnalysisType>();
    for (const typeParameter of typeParameters) {
      substitutions.set(typeParameter, namedType(typeParameter));
    }
    this.inferTypeParameterSubstitutions(
      genericType,
      instantiatedType,
      new Set(typeParameters),
      new Set(),
      substitutions
    );
    return substitutions;
  }

  private satisfiesFunctionTypeArgumentConstraints(
    genericType: AnalysisType & { kind: "function" },
    instantiatedType: AnalysisType & { kind: "function" }
  ): boolean {
    const typeParameters = genericType.typeParameters ?? [];
    const constraints = genericType.typeParameterConstraints;
    if (!constraints || typeParameters.length === 0) {
      return true;
    }
    const substitutions = this.inferredFunctionTypeConstraintSubstitutions(genericType, instantiatedType);
    if (!substitutions) {
      return true;
    }
    let satisfies = true;
    this.withTypeParameters(typeParameters, () => {
      for (const typeParameter of typeParameters) {
        const constraint = constraints[typeParameter];
        const typeArgument = substitutions.get(typeParameter);
        if (!constraint || !typeArgument) {
          continue;
        }
        if (typeArgument.kind === "named" && typeParameters.includes(typeArgument.name)) {
          continue;
        }
        const substitutedConstraint = this.substituteTypeParameters(constraint, substitutions);
        const assignable = this.isTypeAssignable(typeArgument, substitutedConstraint);
        if (!assignable) {
          satisfies = false;
          return;
        }
      }
    }, constraints);
    return satisfies;
  }


  private callableTypeFrom(type: AnalysisType, argumentTypes: AnalysisType[] = []): (AnalysisType & { kind: "function" }) | null {
    if (type.kind === "function") {
      return type;
    }
    if (type.kind === "intersection") {
      for (const member of type.types) {
        const callable = this.callableTypeFrom(member, argumentTypes);
        if (callable) {
          return callable;
        }
      }
      return null;
    }
    if (type.kind === "named") {
      const expanded = this.expandTypeAliases(this.normalizeLooseNamedType(type));
      if (!isSameType(expanded, type)) {
        return this.callableTypeFrom(expanded, argumentTypes);
      }
      const classCallable = this.classCallableTypeForNamedType(type);
      if (classCallable) {
        return classCallable;
      }
      const interfaceCallable = this.interfaceCallableTypeForNamedType(type, argumentTypes);
      if (interfaceCallable) {
        return interfaceCallable;
      }
    }
    if (type.kind !== "union") {
      return null;
    }
    const callableMembers = type.types.filter((member): member is AnalysisType & { kind: "function" } => member.kind === "function");
    return callableMembers.find((member) => this.isCallableOverloadMatch(member, argumentTypes)) ?? callableMembers[0] ?? null;
  }

  private callableCandidatesFrom(type: AnalysisType): Array<AnalysisType & { kind: "function" }> {
    if (type.kind === "function") {
      return [type];
    }
    if (type.kind === "intersection") {
      return type.types.flatMap((member) => this.callableCandidatesFrom(member));
    }
    if (type.kind === "named") {
      const expanded = this.expandTypeAliases(this.normalizeLooseNamedType(type));
      if (!isSameType(expanded, type)) {
        return this.callableCandidatesFrom(expanded);
      }
      const classCallable = this.classCallableTypeForNamedType(type);
      const interfaceOverloads = this.collectInterfaceCallableOverloads(type);
      return classCallable ? [classCallable, ...interfaceOverloads] : interfaceOverloads;
    }
    if (type.kind === "union") {
      return type.types.filter((member): member is AnalysisType & { kind: "function" } => member.kind === "function");
    }
    return [];
  }

  private interfaceCallableTypeForNamedType(
    type: AnalysisType & { kind: "named" },
    argumentTypes: AnalysisType[]
  ): (AnalysisType & { kind: "function" }) | null {
    const overloads = this.collectInterfaceCallableOverloads(type);
    if (overloads.length === 0) {
      return null;
    }
    return overloads.find((member) => this.isCallableOverloadMatch(member, argumentTypes)) ?? overloads[0] ?? null;
  }

  private classCallableTypeForNamedType(type: AnalysisType & { kind: "named" }): (AnalysisType & { kind: "function" }) | null {
    const classStatement = this.classStatementsByName.get(type.name);
    if (!classStatement) {
      return null;
    }
    const typeParameterNames = (classStatement.typeParameters ?? []).map((parameter) => parameter.name.name);
    if (typeParameterNames.length === 0) {
      return this.constructorFunctionType(classStatement, this.bound.rootScope);
    }
    const substitutions = new Map<string, AnalysisType>();
    for (let index = 0; index < typeParameterNames.length; index += 1) {
      const typeParameterName = typeParameterNames[index]!;
      substitutions.set(typeParameterName, type.typeArguments?.[index] ?? namedType(typeParameterName));
    }
    return this.substituteTypeParameters(
      this.constructorFunctionType(classStatement, this.bound.rootScope),
      substitutions
    ) as AnalysisType & { kind: "function" };
  }

  private isCallableOverloadMatch(
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): boolean {
    if (this.isCallableMatch(calleeType, argumentTypes)) {
      return true;
    }
    if ((calleeType.typeParameters?.length ?? 0) === 0) {
      return false;
    }
    const instantiated = this.instantiateFunctionType(calleeType, [], argumentTypes);
    return this.isCallableMatch(instantiated, argumentTypes)
      && this.satisfiesFunctionTypeArgumentConstraints(calleeType, instantiated);
  }

  private selectBestCallableCandidate(
    candidates: Array<AnalysisType & { kind: "function" }>,
    call: CallExpression,
    scope: Scope,
    explicitTypeArguments: AnalysisType[],
    argumentTypes: AnalysisType[],
    preferredArgumentTypes: AnalysisType[],
    expectedType?: AnalysisType
  ): (AnalysisType & { kind: "function" }) | null {
    if (candidates.length <= 1) {
      return candidates[0] ?? null;
    }

    const arityCompatibleCandidates = candidates.filter((candidate) =>
      this.callArgumentCountIsCompatible(call, candidate)
    );
    if (arityCompatibleCandidates.length > 0) {
      candidates = arityCompatibleCandidates;
    }

    let best: { candidate: AnalysisType & { kind: "function" }; score: number } | null = null;
    for (const candidate of candidates) {
      const baseline = this.issues.length;
      const hasNamedArguments = call.arguments.some((argument) => argument.kind === "NamedArgument");
      const baseInferenceArgumentTypes = hasNamedArguments
        ? this.reorderNamedArgumentTypes(call.arguments, preferredArgumentTypes, candidate)
        : preferredArgumentTypes;
      const inferenceArgumentTypes = hasNamedArguments
        ? baseInferenceArgumentTypes
        : this.literalSensitiveInferenceArgumentTypes(
            candidate,
            call.arguments,
            baseInferenceArgumentTypes
          );
      const firstPass = this.instantiateFunctionType(candidate, explicitTypeArguments, inferenceArgumentTypes, expectedType, false);
      const contextualArgumentTypes = hasNamedArguments
        ? inferenceArgumentTypes
        : this.applyCallArgumentContext(call, scope, firstPass, argumentTypes);
      const contextualIssueCount = this.issues.length - baseline;
      this.issues.length = baseline;
      const instantiated = contextualArgumentTypes === argumentTypes
        ? firstPass
        : this.instantiateFunctionType(candidate, explicitTypeArguments, contextualArgumentTypes, expectedType);
      const score =
        contextualIssueCount +
        this.functionTypeConstraintMismatchCount(call.callee, candidate, instantiated) +
        this.callArgumentMismatchCount(
          call,
          candidate,
          instantiated,
          hasNamedArguments ? argumentTypes : contextualArgumentTypes
        );
      if (!best || score < best.score) {
        best = { candidate, score };
        if (score === 0) {
          break;
        }
      }
    }
    return best?.candidate ?? candidates[0] ?? null;
  }

  private callArgumentCountIsCompatible(
    call: CallExpression,
    calleeType: AnalysisType & { kind: "function" }
  ): boolean {
    const providedCount = call.arguments.length;
    const lastParameter = calleeType.parameters[calleeType.parameters.length - 1];
    const restParameter = lastParameter?.rest ? lastParameter : undefined;
    const fixedParameters = restParameter ? calleeType.parameters.slice(0, -1) : calleeType.parameters;
    const requiredCount = fixedParameters.filter((parameter) => !parameter.optional).length;
    if (providedCount < requiredCount) {
      return false;
    }
    if (!restParameter && providedCount > fixedParameters.length) {
      return false;
    }
    return true;
  }

  private functionTypeConstraintMismatchCount(
    node: Node,
    genericType: AnalysisType & { kind: "function" },
    instantiatedType: AnalysisType & { kind: "function" }
  ): number {
    const baseline = this.issues.length;
    this.validateFunctionTypeArgumentConstraints(genericType, instantiatedType, node);
    const count = this.issues.length - baseline;
    this.issues.length = baseline;
    return count;
  }

  private callArgumentMismatchCount(
    call: CallExpression,
    genericType: AnalysisType & { kind: "function" },
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): number {
    const baseline = this.issues.length;
    if (call.arguments.some((argument) => argument.kind === "NamedArgument")) {
      this.validateNamedCallArguments(call, calleeType, argumentTypes);
    } else {
      this.validateCallArguments(call, calleeType, argumentTypes);
    }
    let count = this.issues.length - baseline;
    this.issues.length = baseline;
    if (!this.satisfiesFunctionTypeArgumentConstraints(genericType, calleeType)) {
      count += 1000;
    }
    return count;
  }

  private collectInterfaceCallableOverloads(
    type: AnalysisType & { kind: "named" },
    visited = new Set<string>()
  ): Array<AnalysisType & { kind: "function" }> {
    const cacheKey = typeToString(type);
    if (visited.has(cacheKey)) {
      return [];
    }
    visited.add(cacheKey);

    const interfaceStatement = this.interfaceStatementsByName.get(type.name);
    if (!interfaceStatement) {
      return [];
    }

    const substitutions = this.typeParameterSubstitutions(interfaceStatement.typeParameters ?? [], type);
    const overloads: Array<AnalysisType & { kind: "function" }> = [];

    for (const interfaceMember of interfaceStatement.members) {
      if (interfaceMember.kind !== "InterfaceMethodMember" || interfaceMember.name.name !== "call") {
        continue;
      }

      const methodTypeParameterNames = (interfaceMember.typeParameters ?? []).map((parameter) => parameter.name.name);
      const availableTypeParameterNames = [...substitutions.keys(), ...methodTypeParameterNames];
      let methodType: AnalysisType & { kind: "function" } = functionType([], builtinType("void"));
      this.withTypeParameters(methodTypeParameterNames, () => {
        methodType = functionType(
          interfaceMember.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
            name: bindingNameText(parameter.name),
            type: this.typeFromAnnotationLooseWithTypeParameters(
              parameter.typeAnnotation,
              availableTypeParameterNames,
              interfaceStatement.name.name
            ) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
          })),
          this.typeFromAnnotationLooseWithTypeParameters(
            interfaceMember.returnType,
            availableTypeParameterNames,
            interfaceStatement.name.name
          ) ?? builtinType("void"),
          methodTypeParameterNames,
          this.typeParameterConstraintMapLoose(interfaceMember.typeParameters ?? [], availableTypeParameterNames),
          this.typeParameterDefaultMapLoose(interfaceMember.typeParameters ?? [], availableTypeParameterNames)
        );
      });
      overloads.push(this.substituteTypeParameters(methodType, substitutions) as AnalysisType & { kind: "function" });
    }

    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      const resolvedParentType = this.substituteTypeParameters(
        this.typeFromTypeNameLoose(parentType.name),
        substitutions
      );
      if (resolvedParentType.kind !== "named") {
        continue;
      }
      overloads.push(...this.collectInterfaceCallableOverloads(resolvedParentType, visited));
    }

    return overloads;
  }

  private isCallableMatch(calleeType: AnalysisType & { kind: "function" }, argumentTypes: AnalysisType[]): boolean {
    const lastParameter = calleeType.parameters[calleeType.parameters.length - 1];
    const restParameter = lastParameter?.rest ? lastParameter : undefined;
    const fixedParameters = restParameter ? calleeType.parameters.slice(0, -1) : calleeType.parameters;
    const requiredCount = fixedParameters.filter((parameter) => !parameter.optional).length;
    if (argumentTypes.length < requiredCount || (!restParameter && argumentTypes.length > fixedParameters.length)) {
      return false;
    }
    for (let index = 0; index < argumentTypes.length; index += 1) {
      const parameter = fixedParameters[index] ?? restParameter;
      if (!parameter) {
        return false;
      }
      const expectedType = restParameter && index >= fixedParameters.length
        ? this.restParameterExpectedTypeAt(restParameter.type, index - fixedParameters.length)
        : parameter.type;
      const argumentType = argumentTypes[index]!;
      if (!isUnknownType(expectedType) && !isUnknownType(argumentType) && !this.isCallArgumentAssignable(argumentType, expectedType)) {
        return false;
      }
    }
    return true;
  }

  private isCallArgumentAssignable(argumentType: AnalysisType, expectedType: AnalysisType): boolean {
    if (argumentType.kind !== "function" || expectedType.kind !== "function") {
      return this.isTypeAssignable(argumentType, expectedType);
    }
    if (expectedType.parameters.length === 0 && this.returnValueIsOptional(expectedType.returnType)) {
      return true;
    }

    const argumentRequiredCount = argumentType.parameters.filter((parameter) => !parameter.optional).length;
    if (argumentRequiredCount > expectedType.parameters.length) {
      return false;
    }

    for (let index = 0; index < argumentType.parameters.length; index += 1) {
      const argumentParameter = argumentType.parameters[index];
      const expectedParameter = expectedType.parameters[index];
      if (!argumentParameter || !expectedParameter) {
        return false;
      }
      if (!this.isTypeAssignable(expectedParameter.type, argumentParameter.type)) {
        return false;
      }
      if ((expectedParameter.optional ?? false) === true && (argumentParameter.optional ?? false) === false) {
        return false;
      }
    }

    return this.isTypeAssignable(argumentType.returnType, expectedType.returnType);
  }

  private effectiveArgumentTypeForValidation(
    argumentExpression: Expr | undefined,
    argumentType: AnalysisType,
    expectedType: AnalysisType
  ): AnalysisType {
    if (!argumentExpression) {
      return argumentType;
    }
    if (!this.expectedTypeDependsOnLiteral(expectedType)) {
      return argumentType;
    }
    return this.literalArgumentType(argumentExpression, argumentType);
  }

  private expectedTypeDependsOnLiteral(type: AnalysisType): boolean {
    if (type.kind === "named") {
      const expanded = this.expandTypeAliases(this.normalizeLooseNamedType(type));
      if (!isSameType(expanded, type)) {
        return this.expectedTypeDependsOnLiteral(expanded);
      }
    }
    if (type.kind === "literal") {
      return true;
    }
    if (type.kind === "union") {
      return type.types.some((member) => this.expectedTypeDependsOnLiteral(member));
    }
    if (type.kind === "intersection") {
      return type.types.some((member) => this.expectedTypeDependsOnLiteral(member));
    }
    if (type.kind === "object") {
      return Object.values(type.properties).some((member) => this.expectedTypeDependsOnLiteral(member));
    }
    return false;
  }



  private validateJsxComponentAttributes(
    jsxElement: JsxElement,
    componentType: (AnalysisType & { kind: "function" }) | null,
    scope: Scope
  ): void {
    for (const attr of jsxElement.attributes) {
      if (attr.kind === "JsxSpreadAttribute") {
        this.visitExpression((attr as JsxSpreadAttribute).expression, scope);
      }
    }

    if (!componentType || jsxElement.reference === undefined) {
      this.visitJsxAttributeValues(jsxElement, scope);
      return;
    }

    const propsParameter = componentType.parameters[0];
    if (!propsParameter || propsParameter.rest === true) {
      this.visitJsxAttributeValues(jsxElement, scope);
      return;
    }

    const propsType = propsParameter.type;
    if (isUnknownType(propsType) || (propsType.kind === "builtin" && propsType.name === "any")) {
      this.visitJsxAttributeValues(jsxElement, scope);
      return;
    }

    const expectedProps = this.propertyMapFromJsxPropsType(propsType);
    if (!expectedProps) {
      this.visitJsxAttributeValues(jsxElement, scope);
      return;
    }

    const provided = new Set<string>();
    for (const attr of jsxElement.attributes) {
      if (attr.kind !== "JsxAttribute") {
        continue;
      }
      const attribute = attr as JsxAttribute;
      const expectedType = expectedProps.get(attribute.name);
      if (!expectedType) {
        this.jsxAttributeValueType(attribute, scope);
        this.issues.push({
          message: `No parameter named '${attribute.name}'`,
          node: attribute
        });
        continue;
      }

      const attributeSymbol = this.resolveJsxAttributeSymbol(jsxElement, attribute, expectedType);
      if (attributeSymbol) {
        this.jsxAttributeResolutions.push({ attribute, symbol: attributeSymbol });
      }

      if (provided.has(attribute.name)) {
        this.issues.push({
          message: `Parameter '${attribute.name}' specified more than once`,
          node: attribute
        });
      }
      provided.add(attribute.name);

      const valueNode = attribute.value?.kind === "JsxExpressionContainer"
        ? (attribute.value as JsxExpressionContainer).expression
        : attribute.value ?? attribute;
      const attributeType = this.jsxAttributeValueType(attribute, scope, expectedType);
      if (isUnknownType(expectedType) || isUnknownType(attributeType)) {
        continue;
      }
      if (this.isTypeAssignable(attributeType, expectedType)) {
        continue;
      }
      this.issues.push({
        message: `Argument of type '${typeToString(attributeType)}' is not assignable to parameter '${attribute.name}' of type '${typeToString(expectedType)}'`,
        node: valueNode
      });
      this.reportNestedMismatchContext(attributeType, expectedType, valueNode);
    }

    if (jsxElement.children.length > 0 && expectedProps.has("children")) {
      provided.add("children");
    }

    for (const [propertyName, propertyType] of expectedProps.entries()) {
      if (provided.has(propertyName) || this.isOptionalJsxPropType(propertyType)) {
        continue;
      }
      this.issues.push({
        message: `Missing required argument for parameter '${propertyName}'`,
        node: jsxElement.reference
      });
    }
  }

  private resolveJsxAttributeSymbol(
    jsxElement: JsxElement,
    attribute: JsxAttribute,
    expectedType: AnalysisType
  ): AnalysisSymbol | null {
    if (!jsxElement.reference || jsxElement.reference.kind !== "Identifier") {
      return null;
    }

    const referenceIdentifier = jsxElement.reference as Identifier;
    const referenceResolution = this.identifierResolutions.find((resolution) => resolution.identifier === referenceIdentifier);
    const functionStatement = this.functionStatementsByName.get(referenceIdentifier.name);
    if (!functionStatement || referenceResolution?.symbol.node !== functionStatement.name) {
      return null;
    }

    const propsParameter = functionStatement.parameters.find((parameter) => parameter.thisParameter !== true);
    if (!propsParameter || propsParameter.name.kind !== "ObjectBindingPattern") {
      return null;
    }

    const element = propsParameter.name.elements.find((candidate) => {
      if (candidate.rest === true) {
        return false;
      }
      const propertyName = bindingElementPropertyName(candidate);
      return propertyName === attribute.name;
    });
    if (!element) {
      return null;
    }

    const declarationNode = element.propertyName ?? (element.name.kind === "Identifier" ? element.name : null);
    if (!declarationNode) {
      return null;
    }

    return {
      name: attribute.name,
      kind: "parameter",
      node: declarationNode,
      declaredOffset: declarationNode.firstToken?.range.start.offset ?? -1,
      type: expectedType,
      valueType: typeToString(expectedType)
    };
  }

  private visitJsxAttributeValues(jsxElement: JsxElement, scope: Scope): void {
    for (const attr of jsxElement.attributes) {
      if (attr.kind === "JsxAttribute") {
        this.jsxAttributeValueType(attr as JsxAttribute, scope);
      }
    }
  }

  private jsxAttributeValueType(attribute: JsxAttribute, scope: Scope, expectedType?: AnalysisType): AnalysisType {
    if (!attribute.value) {
      return builtinType("boolean");
    }
    if (attribute.value.kind === "JsxExpressionContainer") {
      return this.visitExpression((attribute.value as JsxExpressionContainer).expression, scope, expectedType);
    }
    return this.visitExpression(attribute.value, scope, expectedType);
  }

  private propertyMapFromJsxPropsType(propsType: AnalysisType): Map<string, AnalysisType> | null {
    if (propsType.kind === "object") {
      return new Map(Object.entries(propsType.properties));
    }
    if (propsType.kind === "named") {
      return this.resolveNamedTypeMembers(propsType);
    }
    if (propsType.kind === "intersection") {
      const merged = new Map<string, AnalysisType>();
      for (const member of propsType.types) {
        const memberMap = this.propertyMapFromJsxPropsType(member);
        if (!memberMap) {
          return null;
        }
        for (const [propertyName, propertyType] of memberMap.entries()) {
          merged.set(propertyName, propertyType);
        }
      }
      return merged;
    }
    return null;
  }

  private isOptionalJsxPropType(type: AnalysisType): boolean {
    return type.kind === "union" && type.types.some((member) => member.kind === "builtin" && member.name === "undefined");
  }

  private validateCallArguments(
    call: CallExpression | NewExpression,
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): void {
    const diagnosticNode = call.callee.kind === "MemberExpression"
      ? (call.callee as MemberExpression).property
      : call.kind === "CallExpression"
        ? call
        : call.callee;
    const args = call.arguments ?? [];
    const lastParameter = calleeType.parameters[calleeType.parameters.length - 1];
    const restParameter = lastParameter?.rest ? lastParameter : undefined;
    const fixedParameters = restParameter ? calleeType.parameters.slice(0, -1) : calleeType.parameters;
    const requiredCount = fixedParameters.filter((parameter) => !parameter.optional).length;
    const providedCount = argumentTypes.length;
    const totalCount = fixedParameters.length;

    if (providedCount < requiredCount) {
      this.issues.push({
        message: `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
        node: diagnosticNode
      });
    } else if (!restParameter && providedCount > totalCount) {
      this.issues.push({
        message: `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
        node: diagnosticNode
      });
      for (let index = totalCount; index < providedCount; index += 1) {
        this.issues.push({
          message: `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
          node: args[index] ?? call
        });
      }
    }

    const comparableCount = restParameter ? providedCount : Math.min(providedCount, totalCount);
    for (let index = 0; index < comparableCount; index += 1) {
      const argumentExpression = args[index];
      const parameter = fixedParameters[index] ?? restParameter;
      if (!parameter) {
        continue;
      }
      const argumentType = argumentTypes[index]!;
      const expectedType = restParameter && index >= fixedParameters.length
        ? this.restParameterExpectedTypeAt(restParameter.type, index - fixedParameters.length)
        : parameter.type;
      const rawComparableArgumentType = argumentExpression?.kind === "SpreadExpression"
        ? spreadArgumentElementType(argumentType)
        : argumentType;
      const comparableArgumentType = this.effectiveArgumentTypeForValidation(
        argumentExpression,
        rawComparableArgumentType,
        expectedType
      );
      if (isUnknownType(expectedType) || isUnknownType(comparableArgumentType)) {
        continue;
      }
      if (this.isCallArgumentAssignable(comparableArgumentType, expectedType)) {
        continue;
      }

      this.issues.push({
        message: `Argument ${index + 1} of type '${typeToString(comparableArgumentType)}' is not assignable to parameter '${parameter.name}' of type '${typeToString(expectedType)}'`,
        node: argumentExpression ?? call
      });
      if (argumentExpression) {
        this.reportNestedMismatchContext(comparableArgumentType, expectedType, argumentExpression);
      }
    }
  }

  /**
   * Reorders the written-order argument types of a call that uses named
   * arguments into the callee's positional parameter order. Positional
   * arguments fill parameters left to right; named arguments target the
   * parameter matching their name. Slots without a provided value keep
   * `UNKNOWN_TYPE`. Used to feed generic inference as if the call were
   * positional.
   */
  private reorderNamedArgumentTypes(
    args: Expr[],
    argumentTypes: AnalysisType[],
    calleeType: AnalysisType & { kind: "function" }
  ): AnalysisType[] {
    const parameterNames = calleeType.parameters.map((parameter) => parameter.name);
    const ordered: AnalysisType[] = parameterNames.map(() => UNKNOWN_TYPE);
    let positionalIndex = 0;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      const argumentType = argumentTypes[index] ?? UNKNOWN_TYPE;
      if (argument.kind === "NamedArgument") {
        const parameterIndex = parameterNames.indexOf((argument as NamedArgument).name.name);
        if (parameterIndex >= 0) {
          ordered[parameterIndex] = argumentType;
        }
        continue;
      }
      if (positionalIndex < ordered.length) {
        ordered[positionalIndex] = argumentType;
      }
      positionalIndex += 1;
    }
    return ordered;
  }

  /**
   * Validates a call whose arguments include named arguments. Each named
   * argument is matched to the parameter sharing its name; positional
   * arguments fill parameters left to right. Reports unknown parameter names,
   * duplicate assignments, missing required parameters and per-argument type
   * mismatches.
   */
  private validateNamedCallArguments(
    call: CallExpression,
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): void {
    const parameters = calleeType.parameters;
    const parameterIndexByName = new Map<string, number>();
    parameters.forEach((parameter, index) => parameterIndexByName.set(parameter.name, index));
    const lastParameter = parameters[parameters.length - 1];
    const restParameter = lastParameter?.rest ? lastParameter : undefined;
    const provided = new Set<number>();
    let positionalIndex = 0;

    for (let index = 0; index < call.arguments.length; index += 1) {
      const argument = call.arguments[index]!;
      const argumentType = argumentTypes[index] ?? UNKNOWN_TYPE;
      let parameterIndex: number;
      let parameter: (typeof parameters)[number] | undefined;

      if (argument.kind === "NamedArgument") {
        const name = (argument as NamedArgument).name.name;
        const resolvedIndex = parameterIndexByName.get(name);
        if (resolvedIndex === undefined) {
          this.issues.push({
            message: `No parameter named '${name}'`,
            node: (argument as NamedArgument).name
          });
          continue;
        }
        parameterIndex = resolvedIndex;
        parameter = parameters[resolvedIndex];
      } else {
        parameterIndex = positionalIndex;
        parameter = parameters[positionalIndex] ?? restParameter;
        positionalIndex += 1;
      }

      if (parameter !== restParameter && provided.has(parameterIndex)) {
        this.issues.push({
          message: `Parameter '${parameter?.name ?? String(parameterIndex)}' specified more than once`,
          node: argument
        });
      }
      provided.add(parameterIndex);

      if (!parameter) {
        continue;
      }
      const valueNode = argument.kind === "NamedArgument" ? (argument as NamedArgument).value : argument;
      const comparableArgumentType = valueNode.kind === "SpreadExpression"
        ? spreadArgumentElementType(argumentType)
        : argumentType;
      const expectedType = parameter.type;
      const effectiveArgumentType = this.effectiveArgumentTypeForValidation(
        valueNode,
        comparableArgumentType,
        expectedType
      );
      if (isUnknownType(expectedType) || isUnknownType(effectiveArgumentType)) {
        continue;
      }
      if (this.isCallArgumentAssignable(effectiveArgumentType, expectedType)) {
        continue;
      }
      this.issues.push({
        message: `Argument of type '${typeToString(effectiveArgumentType)}' is not assignable to parameter '${parameter.name}' of type '${typeToString(expectedType)}'`,
        node: valueNode
      });
      this.reportNestedMismatchContext(effectiveArgumentType, expectedType, valueNode);
    }

    const diagnosticNode = call.callee.kind === "MemberExpression"
      ? (call.callee as MemberExpression).property
      : call;
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]!;
      if (parameter.optional || parameter.rest || provided.has(index)) {
        continue;
      }
      this.issues.push({
        message: `Missing required argument for parameter '${parameter.name}'`,
        node: diagnosticNode
      });
    }
  }

  private classStatementForNewExpression(newExpression: NewExpression | CallExpression, calleeType: AnalysisType): ClassStatement | undefined {
    if (calleeType.kind === "named") {
      const classStatement = this.classStatementsByName.get(calleeType.name);
      if (classStatement) {
        return classStatement;
      }
    }
    if (newExpression.callee.kind !== "Identifier") {
      return undefined;
    }
    return this.classStatementsByName.get((newExpression.callee as Identifier).name);
  }

  private inferConstructedType(
    newExpression: NewExpression | CallExpression,
    classStatement: ClassStatement,
    explicitTypeArguments: AnalysisType[],
    scope: Scope
  ): AnalysisType {
    const typeParameters = classStatement.typeParameters ?? [];
    const typeParameterNames = typeParameters.map((parameter) => parameter.name.name);
    const substitutions = new Map<string, AnalysisType>();
    const explicitTypeParameterNames = new Set<string>();
    for (let index = 0; index < typeParameterNames.length; index += 1) {
      const typeParameterName = typeParameterNames[index]!;
      const explicitTypeArgument = explicitTypeArguments[index];
      if (explicitTypeArgument) {
        substitutions.set(typeParameterName, explicitTypeArgument);
        explicitTypeParameterNames.add(typeParameterName);
      } else {
        substitutions.set(
          typeParameterName,
          this.defaultTypeArgumentForTypeParameter(typeParameters[index], scope)
        );
      }
    }

    let constructorType = this.constructorFunctionType(classStatement, scope);
    if (substitutions.size > 0) {
      constructorType = this.substituteTypeParameters(constructorType, substitutions) as AnalysisType & { kind: "function" };
    }

    let argumentTypes: AnalysisType[] = [];
    this.withTypeParameters(typeParameterNames, () => {
      argumentTypes = this.visitConstructorArgumentsWithContext(newExpression, scope, constructorType);
    });

    const typeParameterSet = new Set(typeParameterNames);
    for (let index = 0; index < constructorType.parameters.length && index < argumentTypes.length; index += 1) {
      this.inferTypeParameterSubstitutions(
        constructorType.parameters[index]!.type,
        argumentTypes[index]!,
        typeParameterSet,
        explicitTypeParameterNames,
        substitutions
      );
    }
    this.inferPromiseConstructorTypeArgument(newExpression, classStatement, substitutions, explicitTypeParameterNames);

    const finalConstructorType = this.substituteTypeParameters(
      this.constructorFunctionType(classStatement, scope),
      substitutions
    ) as AnalysisType & { kind: "function" };
    argumentTypes = this.visitConstructorArgumentsWithContext(newExpression, scope, finalConstructorType);
    this.validateCallArguments(newExpression, finalConstructorType, argumentTypes);

    const typeArguments = typeParameterNames.map((typeParameterName) => substitutions.get(typeParameterName) ?? namedType(typeParameterName));
    return namedType(classStatement.name.name, typeArguments);
  }

  private defaultTypeArgumentForTypeParameter(
    typeParameter: TypeParameter | undefined,
    scope: Scope
  ): AnalysisType {
    if (!typeParameter) {
      return UNKNOWN_TYPE;
    }
    return this.resolveTypeAnnotation(typeParameter.defaultType, scope)
      ?? namedType(typeParameter.name.name);
  }

  private constructorFunctionType(classStatement: ClassStatement, scope: Scope): AnalysisType & { kind: "function" } {
    let result: AnalysisType & { kind: "function" } = functionType([], UNKNOWN_TYPE);
    const typeParameterNames = (classStatement.typeParameters ?? []).map((parameter) => parameter.name.name);
    this.withTypeParameters(typeParameterNames, () => {
      const constructorMember = classStatement.members.find(
        (member): member is ClassMethodMember => member.kind === "ClassMethodMember" && member.name.name === "constructor"
      );
      const parameters = constructorMember?.parameters.map((parameter) => ({
        name: parameter.name,
        typeAnnotation: parameter.typeAnnotation,
        optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
        rest: parameter.rest === true
      })) ?? (classStatement.primaryConstructorParameters ?? []).map((parameter) => ({
        name: parameter.name,
        typeAnnotation: parameter.typeAnnotation,
        optional: parameter.defaultValue !== undefined,
        rest: false
      }));
      result = functionType(
        parameters.map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.resolveTypeAnnotation(parameter.typeAnnotation, scope) ?? UNKNOWN_TYPE,
          optional: parameter.optional,
          rest: parameter.rest
        })),
        namedType(classStatement.name.name, typeParameterNames.map((typeParameterName) => namedType(typeParameterName))),
        typeParameterNames,
        this.typeParameterConstraintMap(classStatement.typeParameters ?? [], scope)
      );
    });
    return result;
  }

  private interfaceConstructorTypeForNewExpression(
    newExpression: NewExpression | CallExpression,
    calleeType: AnalysisType,
    scope: Scope
  ): (AnalysisType & { kind: "function" }) | null {
    const directConstructSignature = this.constructableTypeFrom(calleeType);
    if (directConstructSignature) {
      return directConstructSignature;
    }

    const preferredInterfaceName = calleeType.kind === "named"
      ? calleeType.name
      : newExpression.callee.kind === "Identifier"
        ? (newExpression.callee as Identifier).name
        : null;
    if (!preferredInterfaceName) {
      return null;
    }
    const candidateNames = [preferredInterfaceName];
    if (newExpression.callee.kind === "Identifier") {
      candidateNames.push(`${(newExpression.callee as Identifier).name}Constructor`);
    }
    let constructorMembers: InterfaceMethodMember[] = [];
    let constructorInterfaceName: string | null = null;
    for (const candidateName of candidateNames) {
      const interfaceStatement = this.interfaceStatementsByName.get(candidateName);
      if (!interfaceStatement) {
        continue;
      }
      const candidates = interfaceStatement.members.filter(
        (member): member is InterfaceMethodMember =>
          member.kind === "InterfaceMethodMember" && member.name.name === "constructor"
      );
      if (candidates.length > 0) {
        constructorMembers = candidates;
        constructorInterfaceName = candidateName;
        break;
      }
    }
    if (constructorMembers.length === 0) {
      return null;
    }
    const constructorMember = this.selectBestConstructorOverload(constructorMembers, newExpression, scope);
    const typeParameterNames = (constructorMember.typeParameters ?? []).map((parameter) => parameter.name.name);
    if (constructorInterfaceName === "PromiseConstructor") {
      return functionType(
        [{
          name: "executor",
          type: functionType(
            [
              {
                name: "resolve",
                type: functionType([{ name: "arg1", type: namedType("T") }], builtinType("void"))
              },
              {
                name: "reject",
                type: functionType([{ name: "arg1", type: namedType("Error") }], builtinType("void"))
              }
            ],
            builtinType("void")
          )
        }],
        namedType("Promise", [namedType("T")]),
        ["T"]
      );
    }
    let result: AnalysisType & { kind: "function" } = functionType([], UNKNOWN_TYPE);
    this.withTypeParameters(typeParameterNames, () => {
      result = functionType(
        constructorMember.parameters.map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLooseWithTypeParameters(parameter.typeAnnotation, typeParameterNames) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        this.typeFromAnnotationLooseWithTypeParameters(constructorMember.returnType, typeParameterNames) ?? UNKNOWN_TYPE,
        typeParameterNames,
        this.typeParameterConstraintMapLoose(constructorMember.typeParameters ?? [], typeParameterNames),
        this.typeParameterDefaultMapLoose(constructorMember.typeParameters ?? [], typeParameterNames)
      );
    });
    return result;
  }

  private constructableTypeFrom(type: AnalysisType): (AnalysisType & { kind: "function" }) | null {
    if (type.kind === "function") {
      return type;
    }
    if (type.kind === "named" && type.name.trim().startsWith("{")) {
      const objectLiteralType = this.objectTypeFromAnnotationText(type.name);
      if (objectLiteralType) {
        return this.constructableTypeFrom(objectLiteralType);
      }
    }
    if (type.kind === "object") {
      const constructorType = type.properties["constructor"];
      return constructorType?.kind === "function" ? constructorType : null;
    }
    if (type.kind === "intersection") {
      for (const member of type.types) {
        const constructable = this.constructableTypeFrom(member);
        if (constructable) {
          return constructable;
        }
      }
      return null;
    }
    if (type.kind !== "union") {
      return null;
    }
    const constructableMembers = type.types
      .map((member) => this.constructableTypeFrom(member))
      .filter((member): member is AnalysisType & { kind: "function" } => member !== null);
    return constructableMembers[0] ?? null;
  }

  private selectBestConstructorOverload(
    overloads: InterfaceMethodMember[],
    newExpression: NewExpression | CallExpression,
    scope: Scope
  ): InterfaceMethodMember {
    if (overloads.length === 1) {
      return overloads[0]!;
    }
    const argTypes = (newExpression.arguments ?? []).map((arg) => this.visitExpression(arg, scope));
    for (const overload of overloads) {
      const typeParamNames = (overload.typeParameters ?? []).map((p) => p.name.name);
      const params = overload.parameters.map((p) => ({
        type: this.typeFromAnnotationLooseWithTypeParameters(p.typeAnnotation, typeParamNames) ?? UNKNOWN_TYPE,
        optional: p.optional === true || p.defaultValue !== undefined || p.rest === true,
        rest: p.rest === true
      }));
      const restParam = params[params.length - 1]?.rest ? params[params.length - 1] : undefined;
      const fixedParams = restParam ? params.slice(0, -1) : params;
      const requiredCount = fixedParams.filter((p) => !p.optional).length;
      if (argTypes.length < requiredCount) continue;
      if (!restParam && argTypes.length > fixedParams.length) continue;
      const allMatch = argTypes.every((argType, index) => {
        const param = fixedParams[index] ?? restParam;
        if (!param) return false;
        const paramType = restParam && index >= fixedParams.length
          ? this.restParameterExpectedTypeAt(restParam.type, index - fixedParams.length)
          : param.type;
        return isUnknownType(paramType) || isUnknownType(argType) || this.isTypeAssignable(argType, paramType);
      });
      if (allMatch) return overload;
    }
    return overloads[0]!;
  }

  private visitConstructorArgumentsWithContext(
    newExpression: NewExpression | CallExpression,
    scope: Scope,
    constructorType: AnalysisType & { kind: "function" }
  ): AnalysisType[] {
    const args = newExpression.arguments ?? [];
    return args.map((argument, index) => {
      const expectedParameterType = constructorType.parameters[index]?.type;
      const contextualExpectedType = expectedParameterType
        ? this.contextualTypeForExpressionArgument(argument, expectedParameterType)
        : null;
      return this.visitExpression(argument, scope, contextualExpectedType ?? undefined);
    });
  }

  private inferPromiseConstructorTypeArgument(
    newExpression: NewExpression | CallExpression,
    classStatement: ClassStatement,
    substitutions: Map<string, AnalysisType>,
    explicitTypeParameterNames: Set<string>
  ): void {
    if (classStatement.name.name !== "Promise" || explicitTypeParameterNames.has("T")) {
      return;
    }
    this.inferPromiseConstructorTypeArgumentFromExecutor(newExpression, substitutions, explicitTypeParameterNames);
  }

  private inferPromiseConstructorTypeArgumentFromExecutor(
    newExpression: NewExpression | CallExpression,
    substitutions: Map<string, AnalysisType>,
    explicitTypeParameterNames: Set<string>
  ): void {
    if (explicitTypeParameterNames.has("T")) {
      return;
    }
    const executor = newExpression.arguments?.[0];
    if (!executor || !this.isFunctionLikeExpression(executor)) {
      return;
    }
    const parameters = (executor as ArrowFunctionExpression | FunctionExpression).parameters;
    const resolveParameter = parameters[0];
    if (!resolveParameter) {
      return;
    }
    const resolveName = bindingNameText(resolveParameter.name);
    if (!resolveName) {
      return;
    }
    const resolvedTypes: AnalysisType[] = [];
    this.collectCallArgumentTypes(executor, resolveName, resolvedTypes);
    if (resolvedTypes.length === 0) {
      return;
    }
    substitutions.set("T", combineTypes(resolvedTypes));
  }

  private collectCallArgumentTypes(expression: Expr, calleeName: string, collected: AnalysisType[]): void {
    const visitExpression = (candidate: Expr | undefined): void => {
      if (!candidate) {
        return;
      }
      this.collectCallArgumentTypes(candidate, calleeName, collected);
    };
    const visitStatement = (statement: Statement): void => {
      switch (statement.kind) {
        case "ExprStatement":
          visitExpression((statement as ExprStatement).expression);
          break;
        case "ReturnStatement":
          visitExpression((statement as ReturnStatement).expression);
          break;
        case "BlockStatement":
          visitStatements((statement as BlockStatement).body);
          break;
        case "IfStatement":
          visitExpression((statement as IfStatement).condition);
          visitStatement((statement as IfStatement).thenBranch);
          if ((statement as IfStatement).elseBranch) {
            visitStatement((statement as IfStatement).elseBranch!);
          }
          break;
        default:
          break;
      }
    };
    const visitStatements = (statements: Statement[]): void => {
      for (const statement of statements) {
        visitStatement(statement);
      }
    };

    switch (expression.kind) {
      case "CallExpression": {
        const call = expression as CallExpression;
        if (call.callee.kind === "Identifier" && (call.callee as Identifier).name === calleeName && call.arguments[0]) {
          const argument = call.arguments[0]!;
          collected.push(this.expressionTypes.get(argument) ?? this.visitExpression(argument, this.bound.rootScope));
        }
        visitExpression(call.callee);
        for (const argument of call.arguments) visitExpression(argument);
        return;
      }
      case "ArrowFunctionExpression": {
        const arrow = expression as ArrowFunctionExpression;
        if (arrow.body.kind === "BlockStatement") visitStatements((arrow.body as BlockStatement).body);
        else visitExpression(arrow.body as Expr);
        return;
      }
      case "FunctionExpression":
        visitStatements((expression as FunctionExpression).body.body);
        return;
      case "BinaryExpression":
        visitExpression((expression as BinaryExpression).left);
        visitExpression((expression as BinaryExpression).right);
        return;
      case "AssignmentExpression":
        visitExpression((expression as AssignmentExpression).left);
        visitExpression((expression as AssignmentExpression).right);
        return;
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        visitExpression((expression as MemberExpression).property);
        return;
      default:
        return;
    }
  }

  private restParameterExpectedTypeAt(restParameterType: AnalysisType, restIndex: number): AnalysisType {
    if (restParameterType.kind === "tuple") {
      return restParameterType.elements[restIndex] ?? UNKNOWN_TYPE;
    }
    if (restParameterType.kind === "array") {
      return restParameterType.elementType;
    }
    if (restParameterType.kind === "named" && restParameterType.name === "Array" && restParameterType.typeArguments?.[0]) {
      return restParameterType.typeArguments[0];
    }
    if (restParameterType.kind === "named") {
      const constraint = this.activeTypeParameterConstraint(restParameterType.name);
      if (constraint) {
        return this.restParameterExpectedTypeAt(constraint, restIndex);
      }
    }
    return restParameterType;
  }

  private reportReturnTypeMismatch(
    sourceType: AnalysisType,
    targetType: AnalysisType,
    node: Node
  ): void {
    this.issues.push({
      message: `Type '${typeToString(sourceType)}' is not assignable to return type '${typeToString(targetType)}'`,
      node,
      code: ANALYSIS_ISSUE_CODES.RETURN_TYPE_MISMATCH
    });
  }

  private returnValueIsOptional(returnType: AnalysisType): boolean {
    return this.isTypeAssignable(builtinType("undefined"), returnType) ||
      this.isTypeAssignable(builtinType("void"), returnType);
  }

  private validateAsyncReturnTypeAnnotation(_returnType: AnalysisType | undefined, _node: Node): void {
    // Non-Promise return type annotations on async functions are allowed; they are automatically
    // wrapped in Promise<T> by finalizeFunctionReturnType.
  }

  private static readonly ASYNC_GENERATOR_TYPE_NAMES = new Set(["AsyncGenerator", "AsyncIterator", "AsyncIteratorObject"]);
  private static readonly SYNC_GENERATOR_TYPE_NAMES = new Set(["Generator", "Iterator", "IteratorObject", "IterableIterator"]);

  private finalizeFunctionReturnType(
    declaredOrExpectedReturnType: AnalysisType | undefined,
    body: BlockStatement,
    inAsync: boolean,
    inGenerator: boolean = false
  ): AnalysisType {
    if (inGenerator) {
      const wrapperName = inAsync ? "AsyncGenerator" : "Generator";
      const generatorTypeNames = inAsync ? TypeChecker.ASYNC_GENERATOR_TYPE_NAMES : TypeChecker.SYNC_GENERATOR_TYPE_NAMES;
      if (declaredOrExpectedReturnType && !isUnknownType(declaredOrExpectedReturnType)) {
        if (declaredOrExpectedReturnType.kind === "named" && generatorTypeNames.has(declaredOrExpectedReturnType.name)) {
          return declaredOrExpectedReturnType;
        }
        return namedType(wrapperName, [declaredOrExpectedReturnType]);
      }
      const yieldType = this.inferYieldTypeFromBlock(body);
      return namedType(wrapperName, [yieldType]);
    }
    if (declaredOrExpectedReturnType && !isUnknownType(declaredOrExpectedReturnType)) {
      if (inAsync && !this.getAsyncReturnValueType(declaredOrExpectedReturnType)) {
        return namedType("Promise", [declaredOrExpectedReturnType]);
      }
      return declaredOrExpectedReturnType;
    }
    const inferredReturnType = this.inferReturnTypeFromBlock(body);
    return inAsync ? namedType("Promise", [inferredReturnType]) : inferredReturnType;
  }

  private inferYieldTypeFromBlock(body: BlockStatement): AnalysisType {
    const yieldTypes = this.collectYieldTypesFromStatements(body.body);
    if (yieldTypes.length === 0) return UNKNOWN_TYPE;
    return combineTypes(yieldTypes);
  }

  private collectYieldTypesFromStatements(statements: Statement[]): AnalysisType[] {
    const collected: AnalysisType[] = [];
    for (const statement of statements) {
      this.collectYieldTypesFromStatement(statement, collected);
    }
    return collected;
  }

  private collectYieldTypesFromStatement(statement: Statement, collected: AnalysisType[]): void {
    if (statement.kind === "ExprStatement") {
      this.collectYieldTypesFromExpression((statement as ExprStatement).expression, collected);
    } else if (statement.kind === "BlockStatement") {
      for (const t of this.collectYieldTypesFromStatements((statement as BlockStatement).body)) collected.push(t);
    } else if (statement.kind === "IfStatement") {
      const ifStmt = statement as IfStatement;
      this.collectYieldTypesFromStatement(ifStmt.thenBranch, collected);
      if (ifStmt.elseBranch) this.collectYieldTypesFromStatement(ifStmt.elseBranch, collected);
    } else if (statement.kind === "ForStatement") {
      this.collectYieldTypesFromStatement((statement as ForStatement).body, collected);
    } else if (statement.kind === "WhileStatement") {
      this.collectYieldTypesFromStatement((statement as WhileStatement).body, collected);
    } else if (statement.kind === "DoWhileStatement") {
      this.collectYieldTypesFromStatement((statement as DoWhileStatement).body, collected);
    }
  }

  private collectYieldTypesFromExpression(expr: Expr, collected: AnalysisType[]): void {
    switch (expr.kind) {
      case "UnaryExpression": {
        const unary = expr as UnaryExpression;
        if (unary.operator === "yield" || unary.operator === "yield*") {
          const yieldedType = this.expressionTypes.get(unary.argument);
          if (yieldedType && !isUnknownType(yieldedType)) {
            collected.push(yieldedType);
          }
        }
        this.collectYieldTypesFromExpression(unary.argument, collected);
        return;
      }
      case "BinaryExpression":
        this.collectYieldTypesFromExpression((expr as BinaryExpression).left, collected);
        this.collectYieldTypesFromExpression((expr as BinaryExpression).right, collected);
        return;
      case "AssignmentExpression":
        this.collectYieldTypesFromExpression((expr as AssignmentExpression).left, collected);
        this.collectYieldTypesFromExpression((expr as AssignmentExpression).right, collected);
        return;
      case "MemberExpression":
        this.collectYieldTypesFromExpression((expr as MemberExpression).object, collected);
        this.collectYieldTypesFromExpression((expr as MemberExpression).property, collected);
        return;
      case "CallExpression":
        this.collectYieldTypesFromExpression((expr as CallExpression).callee, collected);
        for (const argument of (expr as CallExpression).arguments) {
          this.collectYieldTypesFromExpression(argument, collected);
        }
        return;
      case "ConditionalExpression":
        this.collectYieldTypesFromExpression((expr as ConditionalExpression).test, collected);
        this.collectYieldTypesFromExpression((expr as ConditionalExpression).consequent, collected);
        this.collectYieldTypesFromExpression((expr as ConditionalExpression).alternate, collected);
        return;
      case "ArrayLiteral":
        for (const element of (expr as ArrayLiteral).elements) {
          if (element.kind !== "ArrayHole") {
            this.collectYieldTypesFromExpression(element, collected);
          }
        }
        return;
      case "ObjectLiteral":
        for (const property of (expr as ObjectLiteral).properties) {
          if (property.kind === "ObjectSpreadProperty") {
            this.collectYieldTypesFromExpression((property as ObjectSpreadProperty).argument, collected);
            continue;
          }
          const objectProperty = property as ObjectProperty;
          this.collectYieldTypesFromExpression(objectProperty.key, collected);
          this.collectYieldTypesFromExpression(objectProperty.value, collected);
        }
        return;
      case "SpreadExpression":
        this.collectYieldTypesFromExpression((expr as SpreadExpression).argument, collected);
        return;
      case "NamedArgument":
        this.collectYieldTypesFromExpression((expr as NamedArgument).value, collected);
        return;
      case "NonNullExpression":
        this.collectYieldTypesFromExpression((expr as NonNullExpression).expression, collected);
        return;
      case "AsExpression":
        this.collectYieldTypesFromExpression((expr as AsExpression).expression, collected);
        return;
      case "SatisfiesExpression":
        this.collectYieldTypesFromExpression((expr as SatisfiesExpression).expression, collected);
        return;
      case "ArrowFunctionExpression": {
        const arrow = expr as ArrowFunctionExpression;
        if (arrow.body.kind === "BlockStatement") {
          for (const statement of (arrow.body as BlockStatement).body) {
            this.collectYieldTypesFromStatement(statement, collected);
          }
        } else {
          this.collectYieldTypesFromExpression(arrow.body as Expr, collected);
        }
        return;
      }
      case "FunctionExpression":
        for (const statement of (expr as FunctionExpression).body.body) {
          this.collectYieldTypesFromStatement(statement, collected);
        }
        return;
      case "JsxExpressionContainer":
        this.collectYieldTypesFromExpression((expr as JsxExpressionContainer).expression, collected);
        return;
      case "JsxElement":
        for (const child of (expr as JsxElement).children) {
          if (child.kind === "JsxExpressionContainer" || child.kind === "JsxElement" || child.kind === "JsxFragment") {
            this.collectYieldTypesFromExpression(child as Expr, collected);
          }
        }
        return;
      case "JsxFragment":
        for (const child of (expr as JsxFragment).children) {
          if (child.kind === "JsxExpressionContainer" || child.kind === "JsxElement" || child.kind === "JsxFragment") {
            this.collectYieldTypesFromExpression(child as Expr, collected);
          }
        }
        return;
      default:
        return;
    }
  }

  private inferReturnTypeFromBlock(body: BlockStatement): AnalysisType {
    const returnExpressionTypes = this.collectReturnExpressionTypes(body.body);
    if (returnExpressionTypes.length === 0) {
      return builtinType("void");
    }
    return combineTypes(returnExpressionTypes);
  }

  private collectReturnExpressionTypes(statements: Statement[]): AnalysisType[] {
    const collected: AnalysisType[] = [];
    for (const statement of statements) {
      this.collectReturnExpressionTypesFromStatement(statement, collected);
    }
    return collected;
  }


  private returnExpressionType(expression: Expr): AnalysisType {
    if (expression.kind === "ArrayLiteral") {
      return this.tupleTypeFromArrayLiteral(expression as ArrayLiteral);
    }
    return this.expressionTypes.get(expression) ?? UNKNOWN_TYPE;
  }

  private tupleTypeFromArrayLiteral(arrayLiteral: ArrayLiteral): AnalysisType {
    return tupleType(arrayLiteral.elements.map((element) => {
      if (element.kind === "ArrayHole") {
        return builtinType("undefined");
      }
      const elementType = this.expressionTypes.get(element) ?? UNKNOWN_TYPE;
      if (element.kind === "SpreadExpression") {
        const spreadElementType = spreadArgumentElementType(elementType);
        return spreadElementType;
      }
      return elementType;
    }));
  }

  private collectReturnExpressionTypesFromStatement(statement: Statement, collected: AnalysisType[]): void {
    switch (statement.kind) {
      case "ReturnStatement": {
        const expression = (statement as ReturnStatement).expression;
        if (expression) {
          collected.push(this.returnExpressionType(expression));
        } else {
          collected.push(builtinType("undefined"));
        }
        return;
      }
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          this.collectReturnExpressionTypesFromStatement(child, collected);
        }
        return;
      case "IfStatement": {
        const ifStatement = statement as IfStatement;
        this.collectReturnExpressionTypesFromStatement(ifStatement.thenBranch, collected);
        if (ifStatement.elseBranch) {
          this.collectReturnExpressionTypesFromStatement(ifStatement.elseBranch, collected);
        }
        return;
      }
      case "ForStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "WithStatement":
      case "LabeledStatement":
        this.collectReturnExpressionTypesFromStatement(
          (statement as ForStatement | WhileStatement | DoWhileStatement | WithStatement | LabeledStatement).body,
          collected
        );
        return;
      case "SwitchStatement":
        for (const switchCase of (statement as SwitchStatement).cases) {
          for (const consequent of switchCase.consequent) {
            this.collectReturnExpressionTypesFromStatement(consequent, collected);
          }
        }
        return;
      case "TryStatement": {
        const tryStatement = statement as TryStatement;
        this.collectReturnExpressionTypesFromStatement(tryStatement.tryBlock, collected);
        if (tryStatement.catchClause) {
          this.collectReturnExpressionTypesFromStatement(tryStatement.catchClause.body, collected);
        }
        if (tryStatement.finallyBlock) {
          this.collectReturnExpressionTypesFromStatement(tryStatement.finallyBlock, collected);
        }
        return;
      }
      case "DeferStatement":
        return;
      default:
        return;
    }
  }

  private getAsyncReturnValueType(returnType: AnalysisType): AnalysisType | null {
    if (returnType.kind === "union") {
      const asyncMemberTypes: AnalysisType[] = [];
      let sawPromiseLikeMember = false;
      for (const member of returnType.types) {
        const unwrapped = unwrapPromiseType(member);
        if (unwrapped !== null) {
          asyncMemberTypes.push(unwrapped);
          sawPromiseLikeMember = true;
          continue;
        }
        asyncMemberTypes.push(member);
      }
      return sawPromiseLikeMember
        ? combineTypes(asyncMemberTypes)
        : null;
    }
    return unwrapPromiseType(returnType);
  }

  private returnExpressionIsAssignable(
    actualReturnType: AnalysisType,
    expectedReturnType: AnalysisType,
    asyncReturnValueType: AnalysisType | null,
    inAsync: boolean = false
  ): boolean {
    if (asyncReturnValueType) {
      return this.isTypeAssignable(actualReturnType, asyncReturnValueType) ||
        this.isTypeAssignable(actualReturnType, expectedReturnType);
    }
    if (inAsync) {
      const unwrappedActual = unwrapPromiseType(actualReturnType);
      if (unwrappedActual !== null) {
        return this.isTypeAssignable(unwrappedActual, expectedReturnType);
      }
    }
    return this.isTypeAssignable(actualReturnType, expectedReturnType);
  }

  private asyncReturnValueIsOptional(
    expectedReturnType: AnalysisType,
    asyncReturnValueType: AnalysisType | null
  ): boolean {
    return asyncReturnValueType
      ? this.returnValueIsOptional(asyncReturnValueType)
      : this.returnValueIsOptional(expectedReturnType);
  }

  private reportMissingReturnPath(body: BlockStatement, returnType: AnalysisType, node: Node, inAsync: boolean = false, inGenerator: boolean = false): void {
    if (inGenerator) return; // generators don't need explicit returns
    const asyncReturnValueType = inAsync ? this.getAsyncReturnValueType(returnType) : null;
    if (
      isUnknownType(returnType) ||
      (inAsync
        ? this.asyncReturnValueIsOptional(returnType, asyncReturnValueType)
        : this.returnValueIsOptional(returnType)) ||
      statementListAlwaysExits(body.body)
    ) {
      return;
    }
    this.issues.push({
      message: "Not all code paths return a value",
      node,
      code: ANALYSIS_ISSUE_CODES.NOT_ALL_CODE_PATHS_RETURN
    });
  }

  private reportTypeMismatch(
    sourceType: AnalysisType,
    targetType: AnalysisType,
    node: Node,
    expressionForContext?: Expr
  ): void {
    this.issues.push({
      message: `Type '${typeToString(sourceType)}' is not assignable to type '${typeToString(targetType)}'`,
      node
    });
    if (!expressionForContext) {
      return;
    }
    this.reportNestedMismatchContext(sourceType, targetType, expressionForContext);
  }

  private reportNestedMismatchContext(
    sourceType: AnalysisType,
    targetType: AnalysisType,
    expression: Expr
  ): void {
    const snippet = expressionSnippet(expression);
    if (!snippet) {
      return;
    }
    this.issues.push({
      message: `Nested type mismatch: expression '${snippet}' is '${typeToString(sourceType)}' but expected '${typeToString(targetType)}'`,
      node: expression
    });
  }

  private resolveTypeAnnotation(
    typeAnnotation: (Node & { kind: "Identifier"; name: string }) | undefined,
    scope: Scope
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }

    return this.resolveTypeName(typeAnnotation, scope);
  }

  private resolveTypeName(
    typeNameIdentifier: Node & { kind: "Identifier"; name: string },
    scope: Scope
  ): AnalysisType {
    return this.resolveTypeNameText(typeNameIdentifier.name, typeNameIdentifier, scope, true);
  }

  private resolveTypeNameText(
    typeName: string,
    node: Node,
    scope: Scope,
    captureResolution: boolean
  ): AnalysisType {
    const optionalSuffix = splitOptionalTypeSuffix(typeName);
    if (optionalSuffix.optional) {
      return unionType([
        this.resolveTypeNameText(optionalSuffix.typeName, node, scope, captureResolution),
        builtinType("undefined")
      ]);
    }

    const normalizedTypeName = stripEnclosingTypeParens(typeName);
    if (normalizedTypeName === "this") {
      const thisType = this.resolveContextualThisType(scope);
      if (thisType) {
        return thisType;
      }
    }
    if (this.isDeferredAdvancedTypeName(normalizedTypeName)) {
      return UNKNOWN_TYPE;
    }
    const readonlyContainer = parseReadonlyContainerTypeText(normalizedTypeName);
    if (readonlyContainer?.kind === "tuple") {
      return tupleType(
        (readonlyContainer.tupleElementTypeTexts ?? []).map((part) =>
          this.resolveTypeNameText(part, node, scope, false)
        ),
        true
      );
    }
    if (readonlyContainer?.kind === "array" && readonlyContainer.elementTypeText) {
      return arrayType(
        this.resolveTypeNameText(readonlyContainer.elementTypeText, node, scope, false),
        true
      );
    }
    const functionAnnotation = this.resolveFunctionTypeAnnotation(normalizedTypeName, node, scope);
    if (functionAnnotation) {
      return functionAnnotation;
    }
    const unionParts = splitTopLevelTypeText(normalizedTypeName, "|");
    if (unionParts.length > 1) {
      return unionType(unionParts.map((part) =>
        this.resolveTypeNameText(part, node, scope, false)
      ));
    }

    const intersectionParts = splitTopLevelTypeText(normalizedTypeName, "&");
    if (intersectionParts.length > 1) {
      return intersectionType(intersectionParts.map((part) =>
        this.resolveTypeNameText(part, node, scope, false)
      ));
    }

    const tupleTypeMatch = /^\[(.*)\]$/.exec(normalizedTypeName);
    if (tupleTypeMatch) {
      const tupleBody = tupleTypeMatch[1] ?? "";
      const elements = tupleBody.trim().length === 0
        ? []
        : splitTopLevelTypeText(tupleBody, ",").map((part) =>
            this.resolveTypeNameText(tupleElementTypeText(part), node, scope, false)
          );
      return tupleType(elements);
    }

    const arraySuffix = splitArraySuffixTypeName(normalizedTypeName);
    if (arraySuffix) {
      let elementType = this.resolveTypeNameText(arraySuffix.elementTypeName, node, scope, false);
      for (let i = 0; i < arraySuffix.arrayDepth; i += 1) {
        elementType = arrayType(elementType);
      }
      return elementType;
    }

    const keyofType = this.resolveKeyofTypeName(normalizedTypeName, node, scope);
    if (keyofType) {
      return keyofType;
    }

    const typeofType = this.resolveTypeQueryName(normalizedTypeName, node, scope);
    if (typeofType) {
      return typeofType;
    }

    const indexedAccessType = this.resolveIndexedAccessTypeName(normalizedTypeName, node, scope);
    if (indexedAccessType) {
      return indexedAccessType;
    }

    const literal = resolveLiteralTypeName(normalizedTypeName);
    if (literal) {
      return literal;
    }
    if (normalizedTypeName === "unique symbol") {
      return builtinType("symbol");
    }
    if (normalizedTypeName.startsWith("asserts ")) {
      return builtinType("void");
    }
    const templateLiteralType = this.templateLiteralTypeFromText(normalizedTypeName);
    if (templateLiteralType) {
      return templateLiteralType;
    }

    const objectAnnotation = this.resolveObjectTypeAnnotation(normalizedTypeName, node, scope);
    if (objectAnnotation) {
      return objectAnnotation;
    }
    if (looksLikeFunctionTypeAnnotation(normalizedTypeName)) {
      return UNKNOWN_TYPE;
    }

    const parsed = parseTypeNameShape(normalizedTypeName);
    let resolvedBase: AnalysisType;

    const resolvedTypeArguments = parsed.typeArguments.map((typeArgument) =>
      this.resolveTypeNameText(typeArgument, node, scope, false)
    );
    const specialResolved = this.resolveSpecialNamedType(parsed.baseName, resolvedTypeArguments);

    if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolvedBase = builtinType(
        parsed.baseName as BuiltinTypeName
      );
    } else if (specialResolved) {
      resolvedBase = specialResolved;
    } else if (this.isActiveTypeParameter(parsed.baseName)) {
      resolvedBase = namedType(parsed.baseName);
    } else {
      const qualifiedImportedType = this.resolveQualifiedTypeName(
        parsed.baseName,
        resolvedTypeArguments,
        node,
        scope
      );
      if (qualifiedImportedType) {
        let resolved: AnalysisType = qualifiedImportedType;
        for (let i = 0; i < parsed.arrayDepth; i += 1) {
          resolved = arrayType(resolved);
        }
        return resolved;
      }

      const symbol = this.resolve(parsed.baseName, scope, undefined);
      const typeAlias = this.typeAliasStatementsByName.get(parsed.baseName);
      const hasKnownNamedType = this.knownNamedTypeExists(parsed.baseName)
        && this.isNameVisibleFromExternalDeclarations(parsed.baseName, node);
      if ((symbol && (symbol.kind === "class" || symbol.kind === "variable")) || hasKnownNamedType) {
        if (captureResolution && node.kind === "Identifier") {
          if (symbol) {
            this.identifierResolutions.push({
              identifier: node as Node & { kind: "Identifier"; name: string },
              symbol
            });
          }
        }
        this.validateNamedTypeArgumentConstraints(parsed.baseName, resolvedTypeArguments, node, scope);
        if (typeAlias) {
          resolvedBase = this.resolveTypeAliasTarget(typeAlias, resolvedTypeArguments, scope);
        } else {
          resolvedBase = namedType(parsed.baseName, resolvedTypeArguments);
        }
      } else {
        const unknownTypeRange = this.rangeWithinNodeText(node, parsed.baseName);
        this.issues.push({
          message: `Unknown type '${normalizedTypeName}'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter`,
          node,
          ...(unknownTypeRange ? { range: unknownTypeRange } : {})
        });
        return UNKNOWN_TYPE;
      }
    }

    let resolved: AnalysisType = resolvedBase;
    for (let i = 0; i < parsed.arrayDepth; i += 1) {
      resolved = arrayType(resolved);
    }
    return resolved;
  }

  private rangeWithinNodeText(
    node: Node,
    text: string
  ): { start: { line: number; character: number }; end: { line: number; character: number } } | undefined {
    if (node.kind !== "Identifier" || !node.firstToken) {
      return undefined;
    }

    const sourceText = (node as Identifier).name;
    const matchIndex = sourceText.indexOf(text);
    if (matchIndex < 0) {
      return undefined;
    }

    const start = {
      line: node.firstToken.range.start.line,
      character: node.firstToken.range.start.column
    };

    const advancePosition = (
      position: { line: number; character: number },
      value: string
    ): { line: number; character: number } => {
      let line = position.line;
      let character = position.character;
      for (const ch of value) {
        if (ch === "\n") {
          line += 1;
          character = 0;
        } else {
          character += 1;
        }
      }
      return { line, character };
    };

    const rangeStart = advancePosition(start, sourceText.slice(0, matchIndex));
    const rangeEnd = advancePosition(rangeStart, text);
    return { start: rangeStart, end: rangeEnd };
  }

  private resolveContextualThisType(scope: Scope): AnalysisType | null {
    const thisSymbol = this.resolve("this", scope, undefined);
    if (thisSymbol?.type) {
      return thisSymbol.type;
    }

    for (let current: Scope | undefined = scope; current; current = current.parent) {
      if (current.node.kind === "ClassStatement") {
        return namedType((current.node as ClassStatement).name.name);
      }
      if (current.node.kind === "InterfaceStatement") {
        return namedType((current.node as InterfaceStatement).name.name);
      }
    }

    return null;
  }


  private resolveKeyofTypeName(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    if (!typeName.startsWith("keyof ")) {
      return null;
    }
    const targetType = this.resolveTypeNameText(typeName.slice("keyof ".length).trim(), node, scope, false);
    return this.keyofType(targetType);
  }

  private resolveTypeQueryName(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    if (!typeName.startsWith("typeof ")) {
      return null;
    }

    const path = typeName.slice("typeof ".length).trim().split(".").filter((part) => part.length > 0);
    const baseName = path.shift();
    if (!baseName) {
      return UNKNOWN_TYPE;
    }

    const symbol = this.resolve(baseName, scope, undefined);
    if (!symbol) {
      this.issues.push({
        message: `Undefined variable '${baseName}'`,
        node
      });
      return UNKNOWN_TYPE;
    }

    let currentType = symbol.type ?? UNKNOWN_TYPE;
    for (const memberName of path) {
      currentType = this.memberTypeFromObjectType(currentType, memberName) ?? UNKNOWN_TYPE;
      if (isUnknownType(currentType)) {
        this.issues.push({
          message: `Type '${typeToString(symbol.type ?? UNKNOWN_TYPE)}' has no member '${memberName}'`,
          node
        });
        return UNKNOWN_TYPE;
      }
    }
    return currentType;
  }

  private resolveIndexedAccessTypeName(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    const indexedAccess = splitIndexedAccessTypeName(typeName);
    if (!indexedAccess) {
      return null;
    }

    const objectType = this.resolveTypeNameText(indexedAccess.objectTypeName, node, scope, false);
    const indexType = this.resolveTypeNameText(indexedAccess.indexTypeName, node, scope, false);
    return this.indexedAccessType(objectType, indexType, node);
  }

  private typeFromComputedTypeNameLoose(typeName: string): AnalysisType | null {
    const normalizedTypeName = stripEnclosingTypeParens(typeName);
    if (this.isDeferredAdvancedTypeName(normalizedTypeName)) {
      return UNKNOWN_TYPE;
    }

    if (normalizedTypeName === "unique symbol") {
      return builtinType("symbol");
    }
    if (normalizedTypeName.startsWith("asserts ")) {
      return builtinType("void");
    }

    const readonlyContainer = parseReadonlyContainerTypeText(normalizedTypeName);
    if (readonlyContainer?.kind === "tuple") {
      return tupleType(
        (readonlyContainer.tupleElementTypeTexts ?? []).map((part) => this.typeFromTypeNameLoose(part)),
        true
      );
    }
    if (readonlyContainer?.kind === "array" && readonlyContainer.elementTypeText) {
      return arrayType(this.typeFromTypeNameLoose(readonlyContainer.elementTypeText), true);
    }

    const unionParts = splitTopLevelTypeText(normalizedTypeName, "|");
    if (unionParts.length > 1) {
      return unionType(unionParts.map((part) => this.typeFromTypeNameLoose(part)));
    }

    const intersectionParts = splitTopLevelTypeText(normalizedTypeName, "&");
    if (intersectionParts.length > 1) {
      return intersectionType(intersectionParts.map((part) => this.typeFromTypeNameLoose(part)));
    }

    const tupleTypeMatch = /^\[(.*)\]$/.exec(normalizedTypeName);
    if (tupleTypeMatch) {
      const tupleBody = tupleTypeMatch[1] ?? "";
      const elements = tupleBody.trim().length === 0
        ? []
        : splitTopLevelTypeText(tupleBody, ",").map((part) => this.typeFromTypeNameLoose(tupleElementTypeText(part)));
      return tupleType(elements);
    }

    const arraySuffix = splitArraySuffixTypeName(normalizedTypeName);
    if (arraySuffix) {
      let elementType = this.typeFromTypeNameLoose(arraySuffix.elementTypeName);
      for (let i = 0; i < arraySuffix.arrayDepth; i += 1) {
        elementType = arrayType(elementType);
      }
      return elementType;
    }

    const literal = resolveLiteralTypeName(normalizedTypeName);
    if (literal) {
      return literal;
    }
    const templateLiteralType = this.templateLiteralTypeFromText(normalizedTypeName);
    if (templateLiteralType) {
      return templateLiteralType;
    }

    if (normalizedTypeName.startsWith("keyof ")) {
      return this.keyofType(this.typeFromTypeNameLoose(normalizedTypeName.slice("keyof ".length).trim()));
    }

    if (normalizedTypeName.startsWith("typeof ")) {
      return UNKNOWN_TYPE;
    }

    const indexedAccess = splitIndexedAccessTypeName(normalizedTypeName);
    if (indexedAccess) {
      return this.indexedAccessType(
        this.typeFromTypeNameLoose(indexedAccess.objectTypeName),
        this.typeFromTypeNameLoose(indexedAccess.indexTypeName)
      );
    }

    return null;
  }

  private isDeferredAdvancedTypeName(typeName: string): boolean {
    return (
      typeName.startsWith("infer ") ||
      /^\{ (?:[+-]?readonly )?\[/.test(typeName) ||
      parseConditionalTypeText(typeName) !== null
    );
  }

  private keyofType(targetType: AnalysisType): AnalysisType {
    const keys = this.propertyNamesForType(targetType);
    if (keys.length === 0) {
      return builtinType("never");
    }
    const keyTypes = keys.map((key) => literalType("string", key));
    return keyTypes.length === 1 ? keyTypes[0]! : unionType(keyTypes);
  }

  private indexedAccessType(objectType: AnalysisType, indexType: AnalysisType, node?: Node): AnalysisType {
    if (isUnknownType(objectType) || isUnknownType(indexType)) {
      return UNKNOWN_TYPE;
    }

    if (objectType.kind === "named" && this.isActiveTypeParameter(objectType.name)) {
      return namedType(`${typeToString(objectType)}[${this.indexedAccessTypeText(indexType)}]`);
    }

    if (indexType.kind === "union") {
      const memberTypes = indexType.types.map((member) => this.indexedAccessType(objectType, member, node));
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }

    if (indexType.kind === "literal") {
      const propertyName = String(indexType.value);
      if (propertyName === "_output") {
        const syntheticOutputType = this.syntheticSchemaOutputType(objectType);
        if (syntheticOutputType) {
          return syntheticOutputType;
        }
      }
      const propertyType = this.memberTypeFromObjectType(objectType, propertyName);
      if (propertyType) {
        return this.expandTypeAliases(propertyType);
      }
      if (node) {
        this.issues.push({
          message: `Type '${typeToString(objectType)}' has no property '${propertyName}'`,
          node
        });
      }
      return UNKNOWN_TYPE;
    }

    if (indexType.kind === "builtin" && indexType.name === "number") {
      if (objectType.kind === "array") {
        return objectType.elementType;
      }
      if (objectType.kind === "tuple") {
        return objectType.elements.length === 0 ? UNKNOWN_TYPE : unionType(objectType.elements);
      }
      const numericMemberType = this.memberTypeFromObjectType(objectType, "0");
      if (numericMemberType) {
        return numericMemberType;
      }
    }

    if (indexType.kind === "builtin" && indexType.name === "int") {
      return this.indexedAccessType(objectType, builtinType("number"), node);
    }

    return UNKNOWN_TYPE;
  }

  private syntheticSchemaOutputType(type: AnalysisType): AnalysisType | null {
    const shapeType = this.memberTypeFromObjectType(type, "shape");
    if (!shapeType || shapeType.kind !== "object") {
      return null;
    }

    const properties: Record<string, AnalysisType> = {};
    for (const [propertyName, schemaMemberType] of Object.entries(shapeType.properties)) {
      const directOutputType = this.memberTypeFromObjectType(schemaMemberType, "_output");
      if (directOutputType) {
        properties[propertyName] = directOutputType;
        continue;
      }
      const parseType = this.memberTypeFromObjectType(schemaMemberType, "parse");
      if (parseType?.kind === "function") {
        properties[propertyName] = parseType.returnType;
        continue;
      }
      return null;
    }

    return objectTypeWithProperties(properties);
  }

  private indexedAccessTypeText(indexType: AnalysisType): string {
    if (indexType.kind === "literal") {
      if (indexType.base === "string") {
        return JSON.stringify(String(indexType.value));
      }
      return String(indexType.value);
    }
    return typeToString(indexType);
  }

  private propertyNamesForType(type: AnalysisType): string[] {
    if (type.kind === "object") {
      return Object.keys(type.properties).map((key) => normalizePropertyName(key)).sort();
    }
    if (type.kind === "named") {
      const expanded = this.expandTypeAliases(type);
      if (expanded !== type) {
        return this.propertyNamesForType(expanded);
      }
      return Array.from(this.resolveNamedTypeMembers(type)?.keys() ?? []).map((key) => normalizePropertyName(key)).sort();
    }
    if (type.kind === "tuple") {
      return type.elements.map((_, index) => String(index));
    }
    return [];
  }

  private memberTypeFromObjectType(type: AnalysisType, propertyName: string): AnalysisType | null {
    propertyName = normalizePropertyName(propertyName);
    if (type.kind === "union") {
      const memberTypes = type.types
        .map((memberType) => this.memberTypeFromObjectType(memberType, propertyName))
        .filter((memberType): memberType is AnalysisType => memberType != null);
      if (memberTypes.length === 0) {
        return null;
      }
      return combineTypes(memberTypes);
    }
    if (type.kind === "intersection") {
      const memberTypes = type.types
        .map((memberType) => this.memberTypeFromObjectType(memberType, propertyName))
        .filter((memberType): memberType is AnalysisType => memberType != null);
      if (memberTypes.length === 0) {
        return null;
      }
      return combineTypes(memberTypes);
    }
    if (type.kind === "object") {
      return this.memberTypeFromProperties(type.properties, propertyName);
    }
    if (type.kind === "named") {
      const constraint = this.activeTypeParameterConstraint(type.name);
      if (constraint) {
        const constrainedMember = this.memberTypeFromObjectType(constraint, propertyName);
        if (constrainedMember) {
          return constrainedMember;
        }
      }
      const expanded = this.expandTypeAliases(type);
      if (expanded.kind !== "named") {
        return this.memberTypeFromObjectType(expanded, propertyName);
      }
      if (!isSameType(expanded, type)) {
        return this.memberTypeFromObjectType(expanded, propertyName);
      }
      const namedMembers = this.resolveNamedTypeMembers(expanded) ?? new Map();
      if (propertyName === "parse") {
        const syntheticOutputType = this.syntheticSchemaOutputType(expanded);
        const parseMember = this.memberTypeFromProperties(namedMembers, propertyName);
        if (syntheticOutputType && parseMember?.kind === "function") {
          return functionType(
            parseMember.parameters,
            syntheticOutputType,
            parseMember.typeParameters,
            parseMember.typeParameterConstraints,
            parseMember.typeParameterDefaults,
            parseMember.assertion
          );
        }
      }
      return this.memberTypeFromProperties(namedMembers, propertyName);
    }
    if (type.kind === "tuple" && /^\d+$/.test(propertyName)) {
      return type.elements[Number(propertyName)] ?? null;
    }
    if (type.kind === "builtin") {
      const boxedName = boxedInterfaceNameForBuiltin(type.name);
      if (boxedName) {
        return this.resolveNamedTypeMembers(namedType(boxedName))?.get(propertyName) ?? null;
      }
    }
    if (type.kind === "literal") {
      const boxedName = boxedInterfaceNameForBuiltin(type.base);
      if (boxedName) {
        return this.resolveNamedTypeMembers(namedType(boxedName))?.get(propertyName) ?? null;
      }
    }
    return null;
  }

  private memberTypeFromProperties(
    properties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
    propertyName: string
  ): AnalysisType | null {
    const direct = propertyTypeFrom(properties, propertyName);
    if (direct !== undefined) {
      return direct;
    }

    if (/^\d+$/.test(propertyName)) {
      return propertyTypeFrom(properties, "[number]")
        ?? propertyTypeFrom(properties, "[string]")
        ?? null;
    }

    return propertyTypeFrom(properties, "[string]") ?? null;
  }

  private objectRestBindingType(sourceType: AnalysisType, excludedNames: ReadonlySet<string>): AnalysisType {
    const members = this.membersForType(sourceType);
    if (!members) {
      return UNKNOWN_TYPE;
    }
    const properties: Record<string, AnalysisType> = {};
    for (const [memberName, memberType] of members.entries()) {
      if (excludedNames.has(normalizePropertyName(memberName))) {
        continue;
      }
      properties[memberName] = memberType;
    }
    return objectTypeWithProperties(properties);
  }

  private validateNamedTypeArgumentConstraints(
    typeName: string,
    typeArguments: AnalysisType[],
    node: Node,
    scope: Scope
  ): void {
    if (typeArguments.length === 0) {
      return;
    }
    const typeParameters = this.typeParametersForNamedType(typeName);
    const typeParameterCount = typeParameters?.length ?? 0;
    this.validateExplicitTypeArgumentArity(typeParameterCount, typeArguments.length, node);
    if (!typeParameters || typeParameters.length === 0) {
      return;
    }
    this.validateTypeParameterConstraints(typeParameters, typeArguments, node, scope);
  }

  private resolveReceiverTypeAnnotation(
    receiverType: Identifier,
    receiverTypeArguments: Identifier[] | undefined,
    scope: Scope
  ): AnalysisType {
    if (!receiverTypeArguments || receiverTypeArguments.length === 0) {
      return this.resolveTypeAnnotation(receiverType, scope) ?? namedType(receiverType.name);
    }
    const typeArguments = receiverTypeArguments.map((argument) =>
      this.resolveTypeAnnotation(argument, scope) ?? UNKNOWN_TYPE
    );
    this.validateNamedTypeArgumentConstraints(receiverType.name, typeArguments, receiverType, scope);
    return namedType(receiverType.name, typeArguments);
  }

  private typeParametersForNamedType(typeName: string): TypeParameter[] | null {
    return this.classStatementsByName.get(typeName)?.typeParameters
      ?? this.interfaceStatementsByName.get(typeName)?.typeParameters
      ?? this.typeAliasStatementsByName.get(typeName)?.typeParameters
      ?? null;
  }

  private validateTypeParameterConstraints(
    typeParameters: TypeParameter[],
    typeArguments: AnalysisType[],
    node: Node,
    scope: Scope
  ): void {
    const typeParameterNames = typeParameters.map((typeParameter) => typeParameter.name.name);
    const substitutions = new Map<string, AnalysisType>();
    for (let index = 0; index < typeParameters.length; index += 1) {
      const typeParameterName = typeParameters[index]?.name.name;
      if (!typeParameterName) {
        continue;
      }
      substitutions.set(typeParameterName, typeArguments[index] ?? namedType(typeParameterName));
    }

    this.withTypeParameters(typeParameterNames, () => {
      for (let index = 0; index < typeParameters.length && index < typeArguments.length; index += 1) {
        const typeParameter = typeParameters[index]!;
        if (!typeParameter.constraint) {
          continue;
        }
        const typeArgument = typeArguments[index]!;
        const rawConstraint = this.resolveTypeAnnotation(typeParameter.constraint, scope) ?? UNKNOWN_TYPE;
        const constraint = this.substituteTypeParameters(rawConstraint, substitutions);
        this.validateTypeArgumentConstraint(
          typeParameter.name.name,
          typeArgument,
          constraint,
          node
        );
      }
    });
  }

  private validateTypeArgumentConstraint(
    typeParameterName: string,
    typeArgument: AnalysisType,
    constraint: AnalysisType,
    node: Node
  ): void {
    if (isUnknownType(typeArgument) || isUnknownType(constraint)) {
      return;
    }
    if (typeArgument.kind === "named" && (typeArgument.name === typeParameterName || this.isActiveTypeParameter(typeArgument.name))) {
      return;
    }
    if (this.isTypeAssignable(typeArgument, constraint)) {
      return;
    }
    this.issues.push({
      message: `Type argument '${typeToString(typeArgument)}' does not satisfy constraint '${typeToString(constraint)}' for type parameter '${typeParameterName}'`,
      node
    });
  }

  private resolveTypeAliasTarget(
    typeAlias: TypeAliasStatement,
    typeArguments: AnalysisType[],
    scope: Scope
  ): AnalysisType {
    if (this.activeTypeAliasNames.has(typeAlias.name.name)) {
      return namedType(typeAlias.name.name, typeArguments);
    }

    const substitutions = new Map<string, AnalysisType>();
    const typeParameters = typeAlias.typeParameters ?? [];
    for (let index = 0; index < typeParameters.length; index += 1) {
      const parameterName = typeParameters[index]?.name.name;
      if (!parameterName) {
        continue;
      }
      substitutions.set(parameterName, typeArguments[index] ?? namedType(parameterName));
    }

    const mappedUtilityTarget = this.resolveMappedUtilityAliasTarget(typeAlias, substitutions);
    if (mappedUtilityTarget) {
      return mappedUtilityTarget;
    }

    const conditionalTarget = this.resolveConditionalTypeAliasTarget(typeAlias, substitutions, scope);
    if (conditionalTarget) {
      return conditionalTarget;
    }

    this.activeTypeAliasNames.add(typeAlias.name.name);
    let targetType: AnalysisType = UNKNOWN_TYPE;
    this.withTypeParameters(
      typeParameters.map((parameter) => parameter.name.name),
      () => {
        targetType = this.resolveTypeNameText(typeAlias.targetType.name, typeAlias.targetType, scope, false);
      },
      this.typeParameterConstraintMap(typeParameters, scope)
    );
    this.activeTypeAliasNames.delete(typeAlias.name.name);

    return this.substituteTypeParameters(targetType, substitutions);
  }

  private typeAliasResolutionScope(typeAlias: TypeAliasStatement): Scope {
    return this.bound.scopeByNode.get(typeAlias) ?? this.bound.rootScope;
  }

  private resolveConditionalTypeAliasTarget(
    typeAlias: TypeAliasStatement,
    substitutions: Map<string, AnalysisType>,
    scope: Scope
  ): AnalysisType | null {
    return this.resolveConditionalTypeText(typeAlias.targetType.name, substitutions, scope);
  }

  private resolveConditionalTypeText(
    typeText: string,
    substitutions: Map<string, AnalysisType>,
    scope: Scope
  ): AnalysisType | null {
    const conditional = parseConditionalTypeText(stripEnclosingTypeParens(typeText.trim()));
    if (!conditional) {
      return null;
    }

    const distributiveSource = this.distributiveConditionalSourceType(conditional.checkTypeText.trim(), substitutions);
    if (distributiveSource?.kind === "union") {
      return combineTypes(distributiveSource.types.map((member) => {
        const distributedSubstitutions = new Map(substitutions);
        distributedSubstitutions.set(conditional.checkTypeText.trim(), member);
        return this.resolveConditionalTypeBranch(conditional, member, distributedSubstitutions, scope);
      }));
    }

    const checkType = this.typeFromTypeNameLoose(
      this.substituteTypeParametersInComputedName(conditional.checkTypeText, substitutions)
    );
    return this.resolveConditionalTypeBranch(conditional, checkType, substitutions, scope);
  }

  private resolveConditionalTypeBranch(
    conditional: NonNullable<ReturnType<typeof parseConditionalTypeText>>,
    checkType: AnalysisType,
    substitutions: Map<string, AnalysisType>,
    scope: Scope
  ): AnalysisType {
    const inferSubstitutions = this.inferConditionalPatternSubstitutions(
      checkType,
      conditional.extendsTypeText,
      substitutions
    );
    const branchSubstitutions = inferSubstitutions
      ?? (this.isTypeAssignable(
        checkType,
        this.typeFromTypeNameLoose(
          this.substituteTypeParametersInComputedName(conditional.extendsTypeText, substitutions)
        )
      ) ? new Map<string, AnalysisType>() : null);

    const selectedBranch = branchSubstitutions !== null
      ? conditional.trueTypeText
      : conditional.falseTypeText;
    const finalSubstitutions = new Map(substitutions);
    if (branchSubstitutions) {
      for (const [name, type] of branchSubstitutions.entries()) {
        finalSubstitutions.set(name, type);
      }
    }
    const substitutedBranchText = this.substituteTypeParametersInComputedName(selectedBranch, finalSubstitutions);
    return this.resolveConditionalTypeText(substitutedBranchText, finalSubstitutions, scope)
      ?? this.typeFromTypeNameLoose(substitutedBranchText);
  }

  private distributiveConditionalSourceType(
    checkTypeText: string,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType | null {
    if (!/^[A-Za-z_$][\w$]*$/.test(checkTypeText)) {
      return null;
    }
    return substitutions.get(checkTypeText) ?? null;
  }

  private resolveMappedUtilityAliasTarget(
    typeAlias: TypeAliasStatement,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType | null {
    const trimmedTarget = stripEnclosingTypeParens(typeAlias.targetType.name.trim());
    const indexedMappedTarget = this.resolveMappedUtilityIndexedAccessAliasTarget(trimmedTarget, substitutions);
    if (indexedMappedTarget) {
      return indexedMappedTarget;
    }
    if (!trimmedTarget.startsWith("{") || !trimmedTarget.endsWith("}")) {
      return null;
    }
    const body = trimmedTarget.slice(1, -1).trim().replace(/;$/, "").trim();
    const mappedMember = parseMappedTypeMemberText(body);
    if (!mappedMember) {
      return null;
    }

    const keyParameterName = mappedMember.keyParameterName;
    const keySourceText = mappedMember.keySourceText;
    const keyRemapText = mappedMember.keyRemapText;
    const readonlyModifier = mappedMember.readonlyModifier;
    const optionalModifier = mappedMember.optionalModifier;
    const valueTypeText = mappedMember.valueTypeText;
    if (!keyParameterName || !keySourceText || !valueTypeText) {
      return null;
    }

    const sourceTypeParameterName = /^keyof\s+([A-Za-z_$][\w$]*)$/.exec(keySourceText.trim())?.[1]
      ?? /^([A-Za-z_$][\w$]*)\s*\[/.exec(valueTypeText.trim())?.[1];
    if (sourceTypeParameterName) {
      const sourceType = substitutions.get(sourceTypeParameterName);
      if (!sourceType) {
        return null;
      }

      const sourceEntries = this.objectLikePropertyEntries(sourceType);
      if (!sourceEntries) {
        return null;
      }

      const selectedKeys = this.mappedUtilitySelectedKeys(
        keySourceText.trim(),
        sourceType,
        substitutions
      );
      if (!selectedKeys) {
        return null;
      }

      const selectedKeySet = new Set(selectedKeys.map((key) => normalizePropertyName(key)));
      const properties: Record<string, AnalysisType> = {};
      for (const [propertyName, propertyType] of sourceEntries) {
        if (!selectedKeySet.has(normalizePropertyName(propertyName))) {
          continue;
        }
        const mappedPropertyType = this.resolveMappedUtilityPropertyType(
          valueTypeText.trim(),
          sourceTypeParameterName,
          keyParameterName,
          propertyName,
          propertyType,
          substitutions
        );
        const remappedKeys = this.resolveMappedUtilityRemappedKeys(
          keyRemapText,
          keyParameterName,
          propertyName,
          substitutions
        );
        if (!remappedKeys) {
          return null;
        }
        const finalPropertyType = this.applyMappedUtilityOptionalModifier(mappedPropertyType, optionalModifier);
        for (const remappedKey of remappedKeys) {
          properties[this.applyMappedUtilityReadonlyModifier(remappedKey, propertyName, readonlyModifier)] = finalPropertyType;
        }
      }
      return objectTypeWithProperties(properties);
    }

    const sourceObjectText = /^keyof\s+(.+)$/.exec(keySourceText.trim())?.[1]?.trim();
    if (!sourceObjectText) {
      return null;
    }
    const resolvedSourceObjectText = this.substituteTypeParametersInComputedName(sourceObjectText, substitutions);
    const sourceType = this.expandTypeAliases(this.typeFromTypeNameLoose(resolvedSourceObjectText));
    if (isUnknownType(sourceType)) {
      return null;
    }
    const sourceEntries = this.objectLikePropertyEntries(sourceType);
    if (!sourceEntries) {
      return null;
    }
    const selectedKeySet = new Set(this.propertyNamesForType(sourceType).map((key) => normalizePropertyName(key)));
    const properties: Record<string, AnalysisType> = {};
    for (const [propertyName, propertyType] of sourceEntries) {
      if (!selectedKeySet.has(normalizePropertyName(propertyName))) {
        continue;
      }
      const mappedPropertyType = this.resolveMappedUtilityExpressionPropertyType(
        valueTypeText.trim(),
        resolvedSourceObjectText,
        keyParameterName,
        propertyType,
        substitutions
      );
      const remappedKeys = this.resolveMappedUtilityRemappedKeys(
        keyRemapText,
        keyParameterName,
        propertyName,
        substitutions
      );
      if (!remappedKeys) {
        return null;
      }
      const finalPropertyType = this.applyMappedUtilityOptionalModifier(mappedPropertyType, optionalModifier);
      for (const remappedKey of remappedKeys) {
        properties[this.applyMappedUtilityReadonlyModifier(remappedKey, propertyName, readonlyModifier)] = finalPropertyType;
      }
    }
    return objectTypeWithProperties(properties);
  }

  private resolveMappedUtilityIndexedAccessAliasTarget(
    trimmedTarget: string,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType | null {
    const indexedAccess = splitIndexedAccessTypeName(trimmedTarget);
    if (!indexedAccess) {
      return null;
    }

    const objectTypeName = stripEnclosingTypeParens(indexedAccess.objectTypeName.trim());
    if (!objectTypeName.startsWith("{") || !objectTypeName.endsWith("}")) {
      return null;
    }

    const objectType = this.resolveMappedUtilityAliasTarget({
      kind: "TypeAliasStatement",
      name: { kind: "Identifier", name: "<mapped>" },
      targetType: { kind: "Identifier", name: objectTypeName }
    } as TypeAliasStatement, substitutions);
    if (!objectType) {
      return null;
    }

    const indexTypeText = this.substituteTypeParametersInComputedName(
      indexedAccess.indexTypeName,
      substitutions
    );
    return this.indexedAccessType(
      objectType,
      this.expandTypeAliases(this.typeFromTypeNameLoose(indexTypeText))
    );
  }

  private resolveMappedUtilityRemappedKeys(
    keyRemapText: string | undefined,
    keyParameterName: string,
    propertyName: string,
    substitutions: Map<string, AnalysisType>
  ): string[] | null {
    if (!keyRemapText) {
      return [propertyName];
    }

    const remapSubstitutions = new Map(substitutions);
    remapSubstitutions.set(keyParameterName, literalType("string", normalizePropertyName(propertyName)));
    const remappedKeyType = this.typeFromTypeNameLoose(
      this.substituteTypeParametersInComputedName(keyRemapText, remapSubstitutions)
    );
    if (remappedKeyType.kind === "builtin" && remappedKeyType.name === "never") {
      return [];
    }
    return this.literalPropertyNamesFromType(remappedKeyType);
  }

  private applyMappedUtilityOptionalModifier(
    propertyType: AnalysisType,
    optionalModifier: "?" | "+?" | "-?" | undefined
  ): AnalysisType {
    if (optionalModifier === "-?") {
      return propertyTypeWithoutUndefined(removeNullishFromType(propertyType))
        ?? removeNullishFromType(propertyType);
    }
    if (optionalModifier === "?" || optionalModifier === "+?") {
      return unionType([propertyType, builtinType("undefined")]);
    }
    return propertyType;
  }

  private applyMappedUtilityReadonlyModifier(
    remappedKey: string,
    sourcePropertyName: string,
    readonlyModifier: "readonly" | "+readonly" | "-readonly" | undefined
  ): string {
    if (readonlyModifier === "readonly" || readonlyModifier === "+readonly") {
      return toReadonlyPropertyName(remappedKey);
    }
    if (readonlyModifier === "-readonly") {
      return stripReadonlyPropertyPrefix(remappedKey);
    }
    return isReadonlyPropertyName(sourcePropertyName)
      ? toReadonlyPropertyName(remappedKey)
      : stripReadonlyPropertyPrefix(remappedKey);
  }

  private resolveMappedUtilityPropertyType(
    valueTypeText: string,
    sourceTypeParameterName: string,
    keyParameterName: string,
    propertyName: string,
    propertyType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType {
    const directValuePattern = new RegExp(
      `^${sourceTypeParameterName}\\s*\\[\\s*${keyParameterName}\\s*\\]$`
    );
    if (directValuePattern.test(valueTypeText)) {
      return propertyType;
    }

    const conditional = parseConditionalTypeText(valueTypeText);
    if (conditional) {
      const checkType = this.typeFromTypeNameLoose(this.mappedUtilitySubstitutedPropertyText(
        conditional.checkTypeText,
        sourceTypeParameterName,
        keyParameterName,
        propertyName,
        propertyType,
        substitutions
      ));
      const extendsType = this.typeFromTypeNameLoose(this.mappedUtilitySubstitutedPropertyText(
        conditional.extendsTypeText,
        sourceTypeParameterName,
        keyParameterName,
        propertyName,
        propertyType,
        substitutions
      ));
      const selectedBranch = this.isTypeAssignable(checkType, extendsType)
        ? conditional.trueTypeText
        : conditional.falseTypeText;
      return this.resolveMappedUtilityBranchType(
        selectedBranch,
        sourceTypeParameterName,
        keyParameterName,
        propertyName,
        propertyType,
        substitutions
      );
    }

    const substitutedValueText = this.mappedUtilitySubstitutedPropertyText(
      valueTypeText,
      sourceTypeParameterName,
      keyParameterName,
      propertyName,
      propertyType,
      substitutions
    );
    return this.expandTypeAliases(this.typeFromTypeNameLoose(substitutedValueText));
  }

  private resolveMappedUtilityBranchType(
    branchText: string,
    sourceTypeParameterName: string,
    keyParameterName: string,
    propertyName: string,
    propertyType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType {
    return this.typeFromTypeNameLoose(this.mappedUtilitySubstitutedPropertyText(
      branchText,
      sourceTypeParameterName,
      keyParameterName,
      propertyName,
      propertyType,
      substitutions
    ));
  }

  private mappedUtilitySubstitutedPropertyText(
    typeText: string,
    sourceTypeParameterName: string,
    keyParameterName: string,
    propertyName: string,
    propertyType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): string {
    const indexedPropertyPattern = new RegExp(
      `${sourceTypeParameterName}\\s*\\[\\s*${keyParameterName}\\s*\\]`,
      "g"
    );
    const keyPattern = new RegExp(`\\b${this.escapeRegexForTypePattern(keyParameterName)}\\b`, "g");
    return this.substituteTypeParametersInComputedName(
      typeText
        .replace(indexedPropertyPattern, typeToString(propertyType))
        .replace(keyPattern, JSON.stringify(normalizePropertyName(propertyName))),
      substitutions
    );
  }

  private resolveMappedUtilityExpressionPropertyType(
    valueTypeText: string,
    sourceObjectText: string,
    keyParameterName: string,
    propertyType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType {
    const escapedSourceObjectText = this.escapeRegexForTypePattern(sourceObjectText);
    const indexedPropertyPattern = new RegExp(
      `${escapedSourceObjectText}\\s*\\[\\s*${keyParameterName}\\s*\\]`,
      "g"
    );
    const substitutedValueText = this.substituteTypeParametersInComputedName(
      valueTypeText.replace(indexedPropertyPattern, typeToString(propertyType)),
      substitutions
    );
    return this.expandTypeAliases(this.typeFromTypeNameLoose(substitutedValueText));
  }

  private escapeRegexForTypePattern(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private objectLikePropertyEntries(type: AnalysisType): Array<[string, AnalysisType]> | null {
    if (type.kind === "object") {
      return Object.entries(type.properties);
    }
    if (type.kind === "named") {
      const expanded = this.expandTypeAliases(type);
      if (expanded !== type) {
        return this.objectLikePropertyEntries(expanded);
      }
      return Array.from(this.resolveNamedTypeMembers(type)?.entries() ?? []);
    }
    return null;
  }

  private mappedUtilitySelectedKeys(
    keySourceText: string,
    sourceType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): string[] | null {
    if (keySourceText.startsWith("keyof ")) {
      return this.propertyNamesForType(sourceType);
    }

    const keyType = substitutions.get(keySourceText);
    if (keyType) {
      return this.literalPropertyNamesFromType(keyType);
    }
    const resolvedKeyType = this.expandTypeAliases(this.typeFromTypeNameLoose(
      this.substituteTypeParametersInComputedName(keySourceText, substitutions)
    ));
    return this.literalPropertyNamesFromType(resolvedKeyType);
  }

  private literalPropertyNamesFromType(type: AnalysisType): string[] | null {
    if (type.kind === "literal") {
      return [String(type.value)];
    }
    if (type.kind === "union") {
      const names: string[] = [];
      for (const member of type.types) {
        const memberNames = this.literalPropertyNamesFromType(member);
        if (!memberNames) {
          return null;
        }
        names.push(...memberNames);
      }
      return names;
    }
    return null;
  }

  private inferConditionalPatternSubstitutions(
    sourceType: AnalysisType,
    patternText: string,
    substitutions: Map<string, AnalysisType>
  ): Map<string, AnalysisType> | null {
    const substitutedPattern = this.substituteTypeParametersInComputedName(patternText, substitutions).trim();

    const directInferMatch = /^infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+))?$/.exec(substitutedPattern);
    if (directInferMatch?.[1]) {
      return this.constrainedInferSubstitution(
        directInferMatch[1],
        sourceType,
        directInferMatch[2]?.trim()
      );
    }

    const arrayMatch = /^\(?infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+?))?\)?\[\]$/.exec(substitutedPattern);
    if (arrayMatch?.[1]) {
      const elementType = this.arrayElementTypeForInferPattern(sourceType);
      return elementType
        ? this.constrainedInferSubstitution(arrayMatch[1], elementType, arrayMatch[2]?.trim())
        : null;
    }

    const readonlyArrayMatch = /^readonly\s+\(?infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+?))?\)?\s*\[\]$/.exec(substitutedPattern);
    if (readonlyArrayMatch?.[1]) {
      const elementType = this.arrayElementTypeForInferPattern(sourceType);
      return elementType
        ? this.constrainedInferSubstitution(readonlyArrayMatch[1], elementType, readonlyArrayMatch[2]?.trim())
        : null;
    }

    const genericInferMatch = /^([A-Za-z_$][\w$.]*)<\s*infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+?))?\s*>$/.exec(substitutedPattern);
    if (genericInferMatch?.[1] && genericInferMatch[2]) {
      const inferred = this.genericInferTypeArgument(sourceType, genericInferMatch[1]);
      return inferred
        ? this.constrainedInferSubstitution(genericInferMatch[2], inferred, genericInferMatch[3]?.trim())
        : null;
    }

    const functionArgsInferMatch = /^\(\s*\.\.\.[^:]+:\s*infer\s+([A-Za-z_$][\w$]*)\s*\)\s*=>\s*any$/.exec(substitutedPattern);
    if (functionArgsInferMatch?.[1] && sourceType.kind === "function") {
      return new Map([[functionArgsInferMatch[1], tupleType(sourceType.parameters.map((parameter) => parameter.type))]]);
    }

    const functionReturnInferMatch = /^\(\s*\.\.\.[^:]+:\s*any\s*\)\s*=>\s*infer\s+([A-Za-z_$][\w$]*)$/.exec(substitutedPattern);
    if (functionReturnInferMatch?.[1] && sourceType.kind === "function") {
      return new Map([[functionReturnInferMatch[1], sourceType.returnType]]);
    }

    const functionInferMatch = parseFunctionTypeAnnotation(substitutedPattern);
    if (functionInferMatch && sourceType.kind === "function") {
      return this.inferFunctionConditionalPatternSubstitutions(sourceType, functionInferMatch);
    }

    const constructorParamsMatch = /^(?:abstract\s+)?new\s*\(\s*\.\.\.[^:]+:\s*infer\s+([A-Za-z_$][\w$]*)\s*\)\s*=>\s*any$/.exec(substitutedPattern);
    if (constructorParamsMatch?.[1]) {
      const constructSignature = this.constructSignatureForUtility(sourceType);
      return constructSignature
        ? new Map([[constructorParamsMatch[1], tupleType(constructSignature.parameters.map((parameter) => parameter.type))]])
        : null;
    }

    const constructorReturnMatch = /^(?:abstract\s+)?new\s*\(\s*\.\.\.[^:]+:\s*any\s*\)\s*=>\s*infer\s+([A-Za-z_$][\w$]*)$/.exec(substitutedPattern);
    if (constructorReturnMatch?.[1]) {
      const constructSignature = this.constructSignatureForUtility(sourceType);
      return constructSignature
        ? new Map([[constructorReturnMatch[1], constructSignature.returnType]])
        : null;
    }

    return null;
  }

  private constrainedInferSubstitution(
    name: string,
    inferredType: AnalysisType,
    constraintText?: string
  ): Map<string, AnalysisType> | null {
    if (constraintText) {
      const constraintType = this.typeFromTypeNameLoose(constraintText);
      if (!this.isTypeAssignable(inferredType, constraintType)) {
        return null;
      }
    }
    return new Map([[name, inferredType]]);
  }

  private inferFunctionConditionalPatternSubstitutions(
    sourceType: AnalysisType & { kind: "function" },
    pattern: ReturnType<typeof parseFunctionTypeAnnotation>
  ): Map<string, AnalysisType> | null {
    if (!pattern) {
      return null;
    }
    const result = new Map<string, AnalysisType>();

    if (pattern.parameters.length === 1 && pattern.parameters[0]?.rest === true) {
      const parameterTypeName = pattern.parameters[0].typeName.trim();
      const restInferMatch = /^infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+))?$/.exec(parameterTypeName);
      if (restInferMatch?.[1]) {
        const constrained = this.constrainedInferSubstitution(
          restInferMatch[1],
          tupleType(sourceType.parameters.map((parameter) => parameter.type)),
          restInferMatch[2]?.trim()
        );
        if (!constrained) {
          return null;
        }
        for (const [name, type] of constrained.entries()) {
          result.set(name, type);
        }
      } else if (parameterTypeName !== "any") {
        return null;
      }
    }

    const returnInferMatch = /^infer\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+(.+))?$/.exec(pattern.returnTypeName.trim());
    if (returnInferMatch?.[1]) {
      const constrained = this.constrainedInferSubstitution(
        returnInferMatch[1],
        sourceType.returnType,
        returnInferMatch[2]?.trim()
      );
      if (!constrained) {
        return null;
      }
      for (const [name, type] of constrained.entries()) {
        result.set(name, type);
      }
    } else if (pattern.returnTypeName.trim() !== "any") {
      const expectedReturnType = this.typeFromTypeNameLoose(pattern.returnTypeName);
      if (!this.isTypeAssignable(sourceType.returnType, expectedReturnType)) {
        return null;
      }
    }

    return result.size > 0 ? result : null;
  }

  private arrayElementTypeForInferPattern(sourceType: AnalysisType): AnalysisType | null {
    if (sourceType.kind === "array") {
      return sourceType.elementType;
    }
    if (sourceType.kind === "tuple") {
      return sourceType.elements.length === 1 ? sourceType.elements[0]! : combineTypes(sourceType.elements);
    }
    if (sourceType.kind === "named" && (sourceType.name === "Array" || sourceType.name === "ReadonlyArray")) {
      return sourceType.typeArguments?.[0] ?? UNKNOWN_TYPE;
    }
    return null;
  }

  private genericInferTypeArgument(sourceType: AnalysisType, genericName: string): AnalysisType | null {
    if (sourceType.kind === "array" && (genericName === "Array" || genericName === "ReadonlyArray")) {
      return sourceType.elementType;
    }
    if (sourceType.kind === "tuple" && (genericName === "Array" || genericName === "ReadonlyArray")) {
      return sourceType.elements.length === 1 ? sourceType.elements[0]! : combineTypes(sourceType.elements);
    }
    if (sourceType.kind !== "named" || sourceType.name !== genericName) {
      return null;
    }
    return sourceType.typeArguments?.[0] ?? UNKNOWN_TYPE;
  }

  private withTypeParameters(
    typeParameters: string[],
    action: () => void,
    constraints?: Record<string, AnalysisType>
  ): void {
    if (typeParameters.length <= 0) {
      action();
      return;
    }
    this.activeTypeParameterScopes.push(new Set(typeParameters));
    this.activeTypeParameterConstraintScopes.push(new Map(Object.entries(constraints ?? {})));
    try {
      action();
    } finally {
      this.activeTypeParameterConstraintScopes.pop();
      this.activeTypeParameterScopes.pop();
    }
  }

  private isActiveTypeParameter(name: string): boolean {
    for (let i = this.activeTypeParameterScopes.length - 1; i >= 0; i -= 1) {
      const scope = this.activeTypeParameterScopes[i];
      if (scope?.has(name)) {
        return true;
      }
    }
    return false;
  }

  private activeTypeParameterConstraint(name: string): AnalysisType | null {
    for (let i = this.activeTypeParameterConstraintScopes.length - 1; i >= 0; i -= 1) {
      const constraint = this.activeTypeParameterConstraintScopes[i]?.get(name);
      if (constraint) {
        return constraint;
      }
    }
    return null;
  }

  private isLValueExpression(expression: Expr): boolean {
    if (expression.kind === "Identifier") {
      return true;
    }
    if (expression.kind !== "MemberExpression") {
      return false;
    }
    const member = expression as MemberExpression;
    if (member.optional === true) {
      return false;
    }
    return this.isLValueExpression(member.object);
  }

  private isAssignmentTargetExpression(expression: Expr): boolean {
    if (expression.kind === "Identifier") {
      return true;
    }
    return expression.kind === "MemberExpression";
  }

  private hasOptionalAssignmentTarget(expression: Expr): boolean {
    if (expression.kind !== "MemberExpression") {
      return false;
    }
    const member = expression as MemberExpression;
    return member.optional === true || this.hasOptionalAssignmentTarget(member.object);
  }

  private validateReadonlyAssignmentTarget(expression: Expr, scope: Scope): void {
    if (expression.kind === "Identifier") {
      const identifier = expression as Node & { kind: "Identifier"; name: string };
      const usageOffset = identifier.firstToken?.range.start.offset;
      const symbol = this.resolve(identifier.name, scope, usageOffset);
      if (!symbol || symbol.kind !== "variable" || symbol.isReadonly !== true) {
        return;
      }

      this.issues.push({
        message: `Cannot assign to '${identifier.name}' because it is a constant`,
        node: identifier
      });
      return;
    }

    if (expression.kind !== "MemberExpression") {
      return;
    }

    const member = expression as MemberExpression;
    if (member.computed) {
      const objectType = this.visitExpression(member.object, scope);
      const propertyType = this.visitExpression(member.property, scope);
      if (this.isReadonlyIndexedAccess(objectType, propertyType)) {
        this.issues.push({
          message: "Cannot assign through readonly index access",
          node: member.property
        });
      } else {
        const readonlyPropertyName = this.readonlyPropertyNameFromComputedAccess(objectType, propertyType);
        if (readonlyPropertyName) {
          this.issues.push({
            message: `Cannot assign to readonly member '${readonlyPropertyName}'`,
            node: member.property
          });
        } else {
          const staticPropertyName = this.staticComputedPropertyName(member.property);
          if (staticPropertyName && this.hasReadonlyProperty(objectType, staticPropertyName)) {
            this.issues.push({
              message: `Cannot assign to readonly member '${staticPropertyName}'`,
              node: member.property
            });
          }
        }
      }
      return;
    }

    if (member.property.kind !== "Identifier") {
      return;
    }

    const propertyName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    const receiverType = this.visitExpression(member.object, scope);
    if (this.hasReadonlyProperty(receiverType, propertyName)) {
      this.issues.push({
        message: `Cannot assign to readonly member '${propertyName}'`,
        node: member.property
      });
      return;
    }

    const simpleObjectType = this.inferSimpleObjectType(member.object, scope);
    if (!simpleObjectType || simpleObjectType.kind !== "named") {
      return;
    }
    const classStatement = this.classStatementsByName.get(simpleObjectType.name);
    const classField = classStatement?.members.find(
      (candidate): candidate is ClassFieldMember =>
        candidate.kind === "ClassFieldMember" && candidate.name.name === propertyName
    );
    const parameterProperty = classStatement?.members
      .filter((candidate): candidate is ClassMethodMember => candidate.kind === "ClassMethodMember" && candidate.name.name === "constructor")
      .flatMap((constructor) => constructor.parameters)
      .find((parameter) => (parameter.accessModifier !== undefined || parameter.readonly === true) && bindingNameText(parameter.name) === propertyName);
    if (classField?.readonly !== true && parameterProperty?.readonly !== true) {
      return;
    }
    if (member.object.kind === "Identifier" && (member.object as Identifier).name === "this" && this.enclosingMethodName(scope) === "constructor") {
      return;
    }

    this.issues.push({
      message: `Cannot assign to readonly member '${propertyName}'`,
      node: member.property
    });
  }

  private isReadonlyIndexedAccess(objectType: AnalysisType, propertyType: AnalysisType): boolean {
    if (objectType.kind === "union") {
      return objectType.types.some((member) =>
        !isNullishType(member) && this.isReadonlyIndexedAccess(member, propertyType)
      );
    }
    if (objectType.kind === "tuple" && isIntType(propertyType)) {
      return objectType.readonly === true;
    }
    if (objectType.kind === "array" && isIntType(propertyType)) {
      return objectType.readonly === true;
    }
    if (
      objectType.kind === "named"
      && objectType.name === "ReadonlyArray"
      && isIntType(propertyType)
    ) {
      return true;
    }
    return false;
  }

  private hasReadonlyProperty(type: AnalysisType, propertyName: string): boolean {
    if (type.kind === "union") {
      return type.types.some((member) =>
        !isNullishType(member) && this.hasReadonlyProperty(member, propertyName)
      );
    }
    if (type.kind === "intersection") {
      return type.types.some((member) => this.hasReadonlyProperty(member, propertyName));
    }
    if (type.kind === "named") {
      const expanded = this.expandTypeAliases(type);
      if (!isSameType(expanded, type)) {
        return this.hasReadonlyProperty(expanded, propertyName);
      }
      const members = this.resolveNamedTypeMembers(type);
      if (!members) {
        return false;
      }
      return Array.from(members.keys()).some((candidateName) =>
        normalizePropertyName(candidateName) === propertyName && isReadonlyPropertyName(candidateName)
      );
    }
    if (type.kind !== "object") {
      return false;
    }
    return propertyEntries(type.properties).some(([candidateName]) =>
      normalizePropertyName(candidateName) === propertyName && isReadonlyPropertyName(candidateName)
    );
  }

  private readonlyPropertyNameFromComputedAccess(objectType: AnalysisType, propertyType: AnalysisType): string | null {
    const propertyNames = this.literalPropertyNamesFromType(propertyType);
    if (!propertyNames || propertyNames.length !== 1) {
      return null;
    }
    const propertyName = propertyNames[0]!;
    return this.hasReadonlyProperty(objectType, propertyName) ? propertyName : null;
  }

  private staticComputedPropertyName(propertyExpression: Expr): string | null {
    if (propertyExpression.kind === "StringLiteral") {
      return (propertyExpression as StringLiteral).value;
    }
    if (propertyExpression.kind === "Identifier") {
      return (propertyExpression as Identifier).name;
    }
    return null;
  }

  private inferSimpleObjectType(expression: Expr, scope: Scope): AnalysisType | null {
    if (expression.kind !== "Identifier") {
      return null;
    }

    const identifier = expression as Identifier;
    const symbol = this.resolve(identifier.name, scope, identifier.firstToken?.range.start.offset);
    return symbol?.type ?? null;
  }

  private enclosingMethodName(scope: Scope): string | null {
    let current: Scope | undefined = scope;
    while (current) {
      if (current.node.kind === "ClassMethodMember") {
        return (current.node as ClassMethodMember).name.name;
      }
      current = current.parent;
    }
    return null;
  }

  private resolve(
    name: string,
    scope: Scope,
    usageOffset: number | undefined
  ): AnalysisSymbol | null {
    let current: Scope | undefined = scope;
    while (current) {
      const symbol = current.symbols.get(name);
      if (symbol) {
        if (!current.parent) {
          return symbol;
        }
        if (symbol.implicitReceiver === true) {
          return symbol;
        }
        if (usageOffset === undefined || symbol.declaredOffset < 0 || symbol.declaredOffset <= usageOffset) {
          return symbol;
        }
      }
      current = current.parent;
    }
    return null;
  }

  private resolveIdentifierType(
    identifier: Node & { kind: "Identifier"; name: string },
    scope: Scope
  ): AnalysisType {
    const usageOffset = identifier.firstToken?.range.start.offset;
    const symbol = this.resolve(identifier.name, scope, usageOffset);
    if (symbol) {
      this.identifierResolutions.push({ identifier, symbol });
      return symbol.type ?? UNKNOWN_TYPE;
    }
    this.issues.push({
      message: `Undefined variable '${identifier.name}'`,
      node: identifier
    });
    return UNKNOWN_TYPE;
  }

  private updateSymbolType(scope: Scope, name: string, type: AnalysisType): void {
    const symbol = scope.symbols.get(name);
    if (!symbol) {
      return;
    }
    symbol.type = type;
    symbol.valueType = typeToString(type);
  }

  private updateResolvedSymbolType(
    scope: Scope,
    identifier: Node & { kind: "Identifier"; name: string },
    type: AnalysisType
  ): void {
    const usageOffset = identifier.firstToken?.range.start.offset;
    const symbol = this.resolve(identifier.name, scope, usageOffset);
    if (!symbol) {
      return;
    }
    symbol.type = type;
    symbol.valueType = typeToString(type);
  }

  /**
   * Evolving array inference: when a variable whose element type is still
   * unknown (for example `const array: unknown[] = []` or `let xs = []`) is
   * mutated through `push`/`unshift`, refine the variable's element type from
   * the inserted value. This mirrors how TypeScript lets an implicitly typed
   * empty array "evolve" from how it is used, so `array.push(10)` updates the
   * inferred type of `array` to `int[]`.
   */
  private evolveArrayElementTypeFromMutation(
    call: CallExpression,
    scope: Scope,
    argumentTypes: AnalysisType[]
  ): void {
    if (call.optional === true) {
      return;
    }
    const callee = call.callee;
    if (callee.kind !== "MemberExpression") {
      return;
    }
    const member = callee as MemberExpression;
    if (member.computed || member.optional === true) {
      return;
    }
    if (member.object.kind !== "Identifier" || member.property.kind !== "Identifier") {
      return;
    }
    const methodName = (member.property as Identifier).name;
    if (methodName !== "push" && methodName !== "unshift") {
      return;
    }
    if (argumentTypes.length === 0) {
      return;
    }
    const identifier = member.object as Node & { kind: "Identifier"; name: string };
    const usageOffset = identifier.firstToken?.range.start.offset;
    const symbol = this.resolve(identifier.name, scope, usageOffset);
    if (!symbol || symbol.type?.kind !== "array") {
      return;
    }
    const element = symbol.type.elementType;
    const elementIsUnknown = isUnknownType(element) || (element.kind === "builtin" && element.name === "unknown");
    if (!elementIsUnknown) {
      return;
    }
    const elementType = this.widenForArrayElement(argumentTypes[0]!);
    if (isUnknownType(elementType) || (elementType.kind === "builtin" && elementType.name === "unknown")) {
      return;
    }
    const evolved = arrayType(elementType);
    symbol.type = evolved;
    symbol.valueType = typeToString(evolved);
  }

  /** Widen a literal value type to its underlying primitive for array element inference. */
  private widenForArrayElement(type: AnalysisType): AnalysisType {
    if (type.kind === "literal") {
      if (type.base === "string") {
        return builtinType("string");
      }
      if (type.base === "boolean") {
        return builtinType("boolean");
      }
      return builtinType("number");
    }
    return type;
  }

  private createFunctionLikeExpressionScope(
    parentScope: Scope,
    node: Node,
    parameters: FunctionParameter[],
    expectedFunctionType?: AnalysisType & { kind: "function" }
  ): Scope {
    const existingScope = this.bound.scopeByNode.get(node);
    const functionScope: Scope = existingScope ?? {
      parent: parentScope,
      node,
      symbols: new Map<string, AnalysisSymbol>(),
      children: []
    };
    functionScope.parent = parentScope;
    functionScope.symbols.clear();
    if (!existingScope) {
      parentScope.children.push(functionScope);
      this.bound.scopeByNode.set(node, functionScope);
    }
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = parameters[index]!;
      const expectedParameterType = expectedFunctionType?.parameters[index]?.type;
      const parameterType =
        this.resolveTypeAnnotation(parameter.typeAnnotation, functionScope) ??
        expectedParameterType ??
        (parameter.defaultValue ? this.visitExpression(parameter.defaultValue, functionScope) : UNKNOWN_TYPE);
      this.validateRestParameterType(parameter, parameterType);
      for (const element of bindingElements(parameter.name)) {
        if (element.initializer) this.visitExpression(element.initializer, functionScope);
      }
      this.defineBindingParameterSymbols(functionScope, parameter.name, parameterType);
    }
    return functionScope;
  }

  private validateRestParameterType(parameter: FunctionParameter, parameterType: AnalysisType): void {
    if (parameter.rest !== true || this.isValidRestParameterType(parameterType)) {
      return;
    }
    this.issues.push({
      message: `Rest parameter '${bindingNameText(parameter.name)}' must have an array type`,
      node: parameter.typeAnnotation ?? parameter.name
    });
  }

  private isValidRestParameterType(parameterType: AnalysisType): boolean {
    if (
      isUnknownType(parameterType) ||
      parameterType.kind === "array" ||
      parameterType.kind === "tuple"
    ) {
      return true;
    }
    if (parameterType.kind === "named" && parameterType.name === "Array" && parameterType.typeArguments?.[0]) {
      return true;
    }
    if (parameterType.kind === "named") {
      const constraint = this.activeTypeParameterConstraint(parameterType.name);
      return constraint ? this.isValidRestParameterType(constraint) : false;
    }
    return false;
  }

  private isIntEnumLikeType(type: AnalysisType): boolean {
    if (isIntType(type)) {
      return true;
    }
    return type.kind === "named" && this.enumUnderlyingValueTypeName(type.name) === "int";
  }

  /**
   * Computes the most specific common supertype of two types for type
   * unification (for example, when inferring the element type of an array
   * literal). When neither type is assignable to the other but both belong to
   * the numeric tower, the common supertype is `numeric`. Otherwise, when the
   * types are genuinely incompatible (for example `int` and `string`), it falls
   * back to `any` so the resulting array stays usable.
   */
  private commonSupertype(a: AnalysisType, b: AnalysisType): AnalysisType {
    if (this.isTypeAssignable(a, b)) {
      return b;
    }
    if (this.isTypeAssignable(b, a)) {
      return a;
    }
    if (isNumericFamilyType(a) && isNumericFamilyType(b)) {
      return builtinType("numeric");
    }
    return builtinType("any");
  }

  private contextualLiteralType(literal: AnalysisType, expectedType?: AnalysisType): AnalysisType | null {
    if (!expectedType || literal.kind !== "literal") {
      return null;
    }
    const expandedExpectedType = this.expandTypeAliases(this.normalizeLooseNamedType(expectedType));
    if (expandedExpectedType.kind === "literal" && this.isTypeAssignable(literal, expandedExpectedType)) {
      return expandedExpectedType;
    }
    if (expandedExpectedType.kind === "union") {
      return expandedExpectedType.types.find((member) => member.kind === "literal" && this.isTypeAssignable(literal, member)) ?? null;
    }
    return null;
  }


  private inferArrayLiteralType(
    arrayLiteral: ArrayLiteral,
    scope: Scope,
    expectedType?: AnalysisType
  ): AnalysisType {
    if (expectedType?.kind === "tuple") {
      return tupleType(arrayLiteral.elements.map((element, index) =>
        this.visitExpression(element, scope, expectedType.elements[index])
      ));
    }

    let inferredElementType: AnalysisType | undefined;
    const expectedElementType = this.expectedArrayElementType(expectedType);

    for (const element of arrayLiteral.elements) {
      if (element.kind === "ArrayHole") {
        this.expressionTypes.set(element, builtinType("undefined"));
      }
      const visitedType = element.kind === "ArrayHole"
        ? builtinType("undefined")
        : this.visitExpression(element, scope, expectedElementType);
      const currentType = element.kind === "SpreadExpression"
        ? spreadArgumentElementType(visitedType)
        : visitedType;
      if (expectedElementType && this.isTypeAssignable(currentType, expectedElementType)) {
        inferredElementType = expectedElementType;
        continue;
      }
      if (!inferredElementType) {
        inferredElementType = currentType;
        continue;
      }

      inferredElementType = this.commonSupertype(inferredElementType, currentType);
    }

    return arrayType(inferredElementType ?? UNKNOWN_TYPE);
  }

  private inferObjectLiteralType(
    objectLiteral: ObjectLiteral,
    scope: Scope,
    expectedType?: AnalysisType
  ): AnalysisType {
    if (objectLiteral.properties.length === 0) {
      return objectType();
    }

    const expectedProperties = this.expectedObjectProperties(expectedType);
    const allowsAdditionalProperties = this.expectedObjectLiteralAllowsAdditionalProperties(expectedType);
    const canReportUnknownProperties = this.canReportUnknownObjectLiteralProperties(expectedType);
    const properties: Record<string, AnalysisType> = {};
    for (const property of objectLiteral.properties) {
      if (property.kind === "ObjectSpreadProperty") {
        const spreadType = this.visitExpression((property as ObjectSpreadProperty).argument, scope);
        if (spreadType.kind === "object") {
          Object.assign(properties, spreadType.properties);
          continue;
        }
        if (spreadType.kind === "named") {
          const namedProperties = this.resolveNamedTypeMembers(spreadType);
          if (namedProperties) {
            for (const [name, type] of namedProperties) {
              properties[name] = type;
            }
          }
          continue;
        }
        if (!isUnknownType(spreadType) && !(spreadType.kind === "builtin" && spreadType.name === "object")) {
          this.issues.push({
            message: `Spread types may only be created from object types; got '${typeToString(spreadType)}'`,
            node: property
          });
        }
        continue;
      }

      const objectProperty = property as ObjectProperty;
      if (objectProperty.computed) {
        this.visitExpression(objectProperty.key, scope);
      }
      const propertyName = this.staticObjectPropertyName(objectProperty);
      const propertyType = this.visitExpression(
        objectProperty.value,
        scope,
        propertyName && expectedProperties ? propertyTypeFrom(expectedProperties, propertyName) : undefined
      );
      if (propertyName) {
        if (
          expectedProperties
          && canReportUnknownProperties
          && propertyTypeFrom(expectedProperties, propertyName) === undefined
          && !allowsAdditionalProperties
        ) {
          this.issues.push({
            message: `Object literal property '${propertyName}' does not exist in type '${typeToString(expectedType!)}'`,
            node: objectProperty.key
          });
        }
        properties[propertyName] = propertyType;
      }
    }
    return objectTypeWithProperties(properties);
  }

  private staticObjectPropertyName(property: ObjectProperty): string | undefined {
    if (property.computed) {
      return undefined;
    }
    if (property.key.kind === "Identifier") {
      return (property.key as Identifier).name;
    }
    if (property.key.kind === "StringLiteral") {
      return (property.key as StringLiteral).value;
    }
    if (property.key.kind === "IntLiteral") {
      return String((property.key as IntLiteral | FloatLiteral).value);
    }
    if (property.key.kind === "FloatLiteral") {
      return String((property.key as IntLiteral | FloatLiteral).value);
    }
    return undefined;
  }

  private expectedArrayElementType(expectedType: AnalysisType | undefined): AnalysisType | undefined {
    if (!expectedType || isUnknownType(expectedType)) {
      return undefined;
    }
    if (expectedType.kind === "array") {
      return expectedType.elementType;
    }
    if (expectedType.kind === "range") {
      return expectedType.elementType;
    }
    return undefined;
  }

  private expectedObjectProperties(
    expectedType: AnalysisType | undefined
  ): Map<string, AnalysisType> | undefined {
    if (!expectedType || isUnknownType(expectedType)) {
      return undefined;
    }
    const contextualExpectedType = this.contextualObjectLiteralExpectedType(expectedType);
    if (!contextualExpectedType || isUnknownType(contextualExpectedType)) {
      return undefined;
    }
    if (contextualExpectedType.kind === "object") {
      return new Map(Object.entries(contextualExpectedType.properties));
    }
    if (contextualExpectedType.kind === "named") {
      return this.resolveNamedTypeMembers(contextualExpectedType) ?? undefined;
    }
    if (contextualExpectedType.kind === "intersection") {
      let merged: Map<string, AnalysisType> | undefined;
      for (const member of contextualExpectedType.types) {
        const memberProperties = this.expectedObjectProperties(member);
        if (!memberProperties) {
          continue;
        }
        if (!merged) {
          merged = new Map(memberProperties);
          continue;
        }
        for (const [name, type] of memberProperties) {
          const existing = merged.get(name);
          merged.set(name, existing ? intersectionType([existing, type]) : type);
        }
      }
      return merged;
    }
    if (contextualExpectedType.kind === "union") {
      const memberPropertyMaps = contextualExpectedType.types
        .map((member) => this.expectedObjectProperties(member))
        .filter((member): member is Map<string, AnalysisType> => member !== undefined);
      if (memberPropertyMaps.length === 0) {
        return undefined;
      }
      const combined = new Map<string, AnalysisType[]>();
      for (const properties of memberPropertyMaps) {
        for (const [name, type] of properties) {
          const existing = combined.get(name);
          if (existing) {
            existing.push(type);
          } else {
            combined.set(name, [type]);
          }
        }
      }
      const merged = new Map<string, AnalysisType>();
      for (const [name, types] of combined) {
        merged.set(name, types.length === 1 ? types[0]! : unionType(types));
      }
      return merged;
    }
    return undefined;
  }

  private expectedObjectLiteralAllowsAdditionalProperties(expectedType: AnalysisType | undefined): boolean {
    if (!expectedType || isUnknownType(expectedType)) {
      return true;
    }
    const contextualExpectedType = this.contextualObjectLiteralExpectedType(expectedType);
    if (!contextualExpectedType || isUnknownType(contextualExpectedType)) {
      return true;
    }
    return this.typeAllowsAdditionalObjectProperties(contextualExpectedType);
  }

  private canReportUnknownObjectLiteralProperties(expectedType: AnalysisType | undefined): boolean {
    if (!expectedType || isUnknownType(expectedType)) {
      return false;
    }
    const contextualExpectedType = this.contextualObjectLiteralExpectedType(expectedType);
    if (!contextualExpectedType || isUnknownType(contextualExpectedType)) {
      return false;
    }
    return this.typeHasCompleteKnownObjectShape(contextualExpectedType);
  }

  private typeHasCompleteKnownObjectShape(type: AnalysisType): boolean {
    if (isUnknownType(type)) {
      return false;
    }
    if (type.kind === "object") {
      return !this.objectPropertiesHaveDynamicKeys(type.properties);
    }
    if (type.kind === "builtin") {
      return false;
    }
    if (type.kind === "named") {
      const normalized = this.normalizeLooseNamedType(type);
      if (normalized !== type) {
        return this.typeHasCompleteKnownObjectShape(normalized);
      }
      return this.namedTypeHasCompleteKnownObjectShape(type, new Set<string>());
    }
    if (type.kind === "intersection" || type.kind === "union") {
      return type.types.every((member) => this.typeHasCompleteKnownObjectShape(member));
    }
    return false;
  }

  private namedTypeHasCompleteKnownObjectShape(
    type: AnalysisType & { kind: "named" },
    visited: Set<string>
  ): boolean {
    const visitKey = typeToString(type);
    if (visited.has(visitKey)) {
      return true;
    }
    visited.add(visitKey);

    const interfaceStatement = this.interfaceStatementsByName.get(type.name);
    if (interfaceStatement) {
      const substitutions = this.typeParameterSubstitutions(interfaceStatement.typeParameters ?? [], type);
      for (const parentType of interfaceStatement.extendsTypes ?? []) {
        const resolvedParent = this.substituteTypeParameters(
          this.typeFromTypeNameLoose(parentType.name),
          substitutions
        );
        if (resolvedParent.kind !== "named") {
          continue;
        }
        if (!this.namedTypeHasCompleteKnownObjectShape(resolvedParent, visited)) {
          return false;
        }
      }
      return true;
    }

    const classStatement = this.classStatementsByName.get(type.name);
    if (classStatement) {
      const substitutions = this.typeParameterSubstitutions(classStatement.typeParameters ?? [], type);
      if (classStatement.extendsType) {
        const resolvedParent = this.substituteTypeParameters(
          this.typeFromTypeNameLoose(classStatement.extendsType.name),
          substitutions
        );
        if (resolvedParent.kind === "named" && !this.namedTypeHasCompleteKnownObjectShape(resolvedParent, visited)) {
          return false;
        }
      }
      for (const implementedType of classStatement.implementsTypes ?? []) {
        const resolvedInterface = this.substituteTypeParameters(
          this.typeFromTypeNameLoose(implementedType.name),
          substitutions
        );
        if (resolvedInterface.kind === "named" && !this.namedTypeHasCompleteKnownObjectShape(resolvedInterface, visited)) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  private typeAllowsAdditionalObjectProperties(type: AnalysisType): boolean {
    if (isUnknownType(type)) {
      return true;
    }
    if (type.kind === "builtin") {
      return type.name === "any" || type.name === "unknown" || type.name === "object";
    }
    if (type.kind === "object") {
      return this.objectPropertiesHaveDynamicKeys(type.properties);
    }
    if (type.kind === "named") {
      if (this.objectTypeTextHasDynamicProperties(type.name)) {
        return true;
      }
      const normalized = this.normalizeLooseNamedType(type);
      return normalized !== type
        ? this.typeAllowsAdditionalObjectProperties(normalized)
        : false;
    }
    if (type.kind === "intersection" || type.kind === "union") {
      return type.types.some((member) => this.typeAllowsAdditionalObjectProperties(member));
    }
    return false;
  }

  private objectTypeTextHasDynamicProperties(typeName: string): boolean {
    const trimmed = stripEnclosingTypeParens(typeName);
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return false;
    }
    const body = trimmed.slice(1, -1).trim();
    if (body.length === 0) {
      return false;
    }
    return splitTopLevelDelimitedTypeText(body, new Set([",", ";"])).some((part) => {
      const member = part.trim();
      return member.startsWith("[") || member.startsWith("readonly [");
    });
  }

  private objectPropertiesHaveDynamicKeys(properties: Record<string, AnalysisType>): boolean {
    return Object.keys(properties).some((propertyName) => {
      const trimmed = propertyName.trim();
      return trimmed.startsWith("[") || trimmed.startsWith("readonly [");
    });
  }

  private propagateIteratorType(
    iterator: ForStatement["iterator"],
    iteratorType: AnalysisType,
    scope: Scope
  ): void {
    if (!iterator || isUnknownType(iteratorType)) {
      return;
    }

    if (iterator.kind === "Identifier") {
      this.updateResolvedSymbolType(
        scope,
        iterator as Node & { kind: "Identifier"; name: string },
        iteratorType
      );
      return;
    }

    if (iterator.kind !== "VarStatement") {
      return;
    }

    const varStatement = iterator as VarStatement;
    if (varStatement.declarations && varStatement.declarations.length > 0) {
      for (const declaration of varStatement.declarations) {
        this.updateBindingSymbolTypes(scope, declaration.name, iteratorType);
      }
      return;
    }

    this.updateBindingSymbolTypes(scope, varStatement.name, iteratorType);
  }

  private collectNamespaceStatements(statements: readonly Statement[], nameSet?: Set<string>): void {
    const visit = (statements: readonly Statement[]): void => {
      for (const statement of statements) {
        const candidate = statement.kind === "ExportStatement" ? (statement as ExportStatement).declaration : statement;
        if (candidate?.kind !== "NamespaceStatement") continue;
        const namespaceStatement = candidate as NamespaceStatement;
        if (!namespaceStatement.globalAugmentation) {
          const name = namespaceStatement.names?.[0]?.name;
          if (name) {
            nameSet?.add(name);
            const existing = this.namespaceStatementsByName.get(name);
            if (!existing) {
              this.namespaceStatementsByName.set(name, namespaceStatement);
            } else {
              this.namespaceStatementsByName.set(name, {
                ...existing,
                body: {
                  ...existing.body,
                  body: [...existing.body.body, ...namespaceStatement.body.body]
                }
              });
            }
          }
        }
        visit(namespaceStatement.body.body);
      }
    };
    visit(statements);
  }

  /**
   * Recursively collects all declarations nested inside namespace bodies from
   * the given statement list. Used to make types declared inside namespaces
   * (e.g. `interface Moment` inside `namespace moment`) available for member
   * resolution when referenced as plain named types.
   */
  private collectNestedNamespaceDeclarations(statements: readonly Statement[]): Statement[] {
    return declarationIndexForStatements(statements).nestedNamespaceDeclarations;
  }

  private collectFunctionStatements(statements: readonly Statement[]): void {
    for (const functionStatement of declarationIndexForStatements(statements).functions) {
      if (!functionStatement.receiverType) {
        this.functionStatementsByName.set(functionStatement.name.name, functionStatement);
      }
    }
  }

  private collectClassStatements(
    statements: readonly Statement[],
    nameSet?: Set<string>,
    namespacePrefix = ""
  ): void {
    for (const statement of statements) {
      const candidate = statement.kind === "ExportStatement"
        ? (statement as ExportStatement).declaration
        : statement;
      if (!candidate) {
        continue;
      }
      if (candidate.kind === "NamespaceStatement") {
        const namespaceStatement = candidate as NamespaceStatement;
        const namespaceName = namespaceStatement.names?.[0]?.name;
        this.collectClassStatements(
          namespaceStatement.body.body,
          nameSet,
          namespaceName
            ? namespacePrefix
              ? `${namespacePrefix}.${namespaceName}`
              : namespaceName
            : namespacePrefix
        );
        continue;
      }
      if (candidate.kind !== "ClassStatement") {
        continue;
      }
      const classStatement = candidate as ClassStatement;
      const qualifiedName = namespacePrefix
        ? `${namespacePrefix}.${classStatement.name.name}`
        : classStatement.name.name;
      nameSet?.add(qualifiedName);
      this.classStatementsByName.set(qualifiedName, classStatement);
    }
  }


  private collectImportedExtensionPropertyNames(program: Program): void {
    for (const statement of program.body) {
      if (statement.kind !== "ImportStatement") continue;
      for (const specifier of (statement as ImportStatement).specifiers) {
        const localName = (specifier.local ?? specifier.imported).name;
        this.importedExtensionPropertyNames.add(localName);
        const importedType = this.bound.rootScope.symbols.get(localName)?.type;
        if (importedType) {
          this.importedExtensionPropertyTypes.set(localName, importedType);
        }
      }
    }
  }

  private collectImportedBindingNames(program: Program): void {
    for (const statement of program.body) {
      if (statement.kind !== "ImportStatement") continue;
      const importStatement = statement as ImportStatement;
      if (importStatement.defaultImport) {
        this.importedBindingNames.add(importStatement.defaultImport.name);
      }
      if (importStatement.namespaceImport) {
        this.importedBindingNames.add(importStatement.namespaceImport.name);
      }
      for (const specifier of importStatement.specifiers) {
        this.importedBindingNames.add((specifier.local ?? specifier.imported).name);
      }
    }
  }

  private collectExtensionProperties(statements: readonly Statement[], fallbackScope: Scope): void {
    for (const statement of declarationIndexForStatements(statements).vars) {
      if (!statement.receiverType) continue;
      const receiverType = statement.receiverType;
      const typeParameterNames = statement.typeParameters?.map((parameter) => parameter.name.name) ?? [];
      this.withTypeParameters(typeParameterNames, () => {
        const extensionScope = this.scopeFor(statement, fallbackScope);
        const propertyType = this.resolveTypeAnnotation(statement.typeAnnotation, extensionScope)
          ?? this.inferExternalExtensionPropertyType(statement.initializer);
        const propertyName = bindingIdentifiers(statement.name)[0]?.name;
        if (!propertyName) return;
        this.setExtensionProperty(
          receiverType,
          statement.receiverTypeArguments,
          propertyName,
          propertyType,
          typeParameterNames
        );
      }, this.typeParameterConstraintMap(statement.typeParameters ?? [], fallbackScope));
    }
  }

  private setExtensionProperty(
    receiverType: Identifier,
    receiverTypeArguments: Identifier[] | undefined,
    propertyName: string,
    propertyType: AnalysisType,
    typeParameterNames: string[]
  ): void {
    const properties = this.extensionPropertiesByReceiver.get(receiverType.name) ?? new Map<string, ExtensionPropertyInfo>();
    const info: ExtensionPropertyInfo = {
      type: propertyType,
      typeParameterNames
    };
    if (receiverTypeArguments && receiverTypeArguments.length > 0) {
      info.receiverTypeArguments = receiverTypeArguments;
    }
    properties.set(propertyName, info);
    this.extensionPropertiesByReceiver.set(receiverType.name, properties);
  }

  private inferExternalExtensionPropertyType(initializer: Expr | undefined): AnalysisType {
    if (!initializer) {
      return UNKNOWN_TYPE;
    }
    if (initializer.kind === "CallExpression") {
      const call = initializer as CallExpression;
      if (call.callee.kind === "Identifier") {
        return this.typeFromTypeNameLoose((call.callee as Identifier).name);
      }
    }
    return UNKNOWN_TYPE;
  }

  private extensionReceiverNames(objectType: AnalysisType): string[] {
    const receiverNames: string[] = [];
    const addReceiverName = (name: string): void => {
      if (!receiverNames.includes(name)) {
        receiverNames.push(name);
      }
    };
    if (objectType.kind === "builtin") {
      addReceiverName(objectType.name);
      if (objectType.name === "int") addReceiverName("number");
    } else if (objectType.kind === "named") {
      this.collectExtensionReceiverNamesForNamedType(objectType.name, receiverNames, new Set<string>());
    } else if (objectType.kind === "array" || objectType.kind === "tuple") {
      addReceiverName("Array");
    }
    return receiverNames;
  }

  private collectExtensionReceiverNamesForNamedType(
    typeName: string,
    receiverNames: string[],
    visited: Set<string>
  ): void {
    const normalizedTypeName = parseTypeNameShape(typeName).baseName;
    if (visited.has(normalizedTypeName)) {
      return;
    }
    visited.add(normalizedTypeName);
    if (!receiverNames.includes(normalizedTypeName)) {
      receiverNames.push(normalizedTypeName);
    }

    const classStatement = this.classStatementsByName.get(normalizedTypeName);
    if (classStatement) {
      if (classStatement.extendsType) {
        this.collectExtensionReceiverNamesForNamedType(classStatement.extendsType.name, receiverNames, visited);
      }
      for (const implementedType of classStatement.implementsTypes ?? []) {
        this.collectExtensionReceiverNamesForNamedType(implementedType.name, receiverNames, visited);
      }
    }

    const interfaceStatement = this.interfaceStatementsByName.get(normalizedTypeName);
    if (!interfaceStatement) {
      return;
    }
    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      this.collectExtensionReceiverNamesForNamedType(parentType.name, receiverNames, visited);
    }
  }

  private resolveExtensionPropertyType(objectType: AnalysisType, propertyName: string): AnalysisType | null {
    const receiverNames = this.extensionReceiverNames(objectType);
    for (const receiverName of receiverNames) {
      const property = this.extensionPropertiesByReceiver.get(receiverName)?.get(propertyName);
      if (property) {
        return this.specializeExtensionPropertyType(objectType, receiverName, property);
      }
    }
    return null;
  }

  private specializeExtensionPropertyType(
    objectType: AnalysisType,
    receiverName: string,
    property: ExtensionPropertyInfo
  ): AnalysisType {
    if (property.typeParameterNames.length === 0 || !property.receiverTypeArguments) {
      return property.type;
    }
    const receiverTypeArguments = this.extensionReceiverTypeArguments(objectType, receiverName);
    if (receiverTypeArguments.length === 0) {
      return property.type;
    }

    const localTypeParameterNames = new Set(property.typeParameterNames);
    const substitutions = new Map<string, AnalysisType>();
    for (let index = 0; index < property.receiverTypeArguments.length; index += 1) {
      const receiverArgument = property.receiverTypeArguments[index];
      if (!receiverArgument || !localTypeParameterNames.has(receiverArgument.name)) {
        continue;
      }
      substitutions.set(receiverArgument.name, receiverTypeArguments[index] ?? namedType(receiverArgument.name));
    }
    return substitutions.size > 0
      ? this.substituteTypeParameters(property.type, substitutions)
      : property.type;
  }

  private extensionReceiverTypeArguments(objectType: AnalysisType, receiverName: string): AnalysisType[] {
    if (objectType.kind === "array" && receiverName === "Array") {
      return [objectType.elementType];
    }
    if (objectType.kind === "tuple" && receiverName === "Array") {
      if (objectType.elements.length === 0) {
        return [UNKNOWN_TYPE];
      }
      return [objectType.elements.length === 1 ? objectType.elements[0]! : combineTypes(objectType.elements)];
    }
    if (objectType.kind === "named" && objectType.name === receiverName) {
      return objectType.typeArguments ?? [];
    }
    return [];
  }


  private resolveExtensionMemberType(objectType: AnalysisType, memberName: string): AnalysisType | null {
    const propertyType = this.resolveExtensionPropertyType(objectType, memberName);
    if (propertyType) {
      return propertyType;
    }
    const receiverNames = this.extensionReceiverNames(objectType);
    for (const receiverName of receiverNames) {
      const methodType = this.extensionMethodsByReceiver.get(receiverName)?.get(memberName);
      if (methodType) return methodType;
    }
    return null;
  }

  private collectExtensionMethods(statements: readonly Statement[] | Program): void {
    const body = "body" in statements ? statements.body : statements;
    for (const extension of declarationIndexForStatements(body).functions) {
      if (!extension.receiverType || extension.operator) continue;
      const methods = this.extensionMethodsByReceiver.get(extension.receiverType.name) ?? new Map<string, AnalysisType>();
      methods.set(extension.name.name, functionType(
        extension.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        this.typeFromAnnotationLoose(extension.returnType, extension.receiverType.name) ?? UNKNOWN_TYPE,
        extension.typeParameters?.map((parameter) => parameter.name.name)
      ));
      this.extensionMethodsByReceiver.set(extension.receiverType.name, methods);
    }
  }


  private collectExtensionOperators(statements: readonly Statement[] | Program): void {
    const body = "body" in statements ? statements.body : statements;
    for (const extension of declarationIndexForStatements(body).functions) {
      if (!extension.receiverType || !extension.operator) {
        continue;
      }
      const receiverName = extension.receiverType.name;
      const existing = this.extensionOperatorsByReceiver.get(receiverName);
      if (existing) {
        existing.push(extension);
        continue;
      }
      this.extensionOperatorsByReceiver.set(receiverName, [extension]);
    }
  }


  private collectEnumStatements(statements: readonly Statement[], nameSet?: Set<string>): void {
    for (const enumStatement of declarationIndexForStatements(statements).enums) {
      nameSet?.add(enumStatement.name.name);
      this.enumStatementsByName.set(enumStatement.name.name, enumStatement);
    }
  }

  private collectInterfaceStatements(
    statements: readonly Statement[],
    nameSet?: Set<string>,
    namespacePrefix = ""
  ): void {
    for (const statement of statements) {
      const candidate = statement.kind === "ExportStatement"
        ? (statement as ExportStatement).declaration
        : statement;
      if (!candidate) {
        continue;
      }
      if (candidate.kind === "NamespaceStatement") {
        const namespaceStatement = candidate as NamespaceStatement;
        const namespaceName = namespaceStatement.names?.[0]?.name;
        this.collectInterfaceStatements(
          namespaceStatement.body.body,
          nameSet,
          namespaceName
            ? namespacePrefix
              ? `${namespacePrefix}.${namespaceName}`
              : namespaceName
            : namespacePrefix
        );
        continue;
      }
      if (candidate.kind !== "InterfaceStatement") {
        continue;
      }
      const interfaceStatement = candidate as InterfaceStatement;
      const qualifiedName = namespacePrefix
        ? `${namespacePrefix}.${interfaceStatement.name.name}`
        : interfaceStatement.name.name;
      nameSet?.add(qualifiedName);
      const existing = this.interfaceStatementsByName.get(qualifiedName);
      if (!existing) {
        this.interfaceStatementsByName.set(qualifiedName, interfaceStatement);
        continue;
      }
      const merged: InterfaceStatement = {
        ...existing,
        members: [...existing.members, ...interfaceStatement.members],
      };
      const existingTypeParameters = existing.typeParameters;
      const incomingTypeParameters = interfaceStatement.typeParameters;
      const mergedTypeParameters =
        existingTypeParameters && existingTypeParameters.length > 0
          ? existingTypeParameters
          : incomingTypeParameters && incomingTypeParameters.length > 0
            ? incomingTypeParameters
            : existingTypeParameters ?? incomingTypeParameters;
      if (mergedTypeParameters) {
        merged.typeParameters = mergedTypeParameters;
      }
      const mergedExtendsTypes = [
        ...(existing.extendsTypes ?? []),
        ...(interfaceStatement.extendsTypes ?? [])
      ];
      if (mergedExtendsTypes.length > 0) {
        merged.extendsTypes = mergedExtendsTypes;
      }
      this.interfaceStatementsByName.set(qualifiedName, merged);
    }
  }

  private collectTypeAliasStatements(statements: readonly Statement[], nameSet?: Set<string>): void {
    for (const typeAliasStatement of declarationIndexForStatements(statements).typeAliases) {
      nameSet?.add(typeAliasStatement.name.name);
      this.typeAliasStatementsByName.set(typeAliasStatement.name.name, typeAliasStatement);
    }
  }

  private collectVarStatements(
    statements: readonly Statement[],
    _nameSet?: Set<string>,
    namespacePrefix = ""
  ): void {
    for (const statement of statements) {
      const candidate = statement.kind === "ExportStatement"
        ? (statement as ExportStatement).declaration
        : statement;
      if (!candidate) {
        continue;
      }
      if (candidate.kind === "NamespaceStatement") {
        const namespaceStatement = candidate as NamespaceStatement;
        const namespaceName = namespaceStatement.names?.[0]?.name;
        this.collectVarStatements(
          namespaceStatement.body.body,
          _nameSet,
          namespaceName
            ? namespacePrefix
              ? `${namespacePrefix}.${namespaceName}`
              : namespaceName
            : namespacePrefix
        );
        continue;
      }
      if (candidate.kind !== "VarStatement" || (candidate as VarStatement).receiverType) {
        continue;
      }
      const varStatement = candidate as VarStatement;
      const variableName = bindingIdentifiers(varStatement.name)[0]?.name;
      if (!variableName) {
        continue;
      }
      const qualifiedName = namespacePrefix
        ? `${namespacePrefix}.${variableName}`
        : variableName;
      this.varStatementsByName.set(qualifiedName, varStatement);
    }
  }

  private removeRuntimeDeclarationsShadowedByImports(program: Program): void {
    for (const statement of program.body) {
      if (statement.kind !== "ImportStatement") {
        continue;
      }
      const importStatement = statement as ImportStatement;
      const importedNames = importStatement.specifiers.map((specifier) =>
        (specifier.local ?? specifier.imported).name
      );
      if (importStatement.defaultImport) {
        importedNames.push(importStatement.defaultImport.name);
      }
      if (importStatement.namespaceImport) {
        importedNames.push(importStatement.namespaceImport.name);
      }
      for (const name of importedNames) {
        this.classStatementsByName.delete(name);
        this.enumStatementsByName.delete(name);
        this.interfaceStatementsByName.delete(name);
        this.typeAliasStatementsByName.delete(name);
        this.varStatementsByName.delete(name);
        this.namedTypeMembersCache.delete(name);
      }
    }
  }

  private resolveOptionalAccessType(type: AnalysisType, optional: boolean): AnalysisType {
    if (!optional || isUnknownType(type) || (type.kind === "builtin" && type.name === "any")) {
      return type;
    }
    if (type.kind === "union" && type.types.some((member) => member.kind === "builtin" && member.name === "undefined")) {
      return type;
    }
    return unionType([type, builtinType("undefined")]);
  }

  private validateNullableMemberAccess(member: MemberExpression, objectType: AnalysisType): void {
    if (member.optional === true || member.nonNullAsserted === true || !hasNullishUnionMember(objectType)) {
      return;
    }
    const objectLastToken = member.object.lastToken;
    const propertyFirstToken = member.property.firstToken;
    const range =
      objectLastToken && propertyFirstToken
        ? {
            start: {
              line: objectLastToken.range.end.line,
              character: objectLastToken.range.end.column
            },
            end: {
              line: objectLastToken.range.end.line,
              character: Math.min(propertyFirstToken.range.start.column, objectLastToken.range.end.column + 1)
            }
          }
        : null;
    this.issues.push({
      message: "Object is possibly 'null' or 'undefined'. Use optional access '?.' or a non-null assertion '!'",
      node: member.property,
      ...(range ? { range } : {})
    });
  }

  private validateKnownMemberAccess(member: MemberExpression, objectType: AnalysisType, scope: Scope): void {
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }

    const propertyName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    const resolvedObjectType = this.resolveConstrainedNamedExpressionType(member.object, objectType) ?? objectType;
    if (isUnknownType(resolvedObjectType) || (resolvedObjectType.kind === "builtin" && resolvedObjectType.name === "unknown")) {
      if (member.object.kind === "Identifier") {
        const baseIdentifier = member.object as Identifier;
        const usageOffset = baseIdentifier.firstToken?.range.start.offset;
        const symbol = this.resolve(baseIdentifier.name, scope, usageOffset);
        if (!symbol || !this.explicitlyUnknownIdentifiers.has(symbol.node)) {
          return;
        }
      }
      this.issues.push({
        message: `Property '${propertyName}' does not exist on type 'unknown'`,
        node: member.property
      });
      return;
    }

    if (this.resolveExtensionMemberType(resolvedObjectType, propertyName) || this.importedExtensionPropertyNames.has(propertyName)) {
      return;
    }

    if (this.enumValueMemberAccessType(member, resolvedObjectType) !== null) {
      this.issues.push({
        message: `Property '${propertyName}' does not exist on type '${resolvedObjectType.kind === "named" ? resolvedObjectType.name : typeToString(resolvedObjectType)}'`,
        node: member.property
      });
      return;
    }

    const knownMembers = this.membersForType(resolvedObjectType);
    if (!knownMembers) {
      return;
    }
    if (knownMembers.has(propertyName)) {
      this.validateMemberVisibility(member, resolvedObjectType, propertyName, scope);
      if (
        resolvedObjectType.kind === "named" &&
        this.isSetterOnlyMember(resolvedObjectType.name, propertyName) &&
        !this.pureWriteTargetNodes.has(member)
      ) {
        this.issues.push({
          message: `Property '${propertyName}' on type '${resolvedObjectType.name}' has no getter`,
          node: member.property
        });
      }
      return;
    }

    if (this.memberTypeFromObjectType(resolvedObjectType, propertyName) !== null) {
      return;
    }

    const displayType = resolvedObjectType.kind === "named" ? resolvedObjectType.name : typeToString(resolvedObjectType);
    this.issues.push({
      message: `Property '${propertyName}' does not exist on type '${displayType}'`,
      node: member.property
    });
  }

  private resolveConstrainedNamedExpressionType(expression: Expr, type: AnalysisType): AnalysisType | null {
    if (type.kind === "union") {
      return unionType(type.types.map((member) => this.resolveConstrainedNamedExpressionType(expression, member) ?? member));
    }
    if (type.kind !== "named") {
      return null;
    }
    if (this.membersForType(type)) {
      return null;
    }
    const constrainedCall = this.constraintSourceCallExpression(expression);
    if (!constrainedCall) {
      return null;
    }
    const calleeType = this.expressionTypes.get(constrainedCall.callee);
    const constrained = this.constraintForNamedTypeParameter(calleeType, type.name);
    return constrained ?? null;
  }

  private constraintSourceCallExpression(expression: Expr): CallExpression | null {
    switch (expression.kind) {
      case "CallExpression":
        return expression as CallExpression;
      case "NonNullExpression":
        return this.constraintSourceCallExpression((expression as NonNullExpression).expression);
      case "AsExpression":
        return this.constraintSourceCallExpression((expression as AsExpression).expression);
      case "SatisfiesExpression":
        return this.constraintSourceCallExpression((expression as SatisfiesExpression).expression);
      default:
        return null;
    }
  }

  private constraintForNamedTypeParameter(
    calleeType: AnalysisType | undefined,
    typeParameterName: string
  ): AnalysisType | null {
    if (!calleeType) {
      return null;
    }
    if (calleeType.kind === "function") {
      return calleeType.typeParameterConstraints?.[typeParameterName] ?? null;
    }
    if (calleeType.kind === "union") {
      for (const member of calleeType.types) {
        if (member.kind !== "function") {
          continue;
        }
        const constraint = member.typeParameterConstraints?.[typeParameterName];
        if (constraint) {
          return constraint;
        }
      }
    }
    return null;
  }

  private validateMemberVisibility(member: MemberExpression, objectType: AnalysisType, propertyName: string, scope: Scope): void {
    if (objectType.kind !== "named") {
      return;
    }

    const classMember = this.findClassMember(objectType.name, propertyName);
    if (!classMember?.member.accessModifier || classMember.member.accessModifier === "public") {
      return;
    }

    const currentClassName = this.enclosingClassName(scope);
    if (classMember.member.accessModifier === "private") {
      if (currentClassName === classMember.declaringClassName) {
        return;
      }
      this.issues.push({
        message: `Member '${propertyName}' is private and can only be accessed within class '${classMember.declaringClassName}'`,
        node: member.property
      });
      return;
    }

    if (
      currentClassName === classMember.declaringClassName ||
      (currentClassName !== null && this.isClassDerivedFrom(currentClassName, classMember.declaringClassName))
    ) {
      return;
    }

    this.issues.push({
      message: `Member '${propertyName}' is protected and can only be accessed within class '${classMember.declaringClassName}' or its subclasses`,
      node: member.property
    });
  }

  private findClassMember(className: string, memberName: string): { member: ClassFieldMember | ClassMethodMember | FunctionParameter; declaringClassName: string } | null {
    const classStatement = this.classStatementsByName.get(className);
    if (!classStatement) {
      return null;
    }
    for (const member of classStatement.members) {
      if (member.name.name === memberName) {
        return { member, declaringClassName: className };
      }
      if (member.kind === "ClassMethodMember" && member.name.name === "constructor") {
        const parameterProperty = member.parameters.find(
          (parameter) => (parameter.accessModifier !== undefined || parameter.readonly === true) && bindingNameText(parameter.name) === memberName
        );
        if (parameterProperty) {
          return { member: parameterProperty, declaringClassName: className };
        }
      }
    }
    if (!classStatement.extendsType) {
      return null;
    }
    const extendsType = this.typeFromTypeNameLoose(classStatement.extendsType.name);
    if (extendsType.kind !== "named") {
      return null;
    }
    return this.findClassMember(extendsType.name, memberName);
  }

  private enclosingClassName(scope: Scope): string | null {
    let current: Scope | undefined = scope;
    while (current) {
      if (current.node.kind === "ClassStatement") {
        return (current.node as ClassStatement).name.name;
      }
      current = current.parent;
    }
    return null;
  }

  private classNameForMember(member: ClassMethodMember): string | undefined {
    for (const classStatement of this.classStatementsByName.values()) {
      if (classStatement.members.includes(member)) {
        return classStatement.name.name;
      }
    }
    return undefined;
  }

  private isClassDerivedFrom(className: string, baseClassName: string): boolean {
    let current = this.classStatementsByName.get(className);
    const visited = new Set<string>();
    while (current?.extendsType) {
      const extendsType = this.typeFromTypeNameLoose(current.extendsType.name);
      if (extendsType.kind !== "named" || visited.has(extendsType.name)) {
        return false;
      }
      if (extendsType.name === baseClassName) {
        return true;
      }
      visited.add(extendsType.name);
      current = this.classStatementsByName.get(extendsType.name);
    }
    return false;
  }

  private resolveKnownMemberType(member: MemberExpression, objectType: AnalysisType): AnalysisType | null {
    if (member.computed || member.property.kind !== "Identifier") {
      return null;
    }

    const resolvedObjectType = this.resolveConstrainedNamedExpressionType(member.object, objectType) ?? objectType;
    if (resolvedObjectType.kind === "builtin" && resolvedObjectType.name === "any") {
      return resolvedObjectType;
    }
    const memberName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    const extensionType = this.resolveExtensionMemberType(resolvedObjectType, memberName);
    if (extensionType) {
      return extensionType;
    }
    const importedExtensionPropertyType = this.importedExtensionPropertyTypes.get(memberName);
    if (importedExtensionPropertyType) {
      return importedExtensionPropertyType;
    }
    if (this.importedExtensionPropertyNames.has(memberName)) {
      return UNKNOWN_TYPE;
    }
    if (this.enumValueMemberAccessType(member, resolvedObjectType) !== null) {
      return null;
    }
    if (resolvedObjectType.kind === "union") {
      if (resolvedObjectType.types.some((type) => type.kind === "builtin" && type.name === "any")) {
        return builtinType("any");
      }
      const memberTypes = resolvedObjectType.types
        .filter((type) => !isNullishType(type))
        .map((type) => this.resolveKnownMemberType(member, type))
        .filter((type): type is AnalysisType => type !== null);
      if (memberTypes.length === 0) {
        return null;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (resolvedObjectType.kind === "intersection") {
      const memberTypes = resolvedObjectType.types
        .map((type) => this.resolveKnownMemberType(member, type))
        .filter((type): type is AnalysisType => type !== null);
      if (memberTypes.length === 0) {
        return null;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (resolvedObjectType.kind === "object") {
      return resolvedObjectType.properties[memberName] ?? null;
    }
    if (resolvedObjectType.kind === "array") {
      const arrayMembers = this.membersForArrayAlias(resolvedObjectType);
      if (!arrayMembers) {
        return null;
      }
      return arrayMembers.get(memberName) ?? null;
    }
    if (resolvedObjectType.kind === "builtin") {
      const boxedName = boxedInterfaceNameForBuiltin(resolvedObjectType.name);
      if (!boxedName) {
        return null;
      }
      const boxedMembers = this.resolveNamedTypeMembers(namedType(boxedName));
      return boxedMembers?.get(memberName) ?? null;
    }
    if (resolvedObjectType.kind === "literal") {
      const boxedName = boxedInterfaceNameForBuiltin(resolvedObjectType.base);
      if (!boxedName) {
        return null;
      }
      const boxedMembers = this.resolveNamedTypeMembers(namedType(boxedName));
      return boxedMembers?.get(memberName) ?? null;
    }
    if (resolvedObjectType.kind !== "named") {
      return null;
    }

    const classMembers = this.resolveNamedTypeMembers(resolvedObjectType);
    if (!classMembers) {
      return null;
    }
    return classMembers.get(memberName) ?? null;
  }

  private enumValueMemberAccessType(member: MemberExpression, objectType: AnalysisType): AnalysisType | null {
    if (objectType.kind !== "named" || member.computed || member.property.kind !== "Identifier") {
      return null;
    }
    if (!this.enumStatementsByName.has(objectType.name)) {
      return null;
    }
    if (member.object.kind !== "Identifier") {
      return objectType;
    }
    const symbol = this.resolve(
      (member.object as Identifier).name,
      this.bound.rootScope,
      (member.object as Identifier).firstToken?.range.start.offset
    );
    if (this.importedBindingNames.has((member.object as Identifier).name)) {
      return null;
    }
    return symbol?.kind === "class" ? null : objectType;
  }

  private resolveKnownMemberSymbol(member: MemberExpression, objectType: AnalysisType): AnalysisSymbol | null {
    if (member.computed || member.property.kind !== "Identifier") {
      return null;
    }

    const resolvedObjectType = this.resolveConstrainedNamedExpressionType(member.object, objectType) ?? objectType;
    const memberName = (member.property as Node & { kind: "Identifier"; name: string }).name;

    if (resolvedObjectType.kind === "union") {
      for (const type of resolvedObjectType.types) {
        if (isNullishType(type)) {
          continue;
        }
        const symbol = this.resolveKnownMemberSymbol(member, type);
        if (symbol) {
          return symbol;
        }
      }
      return null;
    }

    if (resolvedObjectType.kind === "intersection") {
      for (const type of resolvedObjectType.types) {
        const symbol = this.resolveKnownMemberSymbol(member, type);
        if (symbol) {
          return symbol;
        }
      }
      return null;
    }

    if (resolvedObjectType.kind !== "named") {
      if (resolvedObjectType.kind === "builtin") {
        const boxedName = boxedInterfaceNameForBuiltin(resolvedObjectType.name);
        return boxedName ? this.findNamedTypeMemberSymbol(boxedName, memberName) : null;
      }
      if (resolvedObjectType.kind === "literal") {
        const boxedName = boxedInterfaceNameForBuiltin(resolvedObjectType.base);
        return boxedName ? this.findNamedTypeMemberSymbol(boxedName, memberName) : null;
      }
      return null;
    }

    return this.findNamedTypeMemberSymbol(resolvedObjectType.name, memberName);
  }

  private findNamedTypeMemberSymbol(typeName: string, memberName: string, visited = new Set<string>()): AnalysisSymbol | null {
    const visitKey = `${typeName}.${memberName}`;
    if (visited.has(visitKey)) {
      return null;
    }
    visited.add(visitKey);

    const enumStatement = this.enumStatementsByName.get(typeName);
    if (enumStatement) {
      const enumScope = this.bound.scopeByNode.get(enumStatement);
      const enumSymbol = enumScope?.symbols.get(memberName);
      if (enumSymbol) {
        return enumSymbol;
      }
      if (enumStatement.members.some((member) => member.name.name === memberName)) {
        const enumType = namedType(enumStatement.name.name);
        return {
          name: memberName,
          kind: "variable",
          node: enumStatement.name,
          isReadonly: true,
          type: enumType,
          valueType: typeToString(enumType),
          declaredOffset: enumStatement.name.firstToken?.range.start.offset ?? -1
        };
      }
    }

    const classStatement = this.classStatementsByName.get(typeName);
    if (!classStatement) {
      return null;
    }

    const classScope = this.bound.scopeByNode.get(classStatement);
    const classSymbol = classScope?.symbols.get(memberName);
    if (classSymbol) {
      return classSymbol;
    }

    const mergedInterfaceSymbol = this.findInterfaceMemberSymbol(
      this.interfaceStatementsByName.get(typeName),
      memberName,
      visited
    );
    if (mergedInterfaceSymbol) {
      return mergedInterfaceSymbol;
    }

    if (classStatement.extendsType) {
      const extendsType = this.typeFromTypeNameLoose(classStatement.extendsType.name);
      if (extendsType.kind === "named") {
        const inheritedClassSymbol = this.findNamedTypeMemberSymbol(extendsType.name, memberName, visited);
        if (inheritedClassSymbol) {
          return inheritedClassSymbol;
        }
      }
    }

    for (const implementedType of this.implementedInterfaceTypesForClass(classStatement)) {
      const implementedSymbol = this.findNamedTypeMemberSymbol(implementedType.name, memberName, visited);
      if (implementedSymbol) {
        return implementedSymbol;
      }
    }

    return null;
  }

  private findInterfaceMemberSymbol(
    interfaceStatement: InterfaceStatement | undefined,
    memberName: string,
    visited: Set<string>
  ): AnalysisSymbol | null {
    if (!interfaceStatement) {
      return null;
    }

    for (const member of interfaceStatement.members) {
      if (member.name.name !== memberName) {
        continue;
      }
      return {
        name: memberName,
        kind: member.kind === "InterfaceMethodMember" ? "method" : "variable",
        node: member.name,
        declaredOffset: member.name.firstToken?.range.start.offset ?? -1
      };
    }

    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      const resolvedParentType = this.typeFromTypeNameLoose(parentType.name);
      if (resolvedParentType.kind !== "named") {
        continue;
      }
      const inheritedSymbol = this.findNamedTypeMemberSymbol(resolvedParentType.name, memberName, visited);
      if (inheritedSymbol) {
        return inheritedSymbol;
      }
    }

    return null;
  }

  private resolveComputedMemberType(objectType: AnalysisType, propertyType: AnalysisType): AnalysisType {
    if (objectType.kind === "builtin" && objectType.name === "any") {
      return objectType;
    }
    if (objectType.kind === "union") {
      if (objectType.types.some((type) => type.kind === "builtin" && type.name === "any")) {
        return builtinType("any");
      }
      const memberTypes = objectType.types
        .filter((type) => !isNullishType(type))
        .map((type) => this.resolveComputedMemberType(type, propertyType))
        .filter((type) => !isUnknownType(type));
      if (memberTypes.length === 0) {
        return UNKNOWN_TYPE;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (objectType.kind === "array" && isIntType(propertyType)) {
      return objectType.elementType;
    }
    if (objectType.kind === "range" && isIntType(propertyType)) {
      return objectType.elementType;
    }
    if (objectType.kind === "named") {
      const enumStatement = this.enumStatementsByName.get(objectType.name);
      if (!enumStatement) {
        return UNKNOWN_TYPE;
      }
      return this.resolveEnumComputedAccessType(enumStatement, undefined, propertyType);
    }
    return UNKNOWN_TYPE;
  }

  private resolveEnumComputedAccessType(
    enumStatement: EnumStatement,
    propertyExpression: Expr | undefined,
    propertyType: AnalysisType
  ): AnalysisType {
    if (propertyExpression?.kind === "IntLiteral") {
      return unionType([namedType(enumStatement.name.name), builtinType("undefined")]);
    }
    if (propertyExpression?.kind === "StringLiteral") {
      const value = (propertyExpression as StringLiteral).value;
      if (enumStatement.members.some((member) => member.name.name === value)) {
        return namedType(enumStatement.name.name);
      }
      if (enumStatement.members.some((member) => this.enumMemberStringValue(member) === value)) {
        return namedType(enumStatement.name.name);
      }
    }
    if (propertyType.kind === "named" && propertyType.name === enumStatement.name.name) {
      return this.enumUnderlyingValueType(enumStatement);
    }
    if (isIntType(propertyType)) {
      return unionType([namedType(enumStatement.name.name), builtinType("undefined")]);
    }
    if (isStringLikeType(propertyType)) {
      return enumStatement.members.some((member) => this.enumMemberStringValue(member) !== null)
        ? namedType(enumStatement.name.name)
        : builtinType("undefined");
    }
    return UNKNOWN_TYPE;
  }

  private enumUnderlyingValueType(enumStatement: EnumStatement): AnalysisType {
    const uniqueTypes: AnalysisType[] = [];
    for (const member of enumStatement.members) {
      const memberType = this.enumMemberValueType(member);
      if (!memberType) {
        continue;
      }
      if (!uniqueTypes.some((existing) => isSameType(existing, memberType))) {
        uniqueTypes.push(memberType);
      }
    }
    if (uniqueTypes.length === 0) {
      return UNKNOWN_TYPE;
    }
    return uniqueTypes.length === 1 ? uniqueTypes[0]! : unionType(uniqueTypes);
  }

  private enumUnderlyingValueTypeName(enumName: string): "int" | "string" | "mixed" | "unknown" {
    const enumStatement = this.enumStatementsByName.get(enumName);
    if (!enumStatement) {
      return "unknown";
    }
    const underlying = this.enumUnderlyingValueType(enumStatement);
    if (isIntType(underlying)) {
      return "int";
    }
    if (isStringLikeType(underlying)) {
      return "string";
    }
    return underlying.kind === "union" ? "mixed" : "unknown";
  }

  private enumMemberValueType(member: EnumMember): AnalysisType | null {
    const resolved = this.resolveEnumMemberValueByMember(member);
    if (resolved.kind === "constant-int" || resolved.kind === "computed-int") {
      return builtinType("int");
    }
    if (resolved.kind === "constant-string" || resolved.kind === "computed-string") {
      return builtinType("string");
    }
    return null;
  }

  private enumMemberStringValue(member: EnumMember): string | null {
    const resolved = this.resolveEnumMemberValueByMember(member);
    return resolved.kind === "constant-string" ? resolved.value : null;
  }

  private resolveEnumMemberValueByMember(member: EnumMember): EnumResolvedValue {
    const parentEnum = this.enumStatementForMember(member);
    return parentEnum ? this.resolveEnumMemberValue(parentEnum, member) : { kind: "invalid" };
  }

  private resolveEnumMemberValue(
    enumStatement: EnumStatement,
    member: EnumMember,
    visiting: Set<EnumMember> = new Set()
  ): EnumResolvedValue {
    const cached = this.enumMemberResolutionCache.get(member);
    if (cached) {
      return cached;
    }
    if (visiting.has(member)) {
      return { kind: "invalid" };
    }
    visiting.add(member);

    let resolved: EnumResolvedValue;
    if (!member.initializer) {
      const index = enumStatement.members.indexOf(member);
      if (index === 0) {
        resolved = { kind: "constant-int", value: 0 };
      } else {
        const previous = enumStatement.members[index - 1];
        const previousValue: EnumResolvedValue = previous
          ? this.resolveEnumMemberValue(enumStatement, previous, visiting)
          : { kind: "invalid" };
        resolved = previousValue.kind === "constant-int"
          ? { kind: "constant-int", value: previousValue.value + 1 }
          : { kind: "invalid" };
      }
    } else {
      resolved = this.resolveEnumInitializerValue(enumStatement, member.initializer, visiting);
    }

    visiting.delete(member);
    this.enumMemberResolutionCache.set(member, resolved);
    return resolved;
  }

  private resolveEnumInitializerValue(
    enumStatement: EnumStatement,
    expression: Expr,
    visiting: Set<EnumMember>
  ): EnumResolvedValue {
    switch (expression.kind) {
      case "IntLiteral":
        return { kind: "constant-int", value: (expression as IntLiteral).value };
      case "StringLiteral":
        return { kind: "constant-string", value: (expression as StringLiteral).value };
      case "UnaryExpression": {
        const unary = expression as UnaryExpression;
        const argument = this.resolveEnumInitializerValue(enumStatement, unary.argument, visiting);
        if (argument.kind !== "constant-int") {
          return this.enumComputedValueFromExpression(expression);
        }
        switch (unary.operator) {
          case "+":
            return { kind: "constant-int", value: +argument.value };
          case "-":
            return { kind: "constant-int", value: -argument.value };
          case "~":
            return { kind: "constant-int", value: ~argument.value };
          default:
            return this.enumComputedValueFromExpression(expression);
        }
      }
      case "BinaryExpression": {
        const binary = expression as BinaryExpression;
        const left = this.resolveEnumInitializerValue(enumStatement, binary.left, visiting);
        const right = this.resolveEnumInitializerValue(enumStatement, binary.right, visiting);
        const constant = this.foldConstantEnumBinary(binary.operator, left, right);
        return constant ?? this.enumComputedValueFromExpression(expression);
      }
      case "Identifier": {
        const memberRef = this.enumMemberNamed(enumStatement, (expression as Identifier).name);
        return memberRef ? this.resolveEnumMemberValue(enumStatement, memberRef, visiting) : this.enumComputedValueFromExpression(expression);
      }
      case "MemberExpression": {
        const memberExpression = expression as MemberExpression;
        if (memberExpression.computed || memberExpression.object.kind !== "Identifier" || memberExpression.property.kind !== "Identifier") {
          return this.enumComputedValueFromExpression(expression);
        }
        const targetEnum = this.enumStatementsByName.get((memberExpression.object as Identifier).name);
        const targetMember = targetEnum
          ? this.enumMemberNamed(targetEnum, (memberExpression.property as Identifier).name)
          : undefined;
        return targetEnum && targetMember
          ? this.resolveEnumMemberValue(targetEnum, targetMember, visiting)
          : this.enumComputedValueFromExpression(expression);
      }
      default:
        return this.enumComputedValueFromExpression(expression);
    }
  }

  private foldConstantEnumBinary(
    operator: BinaryExpression["operator"],
    left: EnumResolvedValue,
    right: EnumResolvedValue
  ): EnumResolvedValue | null {
    if (left.kind !== "constant-int" || right.kind !== "constant-int") {
      return null;
    }
    let value: number;
    switch (operator) {
      case "+":
        value = left.value + right.value;
        break;
      case "-":
        value = left.value - right.value;
        break;
      case "*":
        value = left.value * right.value;
        break;
      case "/":
        value = left.value / right.value;
        break;
      case "%":
        value = left.value % right.value;
        break;
      case "<<":
        value = left.value << right.value;
        break;
      case ">>":
        value = left.value >> right.value;
        break;
      case ">>>":
        value = left.value >>> right.value;
        break;
      case "&":
        value = left.value & right.value;
        break;
      case "|":
        value = left.value | right.value;
        break;
      case "^":
        value = left.value ^ right.value;
        break;
      default:
        return null;
    }
    return Number.isFinite(value) ? { kind: "constant-int", value } : { kind: "invalid" };
  }

  private enumComputedValueFromExpression(expression: Expr): EnumResolvedValue {
    const initializerType = this.expressionTypes.get(expression) ?? UNKNOWN_TYPE;
    if (isIntType(initializerType)) {
      return { kind: "computed-int" };
    }
    if (isStringLikeType(initializerType)) {
      return { kind: "computed-string" };
    }
    return { kind: "invalid" };
  }

  private enumStatementForMember(member: EnumMember): EnumStatement | null {
    for (const enumStatement of this.enumStatementsByName.values()) {
      if (enumStatement.members.includes(member)) {
        return enumStatement;
      }
    }
    return null;
  }

  private enumMemberNamed(enumStatement: EnumStatement, name: string): EnumMember | undefined {
    let memberMap = this.enumStatementMemberMapCache.get(enumStatement);
    if (!memberMap) {
      memberMap = new Map(enumStatement.members.map((member) => [member.name.name, member]));
      this.enumStatementMemberMapCache.set(enumStatement, memberMap);
    }
    return memberMap.get(name);
  }

  private membersForType(type: AnalysisType): Map<string, AnalysisType> | null {
    if (type.kind === "union") {
      const memberMaps: Map<string, AnalysisType>[] = [];
      for (const memberType of type.types.filter((member) => !isNullishType(member))) {
        const members = this.membersForType(memberType);
        if (!members) {
          return null;
        }
        memberMaps.push(members);
      }
      const allNames = new Set<string>();
      for (const members of memberMaps) {
        for (const memberName of members.keys()) {
          allNames.add(memberName);
        }
      }
      const merged = new Map<string, AnalysisType>();
      for (const memberName of allNames) {
        const variants = memberMaps.map((members) => members.get(memberName) ?? builtinType("undefined"));
        merged.set(memberName, combineTypes(variants));
      }
      return merged.size > 0 ? merged : null;
    }
    if (type.kind === "intersection") {
      const merged = new Map<string, AnalysisType>();
      for (const memberType of type.types) {
        const members = this.membersForType(memberType);
        if (!members) {
          continue;
        }
        for (const [memberName, memberValueType] of members.entries()) {
          const existing = merged.get(memberName);
          merged.set(memberName, existing ? combineTypes([existing, memberValueType]) : memberValueType);
        }
      }
      return merged.size > 0 ? merged : null;
    }
    if (type.kind === "object") {
      return new Map(Object.entries(type.properties));
    }
    if (type.kind === "array") {
      return this.membersForArrayAlias(type);
    }
    if (type.kind === "named") {
      return this.resolveNamedTypeMembers(type);
    }
    if (type.kind === "builtin" && type.name !== "any" && type.name !== "unknown") {
      const boxedName = boxedInterfaceNameForBuiltin(type.name);
      if (boxedName) {
        return this.resolveNamedTypeMembers(namedType(boxedName)) ?? new Map();
      }
      return new Map();
    }
    return null;
  }

  private membersForArrayAlias(type: AnalysisType & { kind: "array" }): Map<string, AnalysisType> | null {
    if (!this.classStatementsByName.has("Array") && !this.interfaceStatementsByName.has("Array")) {
      return null;
    }
    return this.resolveNamedTypeMembers(namedType("Array", [type.elementType]));
  }

  /** Returns the declared name of a statement, or null if it has none. */
  private declarationMemberName(statement: Statement): string | null {
    if (statement.kind === "FunctionStatement") return (statement as FunctionStatement).name?.name ?? null;
    if (statement.kind === "VarStatement") {
      const v = statement as VarStatement;
      const ids = v.declarations?.length
        ? v.declarations.flatMap((d) => bindingIdentifiers(d.name))
        : bindingIdentifiers(v.name);
      return ids[0]?.name ?? null;
    }
    if (statement.kind === "ClassStatement") return (statement as ClassStatement).name.name;
    if (statement.kind === "EnumStatement") return (statement as EnumStatement).name.name;
    if (statement.kind === "NamespaceStatement") return (statement as NamespaceStatement).names?.[0]?.name ?? null;
    if (statement.kind === "InterfaceStatement") return (statement as InterfaceStatement).name.name;
    return null;
  }

  /**
   * Derives the type of a named member from an exported declaration when there
   * is no bound scope available (e.g. namespace comes from an external .d.ts).
   * Falls back to UNKNOWN_TYPE for unrecognised patterns.
   */
  private memberTypeFromExternalDeclaration(declaration: Statement, memberName: string): AnalysisType {
    const candidate =
      declaration.kind === "ExportStatement"
        ? (declaration as ExportStatement).declaration
        : declaration;
    if (!candidate) return UNKNOWN_TYPE;

    if (candidate.kind === "FunctionStatement") {
      const fn = candidate as FunctionStatement;
      const typeParameterNames = (fn.typeParameters ?? []).map((parameter) => parameter.name.name);
      const availableTypeParameterNames = [...typeParameterNames];
      let functionMemberType: AnalysisType = functionType([], builtinType("void"));
      this.withTypeParameters(typeParameterNames, () => {
        const params = (fn.parameters ?? []).filter((parameter) => parameter.thisParameter !== true).map((p) => ({
          name: typeof p.name === "object" && "name" in p.name ? (p.name as { name: string }).name : memberName,
          type: this.typeFromAnnotationLooseWithTypeParameters(
            p.typeAnnotation,
            availableTypeParameterNames,
            fn.receiverType?.name
          ) ?? UNKNOWN_TYPE,
          optional: p.optional === true || p.defaultValue !== undefined || p.rest === true,
          rest: p.rest === true,
        }));
        functionMemberType = functionType(
          params,
          this.typeFromAnnotationLooseWithTypeParameters(
            fn.returnType,
            availableTypeParameterNames,
            fn.receiverType?.name
          ) ?? UNKNOWN_TYPE,
          typeParameterNames,
          this.typeParameterConstraintMapLoose(fn.typeParameters ?? [], availableTypeParameterNames),
          this.typeParameterDefaultMapLoose(fn.typeParameters ?? [], availableTypeParameterNames)
        );
      });
      return functionMemberType;
    }
    if (candidate.kind === "VarStatement") {
      const v = candidate as VarStatement;
      if (v.declarations?.length) {
        return this.typeFromAnnotationLoose(v.declarations[0]?.typeAnnotation) ?? this.typeFromAnnotationLoose(v.typeAnnotation) ?? UNKNOWN_TYPE;
      }
      return this.typeFromAnnotationLoose(v.typeAnnotation) ?? UNKNOWN_TYPE;
    }
    if (candidate.kind === "ClassStatement") {
      return namedType((candidate as ClassStatement).name.name);
    }
    if (candidate.kind === "NamespaceStatement") {
      const ns = candidate as NamespaceStatement;
      const name = ns.names?.[0]?.name;
      return name ? namedType(name) : UNKNOWN_TYPE;
    }
    if (candidate.kind === "EnumStatement") {
      return namedType((candidate as EnumStatement).name.name);
    }
    return UNKNOWN_TYPE;
  }

  private inferLooseInitializerType(initializer: Expr | undefined): AnalysisType | null {
    if (!initializer) {
      return null;
    }
    if (initializer.kind === "NewExpression" || initializer.kind === "CallExpression") {
      const callee = initializer.kind === "NewExpression"
        ? (initializer as NewExpression).callee
        : (initializer as CallExpression).callee;
      if (callee.kind === "Identifier") {
        const className = (callee as Identifier).name;
        if (this.classStatementsByName.has(className)) {
          return namedType(className);
        }
      }
    }
    return null;
  }

  private resolveNamedTypeMembers(type: AnalysisType & { kind: "named" }): Map<string, AnalysisType> | null {
    const cacheKey = typeToString(type);
    if (this.namedTypeMembersCache.has(cacheKey)) {
      return this.namedTypeMembersCache.get(cacheKey) ?? null;
    }
    if (this.resolvingNamedTypeMembers.has(cacheKey)) {
      return null;
    }

    this.resolvingNamedTypeMembers.add(cacheKey);
    try {
      const resolved = this.resolveNamedTypeMembersInternal(type, new Set<string>());
      this.namedTypeMembersCache.set(cacheKey, resolved);
      return resolved;
    } finally {
      this.resolvingNamedTypeMembers.delete(cacheKey);
    }
  }

  private addResolvedMemberType(
    members: Map<string, AnalysisType>,
    memberName: string,
    memberType: AnalysisType
  ): void {
    memberName = normalizePropertyName(memberName);
    const existing = members.get(memberName);
    if (!existing) {
      members.set(memberName, memberType);
      return;
    }
    if ((existing.kind === "function" || existing.kind === "union") && memberType.kind === "function") {
      const existingMembers = existing.kind === "union" ? existing.types : [existing];
      const callableMembers = existingMembers.filter((type): type is AnalysisType & { kind: "function" } => type.kind === "function");
      if (callableMembers.length === existingMembers.length) {
        members.set(memberName, unionType([...callableMembers, memberType]));
        return;
      }
    }
    if (existing.kind === "function" && memberType.kind === "function") {
      members.set(memberName, unionType([existing, memberType]));
      return;
    }
    members.set(memberName, memberType);
  }

  private collectInterfaceMembersInto(
    members: Map<string, AnalysisType>,
    interfaceStatement: InterfaceStatement,
    substitutions: Map<string, AnalysisType>,
    visited: Set<string>,
    preferExistingMembers: boolean
  ): void {
    for (const interfaceMember of interfaceStatement.members) {
      if (interfaceMember.kind === "InterfaceMethodMember" && interfaceMember.computed) {
        continue;
      }
      if (interfaceMember.kind === "InterfacePropertyMember") {
        const rawMemberType = this.typeFromAnnotationLoose(interfaceMember.typeAnnotation) ?? UNKNOWN_TYPE;
        const memberType = interfaceMember.optional === true
          ? unionType([rawMemberType, builtinType("undefined")])
          : rawMemberType;
        const resolvedMemberType = this.substituteTypeParameters(memberType, substitutions);
        if (!preferExistingMembers || !members.has(interfaceMember.name.name)) {
          this.addResolvedMemberType(members, interfaceMember.name.name, resolvedMemberType);
        }
        continue;
      }
      if (interfaceMember.accessorKind === "get") {
        const memberType = this.typeFromAnnotationLoose(interfaceMember.returnType, interfaceStatement.name.name) ?? UNKNOWN_TYPE;
        if (!preferExistingMembers || !members.has(interfaceMember.name.name)) {
          this.addResolvedMemberType(
            members,
            interfaceMember.name.name,
            this.substituteTypeParameters(memberType, substitutions)
          );
        }
        continue;
      }
      if (interfaceMember.accessorKind === "set") {
        const memberType = this.typeFromAnnotationLoose(interfaceMember.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
        if (members.has(interfaceMember.name.name)) {
          continue;
        }
        this.addResolvedMemberType(
          members,
          interfaceMember.name.name,
          this.substituteTypeParameters(memberType, substitutions)
        );
        continue;
      }

      const methodTypeParameterNames = (interfaceMember.typeParameters ?? []).map((parameter) => parameter.name.name);
      const availableTypeParameterNames = [...substitutions.keys(), ...methodTypeParameterNames];
      let methodType: AnalysisType = functionType([], builtinType("void"));
      this.withTypeParameters(methodTypeParameterNames, () => {
        methodType = functionType(
          interfaceMember.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
            name: bindingNameText(parameter.name),
            type: this.typeFromAnnotationLooseWithTypeParameters(
              parameter.typeAnnotation,
              availableTypeParameterNames,
              interfaceStatement.name.name
            ) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
          })),
          this.typeFromAnnotationLooseWithTypeParameters(
            interfaceMember.returnType,
            availableTypeParameterNames,
            interfaceStatement.name.name
          ) ?? builtinType("void"),
          methodTypeParameterNames,
          this.typeParameterConstraintMapLoose(interfaceMember.typeParameters ?? [], availableTypeParameterNames),
          this.typeParameterDefaultMapLoose(interfaceMember.typeParameters ?? [], availableTypeParameterNames)
        );
      });
      if (!preferExistingMembers || !members.has(interfaceMember.name.name)) {
        this.addResolvedMemberType(
          members,
          interfaceMember.name.name,
          this.substituteTypeParameters(methodType, substitutions)
        );
      }
    }

    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      const resolvedParentType = this.typeFromTypeNameLooseWithSubstitutions(parentType.name, substitutions);
      const parentMembers = resolvedParentType.kind === "named"
        ? this.resolveNamedTypeMembersInternal(resolvedParentType, visited)
        : this.membersForType(resolvedParentType);
      if (!parentMembers) {
        continue;
      }
      for (const [memberName, memberType] of parentMembers.entries()) {
        if (!preferExistingMembers || !members.has(memberName)) {
          members.set(memberName, memberType);
        }
      }
    }
  }

  private resolveNamedTypeMembersInternal(
    type: AnalysisType & { kind: "named" },
    visited: Set<string>
  ): Map<string, AnalysisType> | null {
    const visitKey = typeToString(type);
    if (visited.has(visitKey)) {
      return null;
    }
    visited.add(visitKey);

    const namespaceStatement = this.namespaceStatementsByName.get(type.name);
    if (namespaceStatement) {
      const scope = this.bound.scopeByNode.get(namespaceStatement);
      const members = new Map<string, AnalysisType>();
      for (const child of namespaceStatement.body.body) {
        if (scope) {
          // Local namespace with a bound scope: only exported members are visible.
          if (child.kind !== "ExportStatement") continue;
          const exported = child as ExportStatement;
          const names: string[] = [];
          if (exported.declaration?.kind === "VarStatement") {
            const variable = exported.declaration as VarStatement;
            if (variable.declarations?.length) {
              for (const declaration of variable.declarations) names.push(...bindingIdentifiers(declaration.name).map((identifier) => identifier.name));
            } else {
              names.push(...bindingIdentifiers(variable.name).map((identifier) => identifier.name));
            }
          } else if (exported.declaration?.kind === "FunctionStatement" || exported.declaration?.kind === "ClassStatement" || exported.declaration?.kind === "EnumStatement" || exported.declaration?.kind === "NamespaceStatement") {
            const declaration = exported.declaration as FunctionStatement | ClassStatement | EnumStatement | NamespaceStatement;
            names.push(declaration.kind === "NamespaceStatement" ? declaration.names?.[0]?.name ?? "" : declaration.name.name);
          }
          for (const specifier of exported.specifiers ?? []) names.push(specifier.exported.name);
          for (const name of names.filter(Boolean)) members.set(name, scope.symbols.get(name)?.type ?? UNKNOWN_TYPE);
        } else {
          // External namespace (e.g. from node_modules .d.ts): no bound scope.
          // In ambient .d.ts context all direct declarations are implicitly
          // accessible, so process both ExportStatement children and bare
          // declarations without requiring an explicit export keyword.
          const declaration =
            child.kind === "ExportStatement" ? (child as ExportStatement).declaration ?? child : child;
          const memberType = this.memberTypeFromExternalDeclaration(declaration, "");
          if (memberType.kind === "unknown") continue;
          const name = this.declarationMemberName(declaration);
          if (name) this.addResolvedMemberType(members, name, memberType);
          if (child.kind === "ExportStatement") {
            for (const specifier of (child as ExportStatement).specifiers ?? []) {
              this.addResolvedMemberType(members, specifier.exported.name, UNKNOWN_TYPE);
            }
          }
        }
      }
      return members;
    }

    const enumStatement = this.enumStatementsByName.get(type.name);
    if (enumStatement) {
      const members = new Map<string, AnalysisType>();
      for (const enumMember of enumStatement.members) {
        members.set(enumMember.name.name, namedType(enumStatement.name.name));
      }
      return members;
    }

    const classStatement = this.classStatementsByName.get(type.name);
    if (classStatement) {
      const substitutions = this.typeParameterSubstitutions(classStatement.typeParameters ?? [], type);
      const members = new Map<string, AnalysisType>();
      const readableNames = new Set<string>();
      const setterNames = new Set<string>();
      for (const parameter of classStatement.primaryConstructorParameters ?? []) {
        const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
        members.set(bindingNameText(parameter.name), this.substituteTypeParameters(parameterType, substitutions));
      }
      for (const constructor of classStatement.members.filter(
        (member): member is ClassMethodMember => member.kind === "ClassMethodMember" && member.name.name === "constructor"
      )) {
        for (const parameter of constructor.parameters.filter(
          (candidate) => candidate.accessModifier !== undefined || candidate.readonly === true
        )) {
          const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
          members.set(bindingNameText(parameter.name), this.substituteTypeParameters(parameterType, substitutions));
        }
      }

      for (const classMember of classStatement.members) {
        if (classMember.kind === "ClassMethodMember" && classMember.computed) {
          continue;
        }
        if (classMember.kind === "ClassFieldMember") {
          readableNames.add(classMember.name.name);
          let fieldType = this.typeFromAnnotationLoose(classMember.typeAnnotation);
          if (!fieldType) {
            const classScope = this.bound.scopeByNode.get(classStatement);
            fieldType = classScope?.symbols.get(classMember.name.name)?.type
              ?? this.inferLooseInitializerType(classMember.initializer)
              ?? UNKNOWN_TYPE;
          }
          members.set(
            classMember.name.name,
            this.substituteTypeParameters(fieldType, substitutions)
          );
          continue;
        }

        if (classMember.accessorKind === "get" || classMember.getterShorthand === true) {
          readableNames.add(classMember.name.name);
        } else if (classMember.accessorKind === "set") {
          setterNames.add(classMember.name.name);
        } else {
          readableNames.add(classMember.name.name);
        }

        const classScope = this.bound.scopeByNode.get(classStatement);
        const symbolType = classScope?.symbols.get(classMember.name.name)?.type;
        const methodTypeParameterNames = (classMember.typeParameters ?? []).map((parameter) => parameter.name.name);
        const availableTypeParameterNames = [...substitutions.keys(), ...methodTypeParameterNames];
        let rawReturnType: AnalysisType | undefined;
        this.withTypeParameters(methodTypeParameterNames, () => {
          rawReturnType = this.typeFromAnnotationLooseWithTypeParameters(
            classMember.returnType,
            availableTypeParameterNames,
            classStatement.name.name
          );
        });
        if (!rawReturnType && symbolType?.kind === "function") {
          rawReturnType = symbolType.returnType;
        }
        rawReturnType ??= builtinType("void");
        const returnType = isAsyncLike(classMember) && !this.getAsyncReturnValueType(rawReturnType)
          ? namedType("Promise", [rawReturnType])
          : rawReturnType;
        if (classMember.accessorKind === "get") {
          members.set(classMember.name.name, this.substituteTypeParameters(returnType, substitutions));
          continue;
        }
        if (classMember.accessorKind === "set") {
          let parameterType: AnalysisType = UNKNOWN_TYPE;
          this.withTypeParameters(methodTypeParameterNames, () => {
            parameterType = this.typeFromAnnotationLooseWithTypeParameters(
              classMember.parameters[0]?.typeAnnotation,
              availableTypeParameterNames,
              classStatement.name.name
            ) ?? UNKNOWN_TYPE;
          });
          members.set(classMember.name.name, this.substituteTypeParameters(parameterType, substitutions));
          continue;
        }
        let methodType: AnalysisType = functionType([], builtinType("void"));
        this.withTypeParameters(methodTypeParameterNames, () => {
          methodType = functionType(
            classMember.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
              name: bindingNameText(parameter.name),
              type: this.typeFromAnnotationLooseWithTypeParameters(
                parameter.typeAnnotation,
                availableTypeParameterNames,
                classStatement.name.name
              ) ?? UNKNOWN_TYPE,
              optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
              rest: parameter.rest === true
            })),
            returnType,
            methodTypeParameterNames,
            this.typeParameterConstraintMapLoose(classMember.typeParameters ?? [], availableTypeParameterNames),
            this.typeParameterDefaultMapLoose(classMember.typeParameters ?? [], availableTypeParameterNames)
          );
        });
        this.addResolvedMemberType(
          members,
          classMember.name.name,
          this.substituteTypeParameters(methodType, substitutions)
        );
      }

      for (const classDelegate of classStatement.classDelegates ?? []) {
        const delegateType = this.typeFromTypeNameLooseWithSubstitutions(classDelegate.typeAnnotation.name, substitutions);
        if (delegateType.kind !== "named") {
          continue;
        }
        const delegatedMembers = this.resolveNamedTypeMembersInternal(delegateType, visited);
        if (!delegatedMembers) {
          continue;
        }
        for (const [memberName, memberType] of delegatedMembers.entries()) {
          if (!members.has(memberName)) {
            members.set(memberName, memberType);
          }
        }
      }

      if (classStatement.extendsType) {
        const resolvedExtendsType = this.typeFromTypeNameLooseWithSubstitutions(classStatement.extendsType.name, substitutions);
        if (resolvedExtendsType.kind === "named" && this.classStatementsByName.has(resolvedExtendsType.name)) {
          const inheritedMembers = this.resolveNamedTypeMembersInternal(resolvedExtendsType, visited);
          if (inheritedMembers) {
            for (const [memberName, memberType] of inheritedMembers.entries()) {
              if (!members.has(memberName)) {
                members.set(memberName, memberType);
              }
            }
          }
        }
      }

      const mergedInterfaceStatement = this.interfaceStatementsByName.get(type.name);
      if (mergedInterfaceStatement) {
        this.collectInterfaceMembersInto(
          members,
          mergedInterfaceStatement,
          substitutions,
          visited,
          true
        );
      }

      const setterOnlyNames = new Set<string>();
      for (const name of setterNames) {
        if (!readableNames.has(name)) {
          setterOnlyNames.add(name);
        }
      }
      this.setterOnlyMembersCache.set(classStatement.name.name, setterOnlyNames);

      return members;
    }

    const typeAliasStatement = this.typeAliasStatementsByName.get(type.name);
    if (typeAliasStatement) {
      const aliasTarget = this.resolveTypeAliasTarget(
        typeAliasStatement,
        type.typeArguments ?? [],
        this.typeAliasResolutionScope(typeAliasStatement)
      );
      if (aliasTarget.kind === "named" && aliasTarget.name === type.name) {
        return null;
      }
      const aliasMembers = this.membersForType(aliasTarget);
      return aliasMembers ? new Map(aliasMembers) : null;
    }

    const members = new Map<string, AnalysisType>();
    const interfaceStatement = this.interfaceStatementsByName.get(type.name);
    if (!interfaceStatement) {
      return null;
    }
    const substitutions = this.typeParameterSubstitutions(interfaceStatement.typeParameters ?? [], type);
    this.collectInterfaceMembersInto(members, interfaceStatement, substitutions, visited, false);
    return members;
  }

  private implementedInterfaceTypesForClass(classStatement: ClassStatement): Array<AnalysisType & { kind: "named" }> {
    const implementedTypes: Array<AnalysisType & { kind: "named" }> = [];
    const seenInterfaceNames = new Set<string>();

    const addIfInterface = (typeName: Identifier | undefined): void => {
      if (!typeName) {
        return;
      }
      const resolvedType = this.typeFromTypeNameLoose(typeName.name);
      if (resolvedType.kind !== "named" || seenInterfaceNames.has(resolvedType.name)) {
        return;
      }
      if (!this.interfaceStatementsByName.has(resolvedType.name)) {
        return;
      }
      seenInterfaceNames.add(resolvedType.name);
      implementedTypes.push(resolvedType);
    };

    const resolvedExtendsType = classStatement.extendsType
      ? this.typeFromTypeNameLoose(classStatement.extendsType.name)
      : null;
    if (!resolvedExtendsType || resolvedExtendsType.kind !== "named" || !this.classStatementsByName.has(resolvedExtendsType.name)) {
      addIfInterface(classStatement.extendsType);
    }
    for (const implementedType of classStatement.implementsTypes ?? []) {
      addIfInterface(implementedType);
    }

    return implementedTypes;
  }

  private validateImplementedInterfaces(classStatement: ClassStatement): void {
    const classTypeArguments = (classStatement.typeParameters ?? []).map((typeParameter) =>
      namedType(typeParameter.name.name)
    );
    const classType = namedType(classStatement.name.name, classTypeArguments);
    const classMembers = this.resolveNamedTypeMembers(classType);
    if (!classMembers) {
      return;
    }

    for (const resolvedImplementedType of this.implementedInterfaceTypesForClass(classStatement)) {
      const interfaceStatement = this.interfaceStatementsByName.get(resolvedImplementedType.name);
      if (!interfaceStatement) {
        continue;
      }

      const interfaceMembers = this.resolveNamedTypeMembers(resolvedImplementedType);
      if (!interfaceMembers) {
        continue;
      }

      for (const [memberName, expectedType] of interfaceMembers.entries()) {
        const classMemberType = classMembers.get(memberName);
        if (!classMemberType) {
          this.issues.push({
            message: `Class '${classStatement.name.name}' incorrectly implements interface '${resolvedImplementedType.name}'. Property '${memberName}' is missing`,
            node: classStatement.name,
            code: ANALYSIS_ISSUE_CODES.IMPLEMENTS_MISSING_MEMBER,
            data: {
              className: classStatement.name.name,
              interfaceName: resolvedImplementedType.name,
              memberName
            }
          });
          continue;
        }

        if (this.isTypeAssignable(classMemberType, expectedType)) {
          continue;
        }

        const memberNode = this.findOwnClassMemberNameNode(classStatement, memberName);
        const actualType = typeToDiagnosticLabel(classMemberType);
        const expected = typeToDiagnosticLabel(expectedType);
        this.issues.push({
          message: `Class '${classStatement.name.name}' incorrectly implements interface '${resolvedImplementedType.name}'. Property '${memberName}' is of type '${actualType}' but expected '${expected}'`,
          node: memberNode ?? classStatement.name,
          code: ANALYSIS_ISSUE_CODES.IMPLEMENTS_INCOMPATIBLE_MEMBER,
          data: {
            className: classStatement.name.name,
            interfaceName: resolvedImplementedType.name,
            memberName,
            actualType,
            expectedType: expected
          }
        });
      }
    }
  }

  /**
   * Concrete (non-abstract) member names a class provides directly: primary
   * constructor properties, its own non-abstract members, and members supplied
   * through class delegates. Used to decide which inherited abstract members are
   * still unimplemented.
   */
  private collectConcreteMemberNames(classStatement: ClassStatement, names: Set<string>): void {
    for (const parameter of classStatement.primaryConstructorParameters ?? []) {
      const parameterName = bindingNameText(parameter.name);
      if (parameterName.length > 0) {
        names.add(parameterName);
      }
    }
    for (const member of classStatement.members) {
      if (member.abstract === true) {
        continue;
      }
      names.add(member.name.name);
    }
    for (const delegate of classStatement.classDelegates ?? []) {
      const delegateType = this.typeFromTypeNameLoose(delegate.typeAnnotation.name);
      if (delegateType.kind !== "named") {
        continue;
      }
      for (const memberName of this.resolveNamedTypeMembers(delegateType)?.keys() ?? []) {
        names.add(memberName);
      }
    }
  }

  /**
   * A concrete (non-abstract, non-ambient) class must implement every abstract
   * member it inherits from its abstract base-class chain. Interfaces are
   * validated separately by {@link validateImplementedInterfaces}; this only
   * walks the `extends` chain of classes.
   */
  private validateAbstractMemberImplementations(classStatement: ClassStatement): void {
    if (classStatement.abstract === true || classStatement.declared === true || !classStatement.extendsType) {
      return;
    }
    const baseType = this.typeFromTypeNameLoose(classStatement.extendsType.name);
    if (baseType.kind !== "named" || !this.classStatementsByName.has(baseType.name)) {
      // Extending an interface (or an unknown/ambient type) is not an abstract
      // class obligation and is handled elsewhere.
      return;
    }

    const concreteNames = new Set<string>();
    this.collectConcreteMemberNames(classStatement, concreteNames);

    const classTypeArguments = (classStatement.typeParameters ?? []).map((typeParameter) =>
      namedType(typeParameter.name.name)
    );
    const classType = namedType(classStatement.name.name, classTypeArguments);
    const classSubstitutions = this.typeParameterSubstitutions(classStatement.typeParameters ?? [], classType);
    const substitutedBaseType = this.substituteTypeParameters(baseType, classSubstitutions);
    const baseMembers = substitutedBaseType.kind === "named" ? this.resolveNamedTypeMembers(substitutedBaseType) : null;

    // Abstract obligations gathered from the base-class chain, keyed by member
    // name so each missing member is reported once. The value records the class
    // that declared the member abstract, for the diagnostic message.
    const abstractObligations = new Map<string, string>();
    const visited = new Set<string>();
    let current: ClassStatement | undefined = this.classStatementsByName.get(baseType.name);
    while (current && !visited.has(current.name.name)) {
      visited.add(current.name.name);
      this.collectConcreteMemberNames(current, concreteNames);
      if (current.declared !== true) {
        for (const member of current.members) {
          if (member.abstract === true && !abstractObligations.has(member.name.name)) {
            abstractObligations.set(member.name.name, current.name.name);
          }
        }
      }
      const parentType = current.extendsType ? this.typeFromTypeNameLoose(current.extendsType.name) : null;
      current = parentType?.kind === "named" ? this.classStatementsByName.get(parentType.name) : undefined;
    }

    for (const [memberName, baseClassName] of abstractObligations) {
      if (!concreteNames.has(memberName)) {
        this.issues.push({
          message: `Non-abstract class '${classStatement.name.name}' does not implement inherited abstract member '${memberName}' from class '${baseClassName}'`,
          node: classStatement.name,
          code: ANALYSIS_ISSUE_CODES.ABSTRACT_MEMBER_NOT_IMPLEMENTED,
          data: {
            className: classStatement.name.name,
            baseClassName,
            memberName
          }
        });
        continue;
      }

      // The member is implemented somewhere. When the current class implements it
      // directly without `override`, its signature must match the abstract
      // declaration. Members declared with `override` are signature-checked by
      // validateOverrideMembers; members supplied by a concrete ancestor were
      // checked when that ancestor was analysed.
      const ownMember = classStatement.members.find((member) => member.name.name === memberName);
      if (!ownMember || ownMember.override === true) {
        continue;
      }
      const expectedType = baseMembers?.get(memberName);
      const ownType = this.declaredClassMemberType(classStatement, memberName, classSubstitutions);
      if (expectedType && ownType && this.abstractMemberSignatureMismatches(ownType, expectedType)) {
        this.issues.push({
          message: `Class '${classStatement.name.name}' does not correctly implement abstract member '${memberName}' from class '${baseClassName}'. Expected signature '${typeToDiagnosticLabel(expectedType)}'`,
          node: ownMember.name,
          code: ANALYSIS_ISSUE_CODES.ABSTRACT_MEMBER_SIGNATURE_MISMATCH,
          data: {
            className: classStatement.name.name,
            baseClassName,
            memberName,
            expectedType: typeToDiagnosticLabel(expectedType)
          }
        });
      }
    }
  }

  /**
   * Whether a method implementing an abstract member drops a parameter the
   * abstract member requires. Trailing optional parameters may be omitted (so
   * `render()` validly implements `render(props?, state?, context?)`), but
   * dropping a required parameter such as `a: int` from `demo(a: int)` is a real
   * mismatch. Only method (function-typed) members are checked.
   */
  private abstractMemberSignatureMismatches(ownType: AnalysisType, expectedType: AnalysisType): boolean {
    if (ownType.kind !== "function" || expectedType.kind !== "function") {
      return false;
    }
    const requiredParameterCount = expectedType.parameters.filter(
      (parameter) => parameter.optional !== true && parameter.rest !== true
    ).length;
    return ownType.parameters.length < requiredParameterCount;
  }

  private findOwnClassMemberNameNode(
    classStatement: ClassStatement,
    memberName: string
  ): Identifier | null {
    for (const parameter of classStatement.primaryConstructorParameters ?? []) {
      if (bindingNameText(parameter.name) === memberName) {
        return parameter.name;
      }
    }
    for (const member of classStatement.members) {
      if (member.name.name === memberName) {
        return member.name;
      }
    }
    return null;
  }

  private declaredClassMemberType(
    classStatement: ClassStatement,
    memberName: string,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType | null {
    const classScope = this.bound.scopeByNode.get(classStatement);
    for (const classMember of classStatement.members) {
      if (classMember.name.name !== memberName) {
        continue;
      }

      if (classMember.kind === "ClassFieldMember") {
        const fieldType = this.typeFromAnnotationLoose(classMember.typeAnnotation) ?? UNKNOWN_TYPE;
        return this.substituteTypeParameters(fieldType, substitutions);
      }

      const symbolType = classScope?.symbols.get(classMember.name.name)?.type;
      const returnType =
        this.typeFromAnnotationLoose(classMember.returnType, classStatement.name.name) ??
        (symbolType?.kind === "function" ? symbolType.returnType : undefined) ??
        builtinType("void");
      if (classMember.accessorKind === "get") {
        return this.substituteTypeParameters(returnType, substitutions);
      }
      if (classMember.accessorKind === "set") {
        const parameterType = this.typeFromAnnotationLoose(classMember.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
        return this.substituteTypeParameters(parameterType, substitutions);
      }
      return this.substituteTypeParameters(functionType(
        classMember.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        returnType,
        classMember.typeParameters?.map((parameter) => parameter.name.name)
      ), substitutions);
    }

    return null;
  }

  /**
   * Shared resolution of a class's supertype members: the base-class member map
   * (including the inherited chain), the set of implemented-interface member
   * names, and whether the class has any supertype at all. Used by both the
   * `override`-keyword checks below.
   */
  private supertypeMemberContext(classStatement: ClassStatement): {
    classSubstitutions: Map<string, AnalysisType>;
    baseClassType: (AnalysisType & { kind: "named" }) | null;
    baseMembers: Map<string, AnalysisType> | null;
    interfaceMemberNames: Set<string>;
    hasSupertype: boolean;
  } {
    const classTypeArguments = (classStatement.typeParameters ?? []).map((typeParameter) =>
      namedType(typeParameter.name.name)
    );
    const classType = namedType(classStatement.name.name, classTypeArguments);
    const classSubstitutions = this.typeParameterSubstitutions(classStatement.typeParameters ?? [], classType);

    const resolvedExtends = classStatement.extendsType
      ? this.substituteTypeParameters(this.typeFromTypeNameLoose(classStatement.extendsType.name), classSubstitutions)
      : null;
    const baseClassType = resolvedExtends?.kind === "named" && this.classStatementsByName.has(resolvedExtends.name)
      ? resolvedExtends
      : null;
    const baseMembers = baseClassType ? this.resolveNamedTypeMembers(baseClassType) : null;

    const interfaceMemberNames = new Set<string>();
    for (const interfaceType of this.implementedInterfaceTypesForClass(classStatement)) {
      for (const memberName of this.resolveNamedTypeMembers(interfaceType)?.keys() ?? []) {
        interfaceMemberNames.add(memberName);
      }
    }

    const hasSupertype = resolvedExtends !== null || interfaceMemberNames.size > 0 || (classStatement.implementsTypes?.length ?? 0) > 0;
    return { classSubstitutions, baseClassType, baseMembers, interfaceMemberNames, hasSupertype };
  }

  private validateOverrideMembers(classStatement: ClassStatement): void {
    const overrideMembers = classStatement.members.filter((member) => member.override === true);
    if (overrideMembers.length === 0) {
      return;
    }

    // Interface members are valid `override` targets too. Their signatures are
    // validated by validateImplementedInterfaces, so here interfaces only
    // contribute the set of names that legitimize `override`.
    const { classSubstitutions, baseClassType, baseMembers, interfaceMemberNames, hasSupertype } =
      this.supertypeMemberContext(classStatement);

    for (const member of overrideMembers) {
      const baseType = baseMembers?.get(member.name.name);
      if (baseType) {
        const ownType = this.declaredClassMemberType(classStatement, member.name.name, classSubstitutions);
        if (ownType && !isSameType(ownType, baseType)) {
          this.issues.push({
            message: `Member '${member.name.name}' override type '${typeToDiagnosticLabel(ownType)}' does not match base type '${typeToDiagnosticLabel(baseType)}'`,
            node: member.name,
            code: ANALYSIS_ISSUE_CODES.OVERRIDE_INCOMPATIBLE_MEMBER,
            data: {
              className: classStatement.name.name,
              baseClassName: typeToString(baseClassType!),
              memberName: member.name.name,
              expectedType: typeToDiagnosticLabel(baseType)
            }
          });
        }
        continue;
      }

      if (interfaceMemberNames.has(member.name.name)) {
        // Valid override of an interface member; the interface conformance pass
        // checks its signature.
        continue;
      }

      // The member exists in no supertype.
      if (!hasSupertype) {
        this.issues.push({
          message: `Member '${member.name.name}' cannot use 'override' because class '${classStatement.name.name}' does not extend another class`,
          node: member.name
        });
      } else if (baseClassType && baseMembers) {
        this.issues.push({
          message: `Member '${member.name.name}' cannot override because no member with that name exists in base type '${typeToString(baseClassType)}'`,
          node: member.name
        });
      } else if (!baseClassType) {
        this.issues.push({
          message: `Member '${member.name.name}' cannot override because no member with that name exists in the base class or implemented interfaces`,
          node: member.name
        });
      }
      // If the base class members are unresolvable we cannot prove absence, so
      // we stay silent to avoid false positives.
    }
  }

  /**
   * A class may declare at most one `extends` clause and one `implements`
   * clause (the latter listing several interfaces separated by commas). Surplus
   * clauses parse successfully but are reported here.
   */
  private validateHeritageClauses(classStatement: ClassStatement): void {
    for (const extra of classStatement.extraExtendsTypes ?? []) {
      this.issues.push({
        message: "A class can only extend a single class",
        node: extra
      });
    }
    for (const extra of classStatement.extraImplementsTypes ?? []) {
      this.issues.push({
        message: "A class can only have one 'implements' clause; list multiple interfaces separated by commas",
        node: extra
      });
    }
  }

  private baseClassStatementOf(classStatement: ClassStatement): ClassStatement | undefined {
    if (!classStatement.extendsType) {
      return undefined;
    }
    const baseType = this.typeFromTypeNameLoose(classStatement.extendsType.name);
    return baseType.kind === "named" ? this.classStatementsByName.get(baseType.name) : undefined;
  }

  private collectProjectInterfaceMemberNames(interfaceName: string, names: Set<string>, visited: Set<string>): void {
    if (visited.has(interfaceName)) {
      return;
    }
    visited.add(interfaceName);
    const interfaceStatement = this.interfaceStatementsByName.get(interfaceName);
    if (!interfaceStatement || !this.programDeclaredTypeNodes.has(interfaceStatement)) {
      return;
    }
    for (const member of interfaceStatement.members) {
      names.add(member.name.name);
    }
    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      const resolved = this.typeFromTypeNameLoose(parentType.name);
      if (resolved.kind === "named") {
        this.collectProjectInterfaceMemberNames(resolved.name, names, visited);
      }
    }
  }

  /**
   * Member names contributed by the class's supertypes that are defined in the
   * project itself — non-`declared` base classes and interfaces. Members
   * inherited from ambient/imported (`declared`) types, such as node_modules
   * `.d.ts` classes, are excluded so conforming to external TypeScript APIs does
   * not require `override`.
   */
  private projectSupertypeMemberNames(classStatement: ClassStatement): Set<string> {
    const names = new Set<string>();
    const visitedClasses = new Set<string>();
    let current = this.baseClassStatementOf(classStatement);
    while (current && !visitedClasses.has(current.name.name)) {
      visitedClasses.add(current.name.name);
      if (this.programDeclaredTypeNodes.has(current)) {
        for (const member of current.members) {
          names.add(member.name.name);
        }
        for (const parameter of current.primaryConstructorParameters ?? []) {
          const parameterName = bindingNameText(parameter.name);
          if (parameterName.length > 0) {
            names.add(parameterName);
          }
        }
      }
      current = this.baseClassStatementOf(current);
    }
    const visitedInterfaces = new Set<string>();
    for (const interfaceType of this.implementedInterfaceTypesForClass(classStatement)) {
      this.collectProjectInterfaceMemberNames(interfaceType.name, names, visitedInterfaces);
    }
    return names;
  }

  /**
   * A class member that implements or redefines a member from a project
   * supertype (an abstract or concrete base-class member, or an interface
   * member) must be declared with `override`. Reports the missing modifier on
   * the member name. Only enforced for VexaScript sources; TypeScript-mode files
   * follow TypeScript rules where `override` is optional, and members conforming
   * to imported/ambient types are exempt.
   */
  private validateMissingOverrideModifiers(classStatement: ClassStatement): void {
    if (classStatement.declared === true || this.sourceLanguage === "typescript") {
      return;
    }
    const projectMemberNames = this.projectSupertypeMemberNames(classStatement);
    if (projectMemberNames.size === 0) {
      return;
    }
    for (const member of classStatement.members) {
      if (member.override === true || member.static === true || member.abstract === true) {
        continue;
      }
      if (member.kind === "ClassMethodMember" && (member.name.name === "constructor" || member.operator)) {
        continue;
      }
      if (projectMemberNames.has(member.name.name)) {
        this.issues.push({
          message: `Member '${member.name.name}' must be declared with 'override' because it overrides a member from a base class or interface`,
          node: member.name,
          code: ANALYSIS_ISSUE_CODES.MISSING_OVERRIDE_MODIFIER,
          data: {
            className: classStatement.name.name,
            memberName: member.name.name
          }
        });
      }
    }
  }

  private typeFromAnnotationLoose(
    typeAnnotation: (Node & { kind: "Identifier"; name: string }) | undefined,
    contextualThisTypeName?: string
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    const normalizedTypeName = typeAnnotation.name.trim();
    if (normalizedTypeName === "this" && contextualThisTypeName) {
      return this.typeFromTypeNameLoose(contextualThisTypeName);
    }
    const functionType = this.functionTypeFromAnnotationText(typeAnnotation.name);
    if (functionType) {
      return functionType;
    }
    const objectType = this.objectTypeFromAnnotationText(typeAnnotation.name);
    if (objectType) {
      return objectType;
    }
    const typeQueryType = this.typeFromTypeQueryNameLoose(typeAnnotation.name);
    if (typeQueryType) {
      return typeQueryType;
    }
    const computedType = this.typeFromComputedTypeNameLoose(typeAnnotation.name);
    if (computedType) {
      return computedType;
    }
    if (looksLikeFunctionTypeAnnotation(typeAnnotation.name)) {
      return UNKNOWN_TYPE;
    }

    const readonlyContainer = parseReadonlyContainerTypeText(normalizedTypeName);
    if (readonlyContainer?.kind === "tuple") {
      return tupleType(
        (readonlyContainer.tupleElementTypeTexts ?? []).map((part) => this.typeFromTypeNameLoose(part)),
        true
      );
    }
    if (readonlyContainer?.kind === "array" && readonlyContainer.elementTypeText) {
      return arrayType(this.typeFromTypeNameLoose(readonlyContainer.elementTypeText), true);
    }

    const optionalSuffix = splitOptionalTypeSuffix(normalizedTypeName);
    if (optionalSuffix.optional) {
      return unionType([
        this.typeFromTypeNameLoose(optionalSuffix.typeName),
        builtinType("undefined")
      ]);
    }

    const unionParts = splitTopLevelTypeText(normalizedTypeName, "|");
    if (unionParts.length > 1) {
      return unionType(unionParts.map((part) => this.typeFromTypeNameLoose(part)));
    }
    const intersectionParts = splitTopLevelTypeText(normalizedTypeName, "&");
    if (intersectionParts.length > 1) {
      return intersectionType(intersectionParts.map((part) => this.typeFromTypeNameLoose(part)));
    }
    if (normalizedTypeName.startsWith("[") && normalizedTypeName.endsWith("]")) {
      const tupleBody = normalizedTypeName.slice(1, -1).trim();
      return tupleType(
        tupleBody.length === 0
          ? []
          : splitTopLevelTypeText(tupleBody, ",").map((part) => this.typeFromTypeNameLoose(tupleElementTypeText(part)))
      );
    }

    const literal = resolveLiteralTypeName(normalizedTypeName);
    if (literal) {
      return literal;
    }
    const templateLiteralType = this.templateLiteralTypeFromText(normalizedTypeName);
    if (templateLiteralType) {
      return templateLiteralType;
    }

    const parsed = parseTypeNameShape(normalizedTypeName);
    let resolvedBase: AnalysisType;
    const specialResolved = this.resolveSpecialNamedTypeLoose(parsed.baseName, parsed.typeArguments);
    if (specialResolved) {
      resolvedBase = specialResolved;
    } else if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolvedBase = builtinType(
        parsed.baseName as BuiltinTypeName
      );
    } else {
      const normalizedBaseName = this.normalizeLooseNamedTypeReference(parsed.baseName);
      resolvedBase = namedType(
        normalizedBaseName,
        parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
      );
    }

    let resolved: AnalysisType = resolvedBase;
    for (let i = 0; i < parsed.arrayDepth; i += 1) {
      resolved = arrayType(resolved);
    }
    return this.expandTypeAliases(resolved);
  }

  private typeFromTypeNameLoose(typeName: string): AnalysisType {
    const normalizedTypeName = typeName.trim();
    const functionType = this.functionTypeFromAnnotationText(typeName);
    if (functionType) {
      return functionType;
    }
    const objectType = this.objectTypeFromAnnotationText(typeName);
    if (objectType) {
      return objectType;
    }
    const typeQueryType = this.typeFromTypeQueryNameLoose(typeName);
    if (typeQueryType) {
      return typeQueryType;
    }
    const computedType = this.typeFromComputedTypeNameLoose(typeName);
    if (computedType) {
      return computedType;
    }
    if (looksLikeFunctionTypeAnnotation(typeName)) {
      return UNKNOWN_TYPE;
    }

    const readonlyContainer = parseReadonlyContainerTypeText(normalizedTypeName);
    if (readonlyContainer?.kind === "tuple") {
      return tupleType(
        (readonlyContainer.tupleElementTypeTexts ?? []).map((part) => this.typeFromTypeNameLoose(part)),
        true
      );
    }
    if (readonlyContainer?.kind === "array" && readonlyContainer.elementTypeText) {
      return arrayType(this.typeFromTypeNameLoose(readonlyContainer.elementTypeText), true);
    }

    const optionalSuffix = splitOptionalTypeSuffix(normalizedTypeName);
    if (optionalSuffix.optional) {
      return unionType([
        this.typeFromTypeNameLoose(optionalSuffix.typeName),
        builtinType("undefined")
      ]);
    }

    const unionParts = splitTopLevelTypeText(normalizedTypeName, "|");
    if (unionParts.length > 1) {
      return unionType(unionParts.map((part) => this.typeFromTypeNameLoose(part)));
    }
    const intersectionParts = splitTopLevelTypeText(normalizedTypeName, "&");
    if (intersectionParts.length > 1) {
      return intersectionType(intersectionParts.map((part) => this.typeFromTypeNameLoose(part)));
    }
    if (normalizedTypeName.startsWith("[") && normalizedTypeName.endsWith("]")) {
      const tupleBody = normalizedTypeName.slice(1, -1).trim();
      return tupleType(
        tupleBody.length === 0
          ? []
          : splitTopLevelTypeText(tupleBody, ",").map((part) => this.typeFromTypeNameLoose(tupleElementTypeText(part)))
      );
    }

    const literal = resolveLiteralTypeName(normalizedTypeName);
    if (literal) {
      return literal;
    }
    const templateLiteralType = this.templateLiteralTypeFromText(normalizedTypeName);
    if (templateLiteralType) {
      return templateLiteralType;
    }

    const parsed = parseTypeNameShape(normalizedTypeName);
    let resolved: AnalysisType;
    const specialResolved = this.resolveSpecialNamedTypeLoose(parsed.baseName, parsed.typeArguments);
    if (specialResolved) {
      resolved = specialResolved;
    } else if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolved = builtinType(
        parsed.baseName as BuiltinTypeName
      );
    } else {
      const normalizedBaseName = this.normalizeLooseNamedTypeReference(parsed.baseName);
      resolved = namedType(
        normalizedBaseName,
        parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
      );
    }
    for (let i = 0; i < parsed.arrayDepth; i += 1) {
      resolved = arrayType(resolved);
    }
    return this.expandTypeAliases(resolved);
  }

  private typeFromTypeQueryNameLoose(typeName: string): AnalysisType | null {
    const normalizedTypeName = stripEnclosingTypeParens(typeName.trim());
    if (!normalizedTypeName.startsWith("typeof ")) {
      return null;
    }

    const path = normalizedTypeName.slice("typeof ".length).trim().split(".").filter((part) => part.length > 0);
    const baseName = path.shift();
    if (!baseName) {
      return UNKNOWN_TYPE;
    }

    const queryKey = `${baseName}.${path.join(".")}`;
    if (this.resolvingLooseTypeQueries.has(queryKey)) {
      return UNKNOWN_TYPE;
    }
    this.resolvingLooseTypeQueries.add(queryKey);
    try {
      let currentType = this.valueTypeFromLooseTypeQueryBase(baseName);
      if (!currentType) {
        return UNKNOWN_TYPE;
      }
      for (const memberName of path) {
        currentType = this.memberTypeFromObjectType(currentType, memberName) ?? UNKNOWN_TYPE;
        if (isUnknownType(currentType)) {
          return UNKNOWN_TYPE;
        }
      }
      return currentType;
    } finally {
      this.resolvingLooseTypeQueries.delete(queryKey);
    }
  }

  private valueTypeFromLooseTypeQueryBase(baseName: string): AnalysisType | null {
    const functionStatement = this.functionStatementsByName.get(baseName);
    if (functionStatement) {
      return this.memberTypeFromExternalDeclaration(functionStatement, baseName);
    }

    const varStatement = this.varStatementsByName.get(baseName);
    if (varStatement) {
      return this.typeFromAnnotationLoose(varStatement.declarations?.[0]?.typeAnnotation)
        ?? this.typeFromAnnotationLoose(varStatement.typeAnnotation)
        ?? UNKNOWN_TYPE;
    }

    if (this.classStatementsByName.has(baseName)) {
      return namedType(baseName);
    }
    if (this.enumStatementsByName.has(baseName)) {
      return namedType(baseName);
    }
    if (this.namespaceStatementsByName.has(baseName)) {
      return namedType(baseName);
    }

    return this.bound.rootScope.symbols.get(baseName)?.type ?? null;
  }

  private typeFromTypeNameLooseWithSubstitutions(
    typeName: string,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType {
    return this.typeFromTypeNameLoose(this.substituteTypeParametersInComputedName(typeName, substitutions));
  }

  private resolveSpecialNamedTypeLoose(baseName: string, typeArguments: string[]): AnalysisType | null {
    if (baseName === "ReactNode" || baseName === "React.ReactNode") {
      return unionType([
        namedType("JSX.Element"),
        namedType("ReactElement"),
        builtinType("string"),
        builtinType("number"),
        builtinType("boolean"),
        builtinType("null"),
        builtinType("undefined")
      ]);
    }
    if (["Exclude", "Extract", "NonNullable", "Readonly", "Record", "ReturnType", "Parameters", "ConstructorParameters", "InstanceType", "ThisParameterType", "OmitThisParameter", "Awaited", "NoInfer", "ThisType", "Uppercase", "Lowercase", "Capitalize", "Uncapitalize", "Omit", "OmitKeyof", "Pick", "Partial", "Required", "WithRequired"].includes(baseName) && typeArguments.length > 0) {
      const resolvedSpecial = this.resolveSpecialNamedType(
        baseName,
        typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
      );
      if (resolvedSpecial) {
        return resolvedSpecial;
      }
      const sourceType = this.typeFromTypeNameLoose(typeArguments[0]!);
      const sourceMembers = this.membersForType(sourceType);
      if (!sourceMembers) {
        return null;
      }
      const sourceProperties = Object.fromEntries(sourceMembers.entries());
      if (baseName === "Partial") {
        return objectTypeWithProperties(
          Object.fromEntries(
            Object.entries(sourceProperties).map(([name, type]) => [name, this.propertyTypeWithUndefined(type)])
          )
        );
      }
      if (baseName === "Required") {
        return objectTypeWithProperties(
          Object.fromEntries(
            Object.entries(sourceProperties).map(([name, type]) => [name, propertyTypeWithoutUndefined(type) ?? type])
          )
        );
      }
      if (typeArguments.length < 2) {
        return baseName === "WithRequired"
          ? objectTypeWithProperties(
              Object.fromEntries(
                Object.entries(sourceProperties).map(([name, type]) => [name, propertyTypeWithoutUndefined(type) ?? type])
              )
            )
          : null;
      }
      const selectedKeys = new Set(this.stringLiteralKeysFromType(this.typeFromTypeNameLoose(typeArguments[1]!)));
      if (baseName === "WithRequired") {
        return objectTypeWithProperties(
          Object.fromEntries(
            Object.entries(sourceProperties).map(([name, type]) => [
              name,
              selectedKeys.has(normalizePropertyName(name)) ? propertyTypeWithoutUndefined(type) ?? type : type
            ])
          )
        );
      }
      if (baseName === "Pick") {
        return objectTypeWithProperties(
          Object.fromEntries(Object.entries(sourceProperties).filter(([name]) => selectedKeys.has(normalizePropertyName(name))))
        );
      }
      return objectTypeWithProperties(
        Object.fromEntries(Object.entries(sourceProperties).filter(([name]) => !selectedKeys.has(normalizePropertyName(name))))
      );
    }
    if (baseName !== "ExtractRendererOptions" || typeArguments.length !== 1) {
      return null;
    }
    return this.resolveExtractRendererOptionsType(typeArguments[0]!);
  }

  private resolveSpecialNamedType(baseName: string, typeArguments: AnalysisType[]): AnalysisType | null {
    if (baseName === "Exclude" && typeArguments.length >= 2) {
      return this.filterUtilityTypeMembers(typeArguments[0]!, typeArguments[1]!, false);
    }
    if (baseName === "Extract" && typeArguments.length >= 2) {
      return this.filterUtilityTypeMembers(typeArguments[0]!, typeArguments[1]!, true);
    }
    if (baseName === "NonNullable") {
      return this.nonNullableUtilityType(typeArguments[0]!);
    }
    if (baseName === "Readonly") {
      if (typeArguments[0]!.kind === "array") {
        return arrayType(typeArguments[0]!.elementType, true);
      }
      if (typeArguments[0]!.kind === "tuple") {
        return tupleType(typeArguments[0]!.elements, true);
      }
      const readonlyMembers = this.membersForType(typeArguments[0]!);
      return readonlyMembers
        ? objectTypeWithProperties(
            Object.fromEntries(
              Array.from(readonlyMembers.entries()).map(([name, type]) => [toReadonlyPropertyName(name), type])
            )
          )
        : typeArguments[0]!;
    }
    if (baseName === "Record" && typeArguments.length >= 2) {
      return this.recordUtilityType(typeArguments[0]!, typeArguments[1]!);
    }
    if (baseName === "ReturnType") {
      return this.returnTypeUtilityType(typeArguments[0]!);
    }
    if (baseName === "Parameters") {
      return this.parametersUtilityType(typeArguments[0]!);
    }
    if (baseName === "ConstructorParameters") {
      return this.constructorParametersUtilityType(typeArguments[0]!);
    }
    if (baseName === "InstanceType") {
      return this.instanceTypeUtilityType(typeArguments[0]!);
    }
    if (baseName === "ThisParameterType") {
      return this.thisParameterTypeUtilityType(typeArguments[0]!);
    }
    if (baseName === "OmitThisParameter") {
      return this.omitThisParameterUtilityType(typeArguments[0]!);
    }
    if (baseName === "Awaited") {
      return this.awaitedUtilityType(typeArguments[0]!);
    }
    if (baseName === "NoInfer") {
      return typeArguments[0]!;
    }
    if (baseName === "ThisType") {
      return typeArguments[0]!;
    }
    if (baseName === "Uppercase") {
      return this.stringTransformUtilityType(typeArguments[0]!, (value) => value.toUpperCase());
    }
    if (baseName === "Lowercase") {
      return this.stringTransformUtilityType(typeArguments[0]!, (value) => value.toLowerCase());
    }
    if (baseName === "Capitalize") {
      return this.stringTransformUtilityType(
        typeArguments[0]!,
        (value) => value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
      );
    }
    if (baseName === "Uncapitalize") {
      return this.stringTransformUtilityType(
        typeArguments[0]!,
        (value) => value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1)
      );
    }
    return null;
  }

  private propertyTypeWithUndefined(type: AnalysisType): AnalysisType {
    return propertyTypeAllowsUndefined(type) ? type : unionType([type, builtinType("undefined")]);
  }

  private filterUtilityTypeMembers(
    sourceType: AnalysisType,
    targetType: AnalysisType,
    keepAssignable: boolean
  ): AnalysisType {
    if (sourceType.kind === "union") {
      const filtered = sourceType.types.filter((member) => this.isTypeAssignable(member, targetType) === keepAssignable);
      return combineTypes(filtered.length > 0 ? filtered : [builtinType("never")]);
    }
    return this.isTypeAssignable(sourceType, targetType) === keepAssignable
      ? sourceType
      : builtinType("never");
  }

  private nonNullableUtilityType(sourceType: AnalysisType): AnalysisType {
    if (sourceType.kind === "builtin" && (sourceType.name === "null" || sourceType.name === "undefined")) {
      return builtinType("never");
    }
    return removeNullishFromType(sourceType);
  }

  private recordUtilityType(keyType: AnalysisType, valueType: AnalysisType): AnalysisType {
    const properties: Record<string, AnalysisType> = {};
    for (const key of this.stringLiteralKeysFromType(keyType)) {
      properties[key] = valueType;
    }
    if (keyType.kind === "builtin" && (keyType.name === "string" || keyType.name === "number" || keyType.name === "symbol")) {
      properties[`[${keyType.name}]`] = valueType;
    }
    if (keyType.kind === "union") {
      for (const member of keyType.types) {
        if (member.kind === "builtin" && (member.name === "string" || member.name === "number" || member.name === "symbol")) {
          properties[`[${member.name}]`] = valueType;
        }
      }
    }
    return objectTypeWithProperties(properties);
  }

  private returnTypeUtilityType(sourceType: AnalysisType): AnalysisType | null {
    if (sourceType.kind === "function") {
      return sourceType.returnType;
    }
    if (sourceType.kind === "union") {
      const returnTypes = sourceType.types
        .filter((member): member is AnalysisType & { kind: "function" } => member.kind === "function")
        .map((member) => member.returnType);
      return returnTypes.length > 0 ? combineTypes(returnTypes) : null;
    }
    return null;
  }

  private parametersUtilityType(sourceType: AnalysisType): AnalysisType | null {
    if (sourceType.kind === "function") {
      return tupleType(sourceType.parameters.map((parameter) => parameter.type));
    }
    if (sourceType.kind === "union") {
      const tuples = sourceType.types
        .filter((member): member is AnalysisType & { kind: "function" } => member.kind === "function")
        .map((member) => tupleType(member.parameters.map((parameter) => parameter.type)));
      return tuples.length > 0 ? combineTypes(tuples) : null;
    }
    return null;
  }

  private awaitedUtilityType(sourceType: AnalysisType): AnalysisType {
    if (sourceType.kind === "union") {
      return combineTypes(sourceType.types.map((member) => this.awaitedUtilityType(member)));
    }
    if (sourceType.kind === "builtin" && (sourceType.name === "any" || sourceType.name === "unknown" || sourceType.name === "null" || sourceType.name === "undefined")) {
      return sourceType;
    }
    const unwrapped = unwrapPromiseType(sourceType)
      ?? (sourceType.kind === "named" && sourceType.name === "PromiseLike" ? sourceType.typeArguments?.[0] ?? UNKNOWN_TYPE : null);
    return unwrapped ? this.awaitedUtilityType(unwrapped) : sourceType;
  }

  private constructorParametersUtilityType(sourceType: AnalysisType): AnalysisType | null {
    const constructorType = this.constructSignatureForUtility(sourceType);
    return constructorType ? tupleType(constructorType.parameters.map((parameter) => parameter.type)) : null;
  }

  private instanceTypeUtilityType(sourceType: AnalysisType): AnalysisType | null {
    const constructorType = this.constructSignatureForUtility(sourceType);
    return constructorType?.returnType ?? null;
  }

  private thisParameterTypeUtilityType(sourceType: AnalysisType): AnalysisType {
    if (sourceType.kind === "union") {
      const thisTypes = sourceType.types.map((member) => this.thisParameterTypeUtilityType(member));
      return combineTypes(thisTypes);
    }
    if (sourceType.kind !== "function") {
      return UNKNOWN_TYPE;
    }
    const firstParameter = sourceType.parameters[0];
    return firstParameter?.name === "this" ? firstParameter.type : UNKNOWN_TYPE;
  }

  private omitThisParameterUtilityType(sourceType: AnalysisType): AnalysisType | null {
    if (sourceType.kind === "union") {
      const members = sourceType.types
        .map((member) => this.omitThisParameterUtilityType(member))
        .filter((member): member is AnalysisType => member !== null);
      return members.length > 0 ? combineTypes(members) : null;
    }
    if (sourceType.kind !== "function") {
      return null;
    }
    if (sourceType.parameters[0]?.name !== "this") {
      return sourceType;
    }
    return functionType(
      sourceType.parameters.slice(1),
      sourceType.returnType,
      sourceType.typeParameters,
      sourceType.typeParameterConstraints,
      sourceType.typeParameterDefaults
    );
  }

  private constructSignatureForUtility(sourceType: AnalysisType): (AnalysisType & { kind: "function" }) | null {
    if (sourceType.kind === "named") {
      const classStatement = this.classStatementsByName.get(sourceType.name);
      if (classStatement) {
        return this.classCallableTypeForNamedType(sourceType);
      }
    }
    return this.constructableTypeFrom(sourceType);
  }

  private stringTransformUtilityType(
    sourceType: AnalysisType,
    transform: (value: string) => string
  ): AnalysisType | null {
    if (sourceType.kind === "literal" && sourceType.base === "string") {
      return literalType("string", transform(String(sourceType.value)));
    }
    if (sourceType.kind === "builtin" && sourceType.name === "string") {
      return builtinType("string");
    }
    if (sourceType.kind === "union") {
      const members = sourceType.types
        .map((member) => this.stringTransformUtilityType(member, transform))
        .filter((member): member is AnalysisType => member !== null);
      return members.length > 0 ? combineTypes(members) : null;
    }
    return null;
  }

  private templateLiteralTypeFromText(typeName: string): AnalysisType | null {
    const segments = parseTemplateLiteralTypeText(typeName);
    if (!segments) {
      return null;
    }

    let variants = [""];
    for (const segment of segments) {
      if (segment.kind === "text") {
        variants = variants.map((variant) => variant + segment.value);
        continue;
      }

      const placeholderValues = this.stringifiableTemplateLiteralValues(
        this.typeFromTypeNameLoose(segment.value)
      );
      if (!placeholderValues) {
        return builtinType("string");
      }

      const nextVariants: string[] = [];
      for (const variant of variants) {
        for (const placeholderValue of placeholderValues) {
          nextVariants.push(variant + placeholderValue);
        }
      }
      variants = nextVariants;
    }

    return combineTypes(variants.map((variant) => literalType("string", variant)));
  }

  private stringifiableTemplateLiteralValues(type: AnalysisType): string[] | null {
    if (type.kind === "literal") {
      return [String(type.value)];
    }
    if (type.kind === "union") {
      const values: string[] = [];
      for (const member of type.types) {
        const memberValues = this.stringifiableTemplateLiteralValues(member);
        if (!memberValues) {
          return null;
        }
        values.push(...memberValues);
      }
      return values;
    }
    if (type.kind === "builtin" && (type.name === "string" || type.name === "number" || type.name === "boolean" || type.name === "bigint" || type.name === "long")) {
      return null;
    }
    return null;
  }

  private stringLiteralKeysFromType(type: AnalysisType): string[] {
    if (type.kind === "literal" && type.base === "string") {
      return [String(type.value)];
    }
    if (type.kind === "union") {
      return type.types.flatMap((member) => this.stringLiteralKeysFromType(member));
    }
    return [];
  }

  private normalizeLooseNamedTypeReference(baseName: string): string {
    if (!baseName.includes(".")) {
      return baseName;
    }
    if (
      this.classStatementsByName.has(baseName)
      || this.interfaceStatementsByName.has(baseName)
      || this.enumStatementsByName.has(baseName)
      || this.typeAliasStatementsByName.has(baseName)
      || this.namespaceStatementsByName.has(baseName)
    ) {
      return baseName;
    }
    const lastSegment = baseName.split(".").pop()?.trim();
    if (!lastSegment) {
      return baseName;
    }
    if (
      this.classStatementsByName.has(lastSegment)
      || this.interfaceStatementsByName.has(lastSegment)
      || this.enumStatementsByName.has(lastSegment)
      || this.typeAliasStatementsByName.has(lastSegment)
      || this.namespaceStatementsByName.has(lastSegment)
    ) {
      return lastSegment;
    }
    return baseName;
  }

  private resolveExtractRendererOptionsType(typeArgumentText: string): AnalysisType | null {
    const defaultOptionTypes = this.rendererSystemDefaultOptionTypes(typeArgumentText, new Set<string>());
    if (!defaultOptionTypes || defaultOptionTypes.length === 0) {
      return null;
    }
    return intersectionType(defaultOptionTypes);
  }

  private rendererSystemDefaultOptionTypes(typeQueryText: string, visited: Set<string>): AnalysisType[] | null {
    const systemListName = this.systemListNameFromTypeQuery(typeQueryText);
    if (!systemListName || visited.has(systemListName)) {
      return null;
    }
    visited.add(systemListName);

    const systemListDeclaration = this.varStatementsByName.get(systemListName);
    const systemListTypeAnnotation = systemListDeclaration?.typeAnnotation?.name;
    if (!systemListTypeAnnotation) {
      return null;
    }

    const normalizedListType = stripEnclosingTypeParens(systemListTypeAnnotation.trim());
    const arraySuffix = splitArraySuffixTypeName(normalizedListType);
    const unionSource = stripEnclosingTypeParens(arraySuffix?.elementTypeName ?? normalizedListType);
    const systemTypeQueries = splitTopLevelTypeText(unionSource, "|").map((part) => stripEnclosingTypeParens(part.trim()));

    const optionTypes: AnalysisType[] = [];
    for (const systemTypeQuery of systemTypeQueries) {
      const systemClassName = this.systemListNameFromTypeQuery(systemTypeQuery);
      if (!systemClassName) {
        continue;
      }
      const systemClass = this.classStatementsByName.get(systemClassName);
      const defaultOptionsMember = systemClass?.members.find((member): member is ClassFieldMember =>
        member.static === true &&
        member.kind === "ClassFieldMember" &&
        member.name.name === "defaultOptions"
      );
      const defaultOptionsType = defaultOptionsMember
        ? this.typeFromAnnotationLoose(defaultOptionsMember.typeAnnotation)
        : null;
      if (defaultOptionsType) {
        optionTypes.push(defaultOptionsType);
      }
    }

    return optionTypes.length > 0 ? optionTypes : null;
  }

  private systemListNameFromTypeQuery(typeQueryText: string): string | null {
    const normalized = stripEnclosingTypeParens(typeQueryText.trim());
    const directMatch = /^typeof\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/.exec(normalized);
    if (directMatch?.[1]) {
      return directMatch[1];
    }
    const importedMatch = /^typeof\s+import\([^)]*\)\.([A-Za-z_$][\w$]*)$/.exec(normalized);
    return importedMatch?.[1] ?? null;
  }

  private isTypeParameterName(name: string): boolean {
    return (
      !this.typeAliasStatementsByName.has(name) &&
      !this.interfaceStatementsByName.has(name) &&
      !this.classStatementsByName.has(name) &&
      !this.enumStatementsByName.has(name) &&
      !this.namespaceStatementsByName.has(name) &&
      !BUILTIN_TYPE_NAMES.has(name as BuiltinTypeName)
    );
  }

  private expandTypeAliases(type: AnalysisType): AnalysisType {
    if (type.kind === "named") {
      if (type.name === "Awaited" && (type.typeArguments?.length ?? 0) === 1) {
        const innerExpanded = this.expandTypeAliases(type.typeArguments![0]!);
        if (innerExpanded.kind === "named" && this.isTypeParameterName(innerExpanded.name) && (innerExpanded.typeArguments?.length ?? 0) === 0) {
          return namedType("Awaited", [innerExpanded]);
        }
        return this.evaluateAwaitedType(innerExpanded);
      }
      if (type.typeArguments && type.typeArguments.length > 0) {
        const expandedArguments = type.typeArguments.map((typeArgument) => this.expandTypeAliases(typeArgument));
        const specialResolved = this.resolveSpecialNamedType(type.name, expandedArguments);
        if (specialResolved) {
          return this.expandTypeAliases(specialResolved);
        }
      }
      const typeAlias = this.typeAliasStatementsByName.get(type.name);
      if (!typeAlias || this.activeTypeAliasNames.has(type.name)) {
        if (!type.typeArguments || type.typeArguments.length === 0) {
          return type;
        }
        return namedType(
          type.name,
          type.typeArguments.map((typeArgument) => this.expandTypeAliases(typeArgument))
        );
      }
      const substitutions = this.typeParameterSubstitutions(typeAlias.typeParameters ?? [], type);
      const mappedUtilityTarget = this.resolveMappedUtilityAliasTarget(typeAlias, substitutions);
      if (mappedUtilityTarget) {
        return this.expandTypeAliases(mappedUtilityTarget);
      }
      const conditionalTarget = this.resolveConditionalTypeAliasTarget(
        typeAlias,
        substitutions,
        this.typeAliasResolutionScope(typeAlias)
      );
      if (
        conditionalTarget &&
        !this.typeContainsUnresolvedNamedReference(
          conditionalTarget,
          this.typeAliasResolutionScope(typeAlias),
          new Set()
        )
      ) {
        return this.expandTypeAliases(conditionalTarget);
      }
      const typeParameterNames = (typeAlias.typeParameters ?? []).map((parameter) => parameter.name.name);
      this.activeTypeAliasNames.add(type.name);
      let targetType: AnalysisType = UNKNOWN_TYPE;
      this.withTypeParameters(typeParameterNames, () => {
        targetType = this.typeFromTypeNameLooseWithTypeParameters(
          typeAlias.targetType.name,
          new Set(typeParameterNames)
        ) ?? UNKNOWN_TYPE;
      });
      this.activeTypeAliasNames.delete(type.name);
      return this.expandTypeAliases(this.substituteTypeParameters(targetType, substitutions));
    }

    if (type.kind === "array") {
      return arrayType(this.expandTypeAliases(type.elementType), type.readonly === true);
    }

    if (type.kind === "range") {
      return rangeType(this.expandTypeAliases(type.elementType));
    }

    if (type.kind === "function") {
      return functionType(
        type.parameters.map((parameter) => ({
          name: parameter.name,
          type: this.expandTypeAliases(parameter.type),
          ...(parameter.optional !== undefined ? { optional: parameter.optional } : {})
        })),
        this.expandTypeAliases(type.returnType),
        type.typeParameters,
        type.typeParameterConstraints,
        undefined,
        type.assertion
          ? {
              target: type.assertion.target,
              ...(type.assertion.type ? { type: this.expandTypeAliases(type.assertion.type) } : {})
            }
          : undefined
      );
    }

    if (type.kind === "object") {
      const properties: Record<string, AnalysisType> = {};
      for (const [name, propertyType] of Object.entries(type.properties)) {
        properties[name] = this.expandTypeAliases(propertyType);
      }
      return objectTypeWithProperties(properties);
    }

    return type;
  }

  private typeParameterSubstitutions(
    typeParameters: Array<{ name: { name: string }; defaultType?: Identifier }>,
    type: AnalysisType & { kind: "named" }
  ): Map<string, AnalysisType> {
    const substitutions = new Map<string, AnalysisType>();
    const typeArguments = type.typeArguments ?? [];
    for (let i = 0; i < typeParameters.length; i += 1) {
      const typeParameter = typeParameters[i];
      const parameterName = typeParameter?.name.name;
      if (!parameterName) {
        continue;
      }
      substitutions.set(
        parameterName,
        typeArguments[i]
          ?? (typeParameter?.defaultType ? this.typeFromTypeNameLoose(typeParameter.defaultType.name) : namedType(parameterName))
      );
    }
    return substitutions;
  }

  private substituteTypeParameters(
    sourceType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType {
    if (sourceType.kind === "named") {
      if (!sourceType.typeArguments || sourceType.typeArguments.length === 0) {
        const directSubstitution = substitutions.get(sourceType.name);
        if (directSubstitution) {
          return directSubstitution;
        }
        const substitutedComputedName = this.substituteTypeParametersInComputedName(sourceType.name, substitutions);
        if (substitutedComputedName !== sourceType.name) {
          return this.typeFromTypeNameLoose(substitutedComputedName);
        }
        return sourceType;
      }
      if (sourceType.name === "Awaited" && sourceType.typeArguments.length === 1) {
        const inner = this.substituteTypeParameters(sourceType.typeArguments[0]!, substitutions);
        return this.evaluateAwaitedType(inner);
      }
      return namedType(
        sourceType.name,
        sourceType.typeArguments.map((typeArgument) =>
          this.substituteTypeParameters(typeArgument, substitutions)
        )
      );
    }

    if (sourceType.kind === "array") {
      return arrayType(this.substituteTypeParameters(sourceType.elementType, substitutions), sourceType.readonly === true);
    }

    if (sourceType.kind === "range") {
      return rangeType(this.substituteTypeParameters(sourceType.elementType, substitutions));
    }

    if (sourceType.kind === "object") {
      const substitutedProperties: Record<string, AnalysisType> = {};
      for (const [propertyName, propertyType] of Object.entries(sourceType.properties)) {
        substitutedProperties[propertyName] = this.substituteTypeParameters(propertyType, substitutions);
      }
      return objectTypeWithProperties(substitutedProperties);
    }

    if (sourceType.kind === "function") {
      const substitutedConstraints = sourceType.typeParameterConstraints
        ? Object.fromEntries(
          Object.entries(sourceType.typeParameterConstraints).map(([name, constraint]) => [
            name,
            this.substituteTypeParameters(constraint, substitutions)
          ])
        )
        : undefined;
      return functionType(
        sourceType.parameters.map((parameter) => ({
          name: parameter.name,
          type: this.substituteTypeParameters(parameter.type, substitutions),
          ...(parameter.optional !== undefined ? { optional: parameter.optional } : {}),
          ...(parameter.rest ? { rest: true } : {})
        })),
        this.substituteTypeParameters(sourceType.returnType, substitutions),
        sourceType.typeParameters,
        substitutedConstraints,
        sourceType.typeParameterDefaults
          ? Object.fromEntries(
              Object.entries(sourceType.typeParameterDefaults).map(([name, defaultType]) => [
                name,
                this.substituteTypeParameters(defaultType, substitutions)
              ])
            )
          : undefined,
        sourceType.assertion
          ? {
              target: sourceType.assertion.target,
              ...(sourceType.assertion.type
                ? { type: this.substituteTypeParameters(sourceType.assertion.type, substitutions) }
                : {})
            }
          : undefined
      );
    }

    if (sourceType.kind === "union") {
      return unionType(sourceType.types.map((type) => this.substituteTypeParameters(type, substitutions)));
    }

    if (sourceType.kind === "intersection") {
      return intersectionType(sourceType.types.map((type) => this.substituteTypeParameters(type, substitutions)));
    }

    if (sourceType.kind === "tuple") {
      return tupleType(
        sourceType.elements.map((element) => this.substituteTypeParameters(element, substitutions)),
        sourceType.readonly === true
      );
    }

    return sourceType;
  }

  private evaluateAwaitedType(inner: AnalysisType): AnalysisType {
    if (inner.kind === "named" && (inner.name === "Promise" || inner.name === "PromiseLike") && inner.typeArguments?.length === 1) {
      return inner.typeArguments[0]!;
    }
    return inner;
  }

  private substituteTypeParametersInComputedName(
    typeName: string,
    substitutions: Map<string, AnalysisType>
  ): string {
    let result = typeName;
    for (const [name, substitution] of substitutions.entries()) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`\\b${escapedName}\\b`, "g"), typeToString(substitution));
    }
    return result;
  }

  private resolveFunctionTypeAnnotation(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    const parsed = parseFunctionTypeAnnotation(typeName);
    if (!parsed) {
      return null;
    }
    return functionType(
      parsed.parameters.map((parameter) => ({
        name: parameter.name,
        type: this.resolveTypeNameText(parameter.typeName, node, scope, false),
        ...(parameter.optional ? { optional: true } : {}),
        ...(parameter.rest ? { rest: true } : {})
      })),
      this.resolveTypeNameText(parsed.returnTypeName, node, scope, false),
      undefined,
      undefined,
      undefined,
      this.assertionTypeFromText(parsed.returnTypeName, scope)
    );
  }

  private resolveObjectTypeAnnotation(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    const members = parseObjectTypeAnnotation(typeName);
    if (!members) {
      return null;
    }
    const properties: Record<string, AnalysisType> = {};
    for (const member of members) {
      const propertyType = this.resolveTypeNameText(member.typeName, node, scope, false);
      const propertyName = member.readonly ? toReadonlyPropertyName(member.name) : member.name;
      properties[propertyName] = member.optional
        ? unionType([propertyType, builtinType("undefined")])
        : propertyType;
    }
    return objectTypeWithProperties(properties);
  }

  private functionTypeFromAnnotationText(typeName: string): AnalysisType | null {
    const parsed = parseFunctionTypeAnnotation(stripEnclosingTypeParens(typeName.trim()));
    if (!parsed) {
      return null;
    }
    const parsedAssertion = parseAssertionTypePredicateText(parsed.returnTypeName);
    return functionType(
      parsed.parameters.map((parameter) => ({
        name: parameter.name,
        type: this.typeFromTypeNameLoose(parameter.typeName),
        ...(parameter.optional ? { optional: true } : {}),
        ...(parameter.rest ? { rest: true } : {})
      })),
      this.typeFromTypeNameLoose(parsed.returnTypeName),
      undefined,
      undefined,
      undefined,
      parsedAssertion
        ? {
            target: parsedAssertion.targetText,
            ...(parsedAssertion.assertedTypeText
              ? { type: this.typeFromTypeNameLoose(parsedAssertion.assertedTypeText) }
              : {})
          }
        : undefined
    );
  }

  private objectTypeFromAnnotationText(typeName: string): AnalysisType | null {
    const members = parseObjectTypeAnnotation(stripEnclosingTypeParens(typeName.trim()));
    if (!members) {
      return null;
    }
    const properties: Record<string, AnalysisType> = {};
    for (const member of members) {
      const propertyType = this.typeFromTypeNameLoose(member.typeName);
      const propertyName = member.readonly ? toReadonlyPropertyName(member.name) : member.name;
      properties[propertyName] = member.optional
        ? unionType([propertyType, builtinType("undefined")])
        : propertyType;
    }
    return objectTypeWithProperties(properties);
  }

}
