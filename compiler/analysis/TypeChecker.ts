import type {
  ArrowFunctionExpression,
  ArrayBindingPattern,
  ArrayLiteral,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  BindingName,
  BlockStatement,
  CallExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassStatement,
  ConditionalExpression,
  CommaExpression,
  DoWhileStatement,
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
  StringLiteral,
  SpreadExpression,
  BooleanLiteral,
  FloatLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
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
import { bindingElements, bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import type { Node } from "compiler/ast/ast";
import type {
  AnalysisSymbol,
  BoundAnalysis,
  CheckedAnalysis,
  FlowContext,
  IdentifierResolution,
  JsxAttributeResolution,
  OperatorResolution,
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
  findMatchingTypeDelimiter,
  findTopLevelTypeCharacter,
  parseTypeNameShape,
  splitTopLevelDelimitedTypeText,
  splitTopLevelTypeText,
  stripEnclosingTypeParens
} from "./typeNames";
import { ANALYSIS_ISSUE_CODES } from "./issueCodes";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { declarationIndexForStatements } from "./declarationIndex";

export class TypeChecker {
  private readonly issues: CheckedAnalysis["issues"] = [];
  private readonly identifierResolutions: IdentifierResolution[] = [];
  private readonly jsxAttributeResolutions: JsxAttributeResolution[] = [];
  private readonly operatorResolutions: OperatorResolution[] = [];
  private readonly expressionTypes: Map<Node, AnalysisType> = new Map();
  private readonly autoAwaitExpressions: Set<Node> = new Set();
  private readonly classStatementsByName: Map<string, ClassStatement> = new Map();
  private readonly functionStatementsByName: Map<string, FunctionStatement> = new Map();
  private readonly extensionOperatorsByReceiver: Map<string, FunctionStatement[]> = new Map();
  private readonly extensionMethodsByReceiver: Map<string, Map<string, AnalysisType>> = new Map();
  private readonly extensionPropertiesByReceiver: Map<string, Map<string, AnalysisType>> = new Map();
  private readonly importedExtensionPropertyNames: Set<string> = new Set();
  private readonly enumStatementsByName: Map<string, EnumStatement> = new Map();
  private readonly namespaceStatementsByName: Map<string, NamespaceStatement> = new Map();
  private readonly interfaceStatementsByName: Map<string, InterfaceStatement> = new Map();
  private readonly typeAliasStatementsByName: Map<string, TypeAliasStatement> = new Map();
  private readonly activeTypeParameterScopes: Array<Set<string>> = [];
  private readonly namedTypeMembersCache: Map<string, Map<string, AnalysisType> | null> = new Map();
  private readonly activeTypeAliasNames: Set<string> = new Set();
  private readonly generatorFunctionStack: boolean[] = [];
  private readonly syncFunctionStack: boolean[] = [];
  // Tracks whether the innermost enclosing function is async-like (declared `async` or `sync`).
  // `await` is permitted in those bodies, and they participate in pervasive auto-await of
  // Promise-typed expressions. Plain functions do not (the stack handles nesting).
  private readonly asyncLikeFunctionStack: boolean[] = [];
  private readonly assignabilityChecksInProgress: Set<string> = new Set();
  private readonly analysisTypeIds: WeakMap<object, number> = new WeakMap();
  private nextAnalysisTypeId = 1;

  constructor(
    private readonly program: Program,
    private readonly bound: BoundAnalysis,
    externalDeclarations: readonly Statement[] = [],
    ambientDeclarations: readonly Statement[] = []
  ) {
    const runtimeProgram = getEcmaScriptRuntimeProgram();
    this.collectFunctionStatements(runtimeProgram.body);
    this.collectClassStatements(runtimeProgram.body);
    this.collectEnumStatements(runtimeProgram.body);
    this.collectInterfaceStatements(runtimeProgram.body);
    this.collectTypeAliasStatements(runtimeProgram.body);
    // An explicit import shadows the ambient runtime declaration of the same
    // name. Drop the runtime declarations first so the imported (external)
    // declarations registered below win, instead of being deleted by this pass.
    this.removeRuntimeDeclarationsShadowedByImports(program);
    // Imported (cross-file) declarations are registered for name/member
    // resolution only. They are never visited or re-checked because the
    // statement walk only traverses this program's body. Local declarations are
    // collected afterwards so they win on name clashes.
    this.collectFunctionStatements(ambientDeclarations);
    this.collectClassStatements(ambientDeclarations);
    this.collectEnumStatements(ambientDeclarations);
    this.collectInterfaceStatements(ambientDeclarations);
    this.collectTypeAliasStatements(ambientDeclarations);
    this.collectNamespaceStatements({ kind: "Program", body: [...ambientDeclarations] } as Program);
    this.collectFunctionStatements(externalDeclarations);
    this.collectClassStatements(externalDeclarations);
    this.collectEnumStatements(externalDeclarations);
    this.collectInterfaceStatements(externalDeclarations);
    this.collectTypeAliasStatements(externalDeclarations);
    this.collectNamespaceStatements({ kind: "Program", body: [...externalDeclarations] } as Program);
    // Also collect declarations nested inside namespace bodies so types like
    // `moment.Moment` (declared as `namespace moment { interface Moment }`) are
    // available for member resolution when referenced as namedType("Moment").
    const nestedFromExternals = this.collectNestedNamespaceDeclarations([...ambientDeclarations, ...externalDeclarations]);
    this.collectClassStatements(nestedFromExternals);
    this.collectInterfaceStatements(nestedFromExternals);
    this.collectTypeAliasStatements(nestedFromExternals);
    // Imported extension operator overloads (e.g. `import { operator+ }`) are
    // registered so a cross-file operator like `a + b` resolves to the overload.
    this.collectExtensionOperators({ kind: "Program", body: [...ambientDeclarations, ...externalDeclarations] } as Program);
    this.collectFunctionStatements(program.body);
    this.collectClassStatements(program.body);
    this.collectExtensionOperators(program);
    this.collectExtensionMethods(program);
    this.collectImportedExtensionPropertyNames(program);
    this.collectEnumStatements(program.body);
    this.collectNamespaceStatements(program);
    this.collectInterfaceStatements(program.body);
    this.collectTypeAliasStatements(program.body);
  }

  check(): CheckedAnalysis {
    this.visitProgram(this.program, this.bound.rootScope, { loopDepth: 0, switchDepth: 0, labels: [] });
    return {
      issues: [...this.issues],
      identifierResolutions: [...this.identifierResolutions],
      jsxAttributeResolutions: [...this.jsxAttributeResolutions],
      operatorResolutions: [...this.operatorResolutions],
      expressionTypes: this.expressionTypes,
      autoAwaitExpressions: this.autoAwaitExpressions
    };
  }

  private scopeFor(node: Node, fallback: Scope): Scope {
    if (fallback.node === node) return fallback;
    const boundScope = this.bound.scopeByNode.get(node);
    if (!boundScope) return fallback;
    if (boundScope.parent && boundScope.parent !== fallback && boundScope.parent.node === fallback.node) {
      return { ...boundScope, parent: fallback };
    }
    return boundScope;
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

  // A `sync` function is internally an async function: it is emitted as `async`, returns a
  // Promise<T> when observed from the outside, and supports auto-await inside its own body.
  private isAsyncLike(node: { async?: boolean; sync?: boolean }): boolean {
    return node.async === true || node.sync === true;
  }

  private visitProgram(program: Program, scope: Scope, flow: FlowContext): void {
    for (const statement of program.body) {
      this.visitStatement(statement, scope, flow);
    }
  }

  private visitStatement(statement: Statement, scope: Scope, flow: FlowContext): void {
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
      case "InterfaceStatement":
      case "TypeAliasStatement":
        return;
      case "ExprStatement":
        this.visitExpression((statement as ExprStatement).expression, scope);
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
          { name: labeled.label.name, allowsContinue: this.statementAllowsLabeledContinue(labeled.body) }
        ];
        this.visitStatement(labeled.body, scope, { ...flow, labels });
        return;
      }
      case "ReturnStatement": {
        const returnStatement = statement as ReturnStatement;
        const expectedReturnType = flow.expectedReturnType;
        const asyncReturnValueType =
          flow.inAsync === true && expectedReturnType
            ? this.getAsyncReturnValueType(expectedReturnType)
            : null;
        if (returnStatement.expression) {
          // A returned Promise is flattened by the surrounding async/sync function, so it is not
          // auto-awaited (mirroring plain `async` semantics).
          const actualReturnType = this.visitExpression(
            returnStatement.expression,
            scope,
            asyncReturnValueType ?? expectedReturnType,
            true
          );
          if (
            expectedReturnType &&
            !isUnknownType(expectedReturnType) &&
            !isUnknownType(actualReturnType) &&
            !this.returnExpressionIsAssignable(actualReturnType, expectedReturnType, asyncReturnValueType)
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

  private statementAllowsLabeledContinue(statement: Statement): boolean {
    if (statement.kind === "WhileStatement" || statement.kind === "DoWhileStatement" || statement.kind === "ForStatement") {
      return true;
    }
    if (statement.kind === "LabeledStatement") {
      return this.statementAllowsLabeledContinue((statement as LabeledStatement).body);
    }
    return false;
  }

  private visitVarStatement(statement: VarStatement, scope: Scope): void {
    if (statement.receiverType) {
      const extensionScope = this.scopeFor(statement, scope);
      const explicitType = this.resolveTypeAnnotation(statement.typeAnnotation, extensionScope);
      const initializerType = statement.initializer
        ? this.visitExpression(statement.initializer, extensionScope, explicitType)
        : UNKNOWN_TYPE;
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
      const properties = this.extensionPropertiesByReceiver.get(statement.receiverType.name) ?? new Map<string, AnalysisType>();
      properties.set(bindingIdentifiers(statement.name)[0]!.name, propertyType);
      this.extensionPropertiesByReceiver.set(statement.receiverType.name, properties);
      return;
    }
    if (statement.declarations && statement.declarations.length > 0) {
      for (const declaration of statement.declarations) {
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
    if (this.isValidVariableDelegateType(delegateType)) {
      return;
    }
    this.issues.push({
      message: `Type '${typeToString(delegateType)}' is not a valid property delegate; expected a function, tuple, or object with a 'value' property`,
      node
    });
  }

  private isValidVariableDelegateType(delegateType: AnalysisType): boolean {
    if (isUnknownType(delegateType) || (delegateType.kind === "builtin" && delegateType.name === "any")) {
      return true;
    }
    if (delegateType.kind === "function" || delegateType.kind === "tuple") {
      return true;
    }
    if (delegateType.kind === "object") {
      return delegateType.properties["value"] !== undefined;
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
    for (const element of binding.elements) {
      if (element.rest === true) {
        this.updateBindingSymbolTypes(scope, element.name, UNKNOWN_TYPE);
        continue;
      }
      const propertyName = element.propertyName?.name ?? (element.name.kind === "Identifier" ? element.name.name : undefined);
      const inferredPropertyType = propertyName ? this.memberTypeFromObjectType(sourceType, propertyName) ?? UNKNOWN_TYPE : UNKNOWN_TYPE;
      const propertyType = element.typeAnnotation
        ? this.resolveTypeAnnotation(element.typeAnnotation, scope) ?? UNKNOWN_TYPE
        : inferredPropertyType;
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

    for (const element of binding.elements) {
      const propertyName = element.propertyName?.name ?? (element.name.kind === "Identifier" ? element.name.name : undefined);
      const inferredPropertyType = element.rest === true || !propertyName
        ? UNKNOWN_TYPE
        : this.memberTypeFromObjectType(sourceType, propertyName) ?? UNKNOWN_TYPE;
      const propertyType = element.typeAnnotation
        ? this.resolveTypeAnnotation(element.typeAnnotation, scope) ?? UNKNOWN_TYPE
        : inferredPropertyType;
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

  private visitFunctionStatement(statement: FunctionStatement, scope: Scope): void {
    if (statement.operator) {
      const isUnaryAllowed = statement.operator === "+" || statement.operator === "-";
      const nonThisParams = statement.parameters.filter((p) => p.thisParameter !== true);
      if (nonThisParams.length > 1) {
        this.issues.push({
          message: `Operator '${statement.operator}' must declare at most one parameter`,
          node: statement.name
        });
      } else if (!isUnaryAllowed && nonThisParams.length !== 1) {
        this.issues.push({
          message: `Operator '${statement.operator}' must declare exactly one parameter`,
          node: statement.name
        });
      }
    }
    const isAsyncLike = this.isAsyncLike(statement);
    this.withGeneratorFunction(statement.generator === true, () => this.withSyncFunction(statement.sync === true, () => this.withAsyncLikeFunction(isAsyncLike, () => {
      const typeParameterNames = statement.typeParameters?.map((parameter) => parameter.name.name) ?? [];
      this.withTypeParameters(typeParameterNames, () => {
        const declaredReturnType = this.resolveTypeAnnotation(statement.returnType, scope);
        if (isAsyncLike) {
          this.validateAsyncReturnTypeAnnotation(declaredReturnType, statement.returnType ?? statement.name);
        }
        const returnType = declaredReturnType ?? UNKNOWN_TYPE;
        const fnType = this.buildFunctionType(statement.parameters, returnType, scope, statement.typeParameters ?? []);
        const existingSymbolType = scope.symbols.get(statement.name.name)?.type;
        if ((statement.missingBody !== true || statement.declared === true) && existingSymbolType?.kind !== "union") {
          this.updateSymbolType(scope, statement.name.name, fnType);
        }

        const functionScope = this.scopeFor(statement, scope);
        for (const parameter of statement.parameters) {
          if (parameter.thisParameter === true) {
            continue;
          }
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
          inAsync: isAsyncLike,
          inGenerator: statement.generator === true
        };
        for (const bodyStatement of statement.body.body) {
          this.visitStatement(bodyStatement, functionScope, functionFlow);
        }
        const resolvedReturnType = this.finalizeFunctionReturnType(
          declaredReturnType,
          statement.body,
          isAsyncLike
        );
        if ((statement.missingBody !== true || statement.declared === true) && existingSymbolType?.kind !== "union") {
          this.updateSymbolType(
            scope,
            statement.name.name,
            this.buildFunctionType(statement.parameters, resolvedReturnType, scope, statement.typeParameters ?? [])
          );
        }
        if (statement.missingBody !== true) {
          this.reportMissingReturnPath(statement.body, resolvedReturnType, statement.name, isAsyncLike);
        }
      });
    })));
  }

  private visitEnumStatement(statement: EnumStatement, scope: Scope): void {
    const enumScope = this.scopeFor(statement, scope);
    for (const member of statement.members) {
      if (member.initializer) {
        const initializerType = this.visitExpression(member.initializer, enumScope);
        if (!this.isTypeAssignable(initializerType, builtinType("int")) && !this.isTypeAssignable(initializerType, builtinType("string"))) {
          this.issues.push({
            message: `Enum member '${member.name.name}' initializer must be assignable to int or string`,
            node: member.initializer
          });
        }
      }
    }
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
      for (const classDelegate of statement.classDelegates ?? []) {
        const expectedDelegateType = this.resolveTypeAnnotation(classDelegate.typeAnnotation, classScope);
        const expressionType = this.classDelegateExpressionType(classDelegate.expression, classScope, expectedDelegateType);
        if (expectedDelegateType && !isUnknownType(expressionType) && !this.isTypeAssignable(expressionType, expectedDelegateType)) {
          this.issues.push({
            message: `Class delegate for '${classDelegate.typeAnnotation.name}' has type '${this.typeToDiagnosticLabel(expressionType)}' but expected '${this.typeToDiagnosticLabel(expectedDelegateType)}'`,
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
          const isUnaryAllowed = method.operator === "+" || method.operator === "-";
          if (method.parameters.length > 1) {
            this.issues.push({
              message: `Operator '${method.operator}' must declare at most one parameter`,
              node: method.name
            });
          } else if (!isUnaryAllowed && method.parameters.length !== 1) {
            this.issues.push({
              message: `Operator '${method.operator}' must declare exactly one parameter`,
              node: method.name
            });
          }
        }
        const methodTypeParameterNames = method.typeParameters?.map((parameter) => parameter.name.name) ?? [];
        const methodIsAsyncLike = this.isAsyncLike(method);
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
              method.typeParameters ?? []
            );
            this.updateSymbolType(classScope, method.name.name, methodType);
            this.namedTypeMembersCache.clear();

            const methodScope = this.scopeFor(method, classScope);
            for (const parameter of method.parameters) {
              if (parameter.thisParameter === true) {
                continue;
              }
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
              methodIsAsyncLike
            );
            this.updateSymbolType(
              classScope,
              method.name.name,
              this.buildFunctionType(
                method.parameters,
                resolvedMethodReturnType,
                classScope,
                method.typeParameters ?? []
              )
            );
            this.namedTypeMembersCache.clear();
            if (statement.declared !== true && method.missingBody !== true && method.abstract !== true) {
              this.reportMissingReturnPath(method.body, resolvedMethodReturnType, method.name, methodIsAsyncLike);
            }
          });
        })));
      }

      this.validateOverrideMembers(statement);
      this.validateImplementedInterfaces(statement);
    });
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
      const iteratorType = this.elementTypeFromIterable(iterableType);
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
    const thenScope = this.scopeWithNarrowings(
      this.scopeFor(statement.thenBranch, scope),
      this.conditionNarrowings(statement.condition, scope, true)
    );
    this.visitStatement(statement.thenBranch, thenScope, flow);
    if (statement.elseBranch) {
      const elseScope = this.scopeWithNarrowings(
        this.scopeFor(statement.elseBranch, scope),
        this.conditionNarrowings(statement.condition, scope, false)
      );
      this.visitStatement(statement.elseBranch, elseScope, flow);
    }
  }

  private scopeWithNarrowings(scope: Scope, narrowings: Map<string, AnalysisType>): Scope {
    if (narrowings.size === 0) return scope;
    const narrowedScope: Scope = {
      ...(scope.parent ? { parent: scope.parent } : {}),
      node: scope.node,
      symbols: new Map(scope.symbols),
      children: scope.children
    };
    for (const [name, type] of narrowings) {
      const symbol = this.resolve(name, scope, undefined);
      if (!symbol) continue;
      narrowedScope.symbols.set(name, { ...symbol, type, valueType: typeToString(type) });
    }
    return narrowedScope;
  }

  private conditionNarrowings(condition: Expr, scope: Scope, truthy: boolean): Map<string, AnalysisType> {
    if (condition.kind === "UnaryExpression" && (condition as UnaryExpression).operator === "!") {
      return this.conditionNarrowings((condition as UnaryExpression).argument, scope, !truthy);
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
        !this.statementListPreventsSwitchFallthrough(switchCase.consequent)
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

  private statementListPreventsSwitchFallthrough(statements: Statement[]): boolean {
    for (const statement of statements) {
      if (this.statementPreventsSwitchFallthrough(statement)) {
        return true;
      }
    }
    return false;
  }

  private statementPreventsSwitchFallthrough(statement: Statement): boolean {
    switch (statement.kind) {
      case "BreakStatement":
      case "ContinueStatement":
      case "ReturnStatement":
      case "ThrowStatement":
        return true;
      case "BlockStatement":
        return this.statementListPreventsSwitchFallthrough((statement as BlockStatement).body);
      case "IfStatement": {
        const conditional = statement as IfStatement;
        return (
          conditional.elseBranch !== undefined &&
          this.statementPreventsSwitchFallthrough(conditional.thenBranch) &&
          this.statementPreventsSwitchFallthrough(conditional.elseBranch)
        );
      }
      case "TryStatement": {
        const tryStatement = statement as TryStatement;
        if (tryStatement.finallyBlock && this.statementPreventsSwitchFallthrough(tryStatement.finallyBlock)) {
          return true;
        }
        return (
          this.statementPreventsSwitchFallthrough(tryStatement.tryBlock) &&
          (tryStatement.catchClause === undefined || this.statementPreventsSwitchFallthrough(tryStatement.catchClause.body))
        );
      }
      case "WithStatement":
        return this.statementPreventsSwitchFallthrough((statement as WithStatement).body);
      case "LabeledStatement":
        return this.statementPreventsSwitchFallthrough((statement as LabeledStatement).body);
      default:
        return false;
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
              message: `Operator '${binary.operator}' is not defined for types '${this.typeToDiagnosticLabel(leftType)}' and '${this.typeToDiagnosticLabel(rightType)}'`,
              node: this.operatorDiagnosticNode(binary),
              code: ANALYSIS_ISSUE_CODES.OPERATOR_NOT_DEFINED
            });
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
      case "AssignmentExpression": {
        const assignment = expression as AssignmentExpression;
        if (!this.isLValueExpression(assignment.left)) {
          this.issues.push({
            message: "Invalid assignment target: left side must be an identifier or member access",
            node: assignment.left
          });
        }
        this.validateReadonlyAssignmentTarget(assignment.left, scope);
        const leftType = this.visitExpression(assignment.left, scope);
        const rightType = this.visitExpression(assignment.right, scope, leftType);
        if (
          !isUnknownType(leftType) &&
          !isUnknownType(rightType) &&
          !this.isTypeAssignable(rightType, leftType)
        ) {
          this.reportTypeMismatch(rightType, leftType, assignment.right, assignment.right);
        }
        if (assignment.left.kind === "Identifier" && isUnknownType(leftType) && !isUnknownType(rightType)) {
          const identifier = assignment.left as Node & { kind: "Identifier"; name: string };
          this.updateResolvedSymbolType(scope, identifier, rightType);
        }
        result = rightType;
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
            message: `Type assertion from '${this.typeToDiagnosticLabel(expressionType)}' to '${this.typeToDiagnosticLabel(assertedType)}' may be unsafe because neither type is assignable to the other`,
            node: assertion.typeAnnotation
          });
        }
        result = assertedType;
        break;
      }
      case "NonNullExpression": {
        const nonNull = expression as NonNullExpression;
        result = this.removeNullishFromType(this.visitExpression(nonNull.expression, scope));
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
        const objectType = member.nonNullAsserted === true ? this.removeNullishFromType(rawObjectType) : rawObjectType;
        if (member.computed) {
          const propertyType = this.visitExpression(member.property, scope);
          result = this.resolveOptionalAccessType(this.resolveComputedMemberType(objectType, propertyType), member.optional === true);
          break;
        }
        this.validateKnownMemberAccess(member, objectType, scope);
        result = this.resolveOptionalAccessType(this.resolveKnownMemberType(member, objectType) ?? UNKNOWN_TYPE, member.optional === true);
        break;
      }
      case "CallExpression": {
        const call = expression as CallExpression;
        const calleeType = this.visitExpression(call.callee, scope);
        const argumentTypes: AnalysisType[] = [];
        for (const argument of call.arguments) {
          argumentTypes.push(this.visitExpression(argument, scope));
        }
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
          this.validateConstructorArity(call, calledClass);
          result = namedType(calledClass.name.name, explicitTypeArguments);
          break;
        }
        const callableType = this.callableTypeFrom(calleeType, argumentTypes);
        if (callableType) {
          const explicitTypeArguments = (call.typeArguments ?? []).map((typeArgument) =>
            this.resolveTypeAnnotation(typeArgument, scope) ?? UNKNOWN_TYPE
          );
          const hasNamedArguments = call.arguments.some((argument) => argument.kind === "NamedArgument");
          // Named arguments are written in any order; reorder their types into
          // the callee's positional parameter order so generic inference and
          // argument validation operate as if the call were positional.
          const inferenceArgumentTypes = hasNamedArguments
            ? this.reorderNamedArgumentTypes(call.arguments, argumentTypes, callableType)
            : argumentTypes;
          const firstPassCalleeType = this.instantiateFunctionType(
            callableType,
            explicitTypeArguments,
            inferenceArgumentTypes,
            expectedType
          );
          const contextualArgumentTypes = hasNamedArguments
            ? inferenceArgumentTypes
            : this.applyCallArgumentContext(
                call,
                scope,
                firstPassCalleeType,
                argumentTypes
              );
          const instantiatedCalleeType = contextualArgumentTypes === argumentTypes
            ? firstPassCalleeType
            : this.instantiateFunctionType(callableType, explicitTypeArguments, contextualArgumentTypes, expectedType);
          this.validateFunctionTypeArgumentConstraints(callableType, instantiatedCalleeType, call);
          if (hasNamedArguments) {
            this.validateNamedCallArguments(call, instantiatedCalleeType, argumentTypes);
          } else {
            this.validateCallArguments(call, instantiatedCalleeType, contextualArgumentTypes);
          }
          this.evolveArrayElementTypeFromMutation(call, scope, contextualArgumentTypes);
          result = this.resolveOptionalAccessType(
            instantiatedCalleeType.returnType,
            call.optional === true || this.hasNullishUnionMember(calleeType)
          );
          break;
        }
        const constructableOnlyType = this.interfaceConstructorTypeForNewExpression(call, calleeType, scope);
        if (constructableOnlyType) {
          const explicitTypeArguments = (call.typeArguments ?? []).map((typeArgument) =>
            this.resolveTypeAnnotation(typeArgument, scope) ?? UNKNOWN_TYPE
          );
          const instantiatedConstructorType = this.instantiateFunctionType(
            constructableOnlyType,
            explicitTypeArguments,
            argumentTypes,
            expectedType
          );
          this.validateFunctionTypeArgumentConstraints(constructableOnlyType, instantiatedConstructorType, call);
          this.validateCallArguments(call, instantiatedConstructorType, argumentTypes);
          result = instantiatedConstructorType.returnType;
          break;
        }
        if (!isUnknownType(calleeType)) {
          this.issues.push({
            message: `Type '${this.typeToDiagnosticLabel(calleeType)}' is not callable`,
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
        if (!isUnknownType(calleeType)) {
          if (calleeType.kind === "function") {
            result = calleeType.returnType;
            break;
          }
          this.issues.push({
            message: `Type '${this.typeToDiagnosticLabel(calleeType)}' is not constructable`,
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
          result = this.unwrapPromiseType(argumentType) ?? argumentType;
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
        if ((unary.operator === "+" || unary.operator === "-") && this.isIntType(argumentType)) {
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
              message: `Unary operator '${unary.operator}' is not defined for type '${this.typeToDiagnosticLabel(argumentType)}'`,
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
      case "UpdateExpression":
        this.validateReadonlyAssignmentTarget((expression as UpdateExpression).argument, scope);
        this.visitExpression((expression as UpdateExpression).argument, scope);
        result = builtinType("int");
        break;
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
        const arrowIsAsyncLike = this.isAsyncLike(arrow);
        this.withGeneratorFunction(false, () => this.withSyncFunction(arrow.sync === true, () => this.withAsyncLikeFunction(arrowIsAsyncLike, () => {
          if (arrow.contextualObjectLiteral && expectedType && expectedType.kind !== "function") {
            result = this.inferObjectLiteralType(arrow.contextualObjectLiteral, scope, expectedType);
            return;
          }
          const expectedFunctionType = expectedType?.kind === "function" ? expectedType : undefined;
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
            returnType = this.finalizeFunctionReturnType(
              expectedFunctionType?.returnType,
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
              !this.isTypeAssignable(returnType, expectedFunctionType.returnType)
            ) {
              this.reportReturnTypeMismatch(returnType, expectedFunctionType.returnType, arrow.body as Expr);
              returnType = expectedFunctionType.returnType;
            }
          }
          result = this.buildFunctionType(arrow.parameters, returnType, arrowScope);
        })));
        break;
      }
      case "FunctionExpression": {
        const fn = expression as FunctionExpression;
        const fnIsAsyncLike = this.isAsyncLike(fn);
        this.withGeneratorFunction(fn.generator === true, () => this.withSyncFunction(fn.sync === true, () => this.withAsyncLikeFunction(fnIsAsyncLike, () => {
          const expectedFunctionType = expectedType?.kind === "function" ? expectedType : undefined;
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
          const returnType = this.finalizeFunctionReturnType(
            declaredReturnType ?? expectedFunctionType?.returnType,
            fn.body,
            fnIsAsyncLike
          );
          this.reportMissingReturnPath(fn.body, returnType, fn.name ?? fn, fnIsAsyncLike);
          result = this.buildFunctionType(fn.parameters, returnType, functionScope);
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
        result = namedType("JSX.Element");
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
        result = namedType("JSX.Element");
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
      result = this.unwrapPromiseType(result) ?? result;
    }

    this.expressionTypes.set(expression, result);
    return result;
  }

  private isGoExpression(expression: Expr): boolean {
    return expression.kind === "UnaryExpression" && (expression as UnaryExpression).operator === "go";
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
    if (leftType.kind !== "named") {
      return null;
    }
    const classStatement = this.classStatementsByName.get(leftType.name);
    for (const member of classStatement?.members ?? []) {
      if (member.kind !== "ClassMethodMember") {
        continue;
      }
      const method = member as ClassMethodMember;
      if (method.operator !== operator || method.parameters.length !== 1 || !this.operatorParameterMatches(method.parameters[0], rightType, scope)) {
        continue;
      }
      return {
        type: method.returnType
          ? this.resolveTypeAnnotation(method.returnType, scope) ?? UNKNOWN_TYPE
          : namedType(leftType.name),
        symbol: this.createMethodSymbol(method)
      };
    }
    for (const extension of this.extensionOperatorsByReceiver.get(leftType.name) ?? []) {
      if (extension.operator !== operator || extension.parameters.length !== 1 || !this.operatorParameterMatches(extension.parameters[0], rightType, scope)) {
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
    if (leftType.kind === "unknown" && this.isPrimitiveLikeOperatorType(rightType)) {
      return false;
    }
    if (rightType.kind === "unknown" && this.isPrimitiveLikeOperatorType(leftType)) {
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

  private isPrimitiveLikeOperatorType(type: AnalysisType): boolean {
    if (type.kind === "builtin") {
      return (
        type.name === "int" ||
        type.name === "number" ||
        type.name === "string" ||
        type.name === "boolean" ||
        type.name === "bigint" ||
        type.name === "long" ||
        type.name === "any" ||
        type.name === "void" ||
        type.name === "null" ||
        type.name === "undefined"
      );
    }
    if (type.kind === "literal") {
      return true;
    }
    return false;
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
      const propertyType = this.typeFromAnnotationLoose(method.returnType) ?? UNKNOWN_TYPE;
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
      this.typeFromAnnotationLoose(method.returnType) ?? UNKNOWN_TYPE,
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
      this.typeFromAnnotationLoose(statement.returnType) ?? UNKNOWN_TYPE,
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
        const propertyName = element.propertyName?.name ?? (element.name.kind === "Identifier" ? element.name.name : undefined);
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
    const parameterType = parameter?.typeAnnotation
      ? this.resolveTypeAnnotation(parameter.typeAnnotation, scope) ?? UNKNOWN_TYPE
      : UNKNOWN_TYPE;
    return isUnknownType(parameterType) || isUnknownType(rightType) || this.isTypeAssignable(rightType, parameterType);
  }

  private inferBinaryType(
    operator: BinaryExpression["operator"],
    leftType: AnalysisType,
    rightType: AnalysisType
  ): AnalysisType {
    if (
      operator === "+" &&
      (this.isStringLikeType(leftType) || this.isStringLikeType(rightType))
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
      if (this.isIntType(leftType) && this.isIntType(rightType)) {
        return builtinType("int");
      }
      if (this.isNumberType(leftType) && this.isNumberType(rightType)) {
        return builtinType("number");
      }
      if (this.isNumberLikeType(leftType) || this.isNumberLikeType(rightType)) {
        return builtinType("number");
      }
      if (this.isBigIntType(leftType) && this.isBigIntType(rightType)) {
        return builtinType("bigint");
      }
      if (this.isLongType(leftType) && this.isLongType(rightType)) {
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

  private isNumberLikeType(type: AnalysisType): boolean {
    return (
      (type.kind === "builtin" && type.name === "number") ||
      (type.kind === "literal" && type.base === "number")
    );
  }

  private isTypeAssignable(sourceType: AnalysisType, targetType: AnalysisType): boolean {
    const assignabilityKey = `${this.analysisTypeId(sourceType)}=>${this.analysisTypeId(targetType)}`;
    if (this.assignabilityChecksInProgress.has(assignabilityKey)) {
      return true;
    }
    this.assignabilityChecksInProgress.add(assignabilityKey);
    try {
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
      return sourceType.elements.every((element) => this.isTypeAssignable(element, targetType.elementType));
    }

    if (sourceType.kind === "tuple" && targetType.kind === "tuple") {
      if (sourceType.elements.length !== targetType.elements.length) {
        return false;
      }
      return sourceType.elements.every((element, index) =>
        this.isTypeAssignable(element, targetType.elements[index]!)
      );
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
        if (!this.isTypeAssignable(sourceParameter.type, targetParameter.type)) {
          return false;
        }
        if ((targetParameter.optional ?? false) === false && (sourceParameter.optional ?? false) === true) {
          return false;
        }
      }

      return this.isTypeAssignable(sourceType.returnType, targetType.returnType);
    }

    if (sourceType.kind === "array" && targetType.kind === "array") {
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
      return this.isTypeAssignable(namedType("Array", [sourceType.elementType]), targetType);
    }

    if (sourceType.kind === "named" && targetType.kind === "named") {
      if (sourceType.name === "JSX.Element" && targetType.name === "VNode") {
        return true;
      }
      if (sourceType.name === targetType.name) {
        const sourceTypeArguments = sourceType.typeArguments ?? [];
        const targetTypeArguments = targetType.typeArguments ?? [];
        if (targetTypeArguments.length === 0) {
          return true;
        }
        if (sourceTypeArguments.length === targetTypeArguments.length) {
          return sourceTypeArguments.every((sourceArgument, index) =>
            isSameType(sourceArgument, targetTypeArguments[index]!)
          );
        }
      }
      return this.isNamedTypeStructurallyAssignable(sourceType, targetType);
    }

    if (this.isIntType(sourceType) && this.isNumberType(targetType)) {
      return true;
    }

    if (this.isLongType(sourceType) && this.isBigIntType(targetType)) {
      return true;
    }

    // `numeric` is the common supertype of the integer (`int`/`number`) and
    // big-integer (`long`/`bigint`) numeric families.
    if (this.isNumericType(targetType) && this.isNumericFamilyType(sourceType)) {
      return true;
    }

    return false;
    } finally {
      this.assignabilityChecksInProgress.delete(assignabilityKey);
    }
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

  private objectPropertiesAreAssignable(
    sourceProperties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
    targetProperties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>
  ): boolean {
    const targetEntries: Iterable<[string, AnalysisType]> = targetProperties instanceof Map
      ? targetProperties.entries()
      : Object.entries(targetProperties);
    for (const [propertyName, targetPropertyType] of targetEntries) {
      const sourcePropertyType = this.propertyTypeFrom(sourceProperties, propertyName);
      if (!sourcePropertyType) {
        if (this.propertyTypeAllowsUndefined(targetPropertyType)) {
          continue;
        }
        return false;
      }
      if (!this.isTypeAssignable(sourcePropertyType, targetPropertyType)) {
        return false;
      }
    }
    return true;
  }

  private propertyTypeFrom(
    properties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
    propertyName: string
  ): AnalysisType | undefined {
    if (typeof (properties as ReadonlyMap<string, AnalysisType>).get === "function") {
      return (properties as ReadonlyMap<string, AnalysisType>).get(propertyName);
    }
    return (properties as Record<string, AnalysisType>)[propertyName];
  }

  private propertyTypeAllowsUndefined(type: AnalysisType): boolean {
    if (type.kind === "builtin") {
      return type.name === "undefined" || type.name === "any" || type.name === "unknown";
    }
    if (type.kind === "union") {
      return type.types.some((member) => this.propertyTypeAllowsUndefined(member));
    }
    return false;
  }

  private buildFunctionType(
    parameters: FunctionParameter[],
    returnType: AnalysisType,
    scope: Scope,
    typeParameters: TypeParameter[] = []
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
      this.typeParameterConstraintMap(typeParameters, scope)
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
        const propertyName = element.propertyName?.name ?? (element.name.kind === "Identifier" ? element.name.name : undefined);
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

  private typeFromAnnotationLooseWithTypeParameters(
    typeAnnotation: Identifier | undefined,
    localTypeParameterNames: readonly string[]
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    return this.typeFromTypeNameLooseWithTypeParameters(typeAnnotation.name, new Set(localTypeParameterNames));
  }

  private typeFromTypeNameLooseWithTypeParameters(
    typeName: string | undefined,
    localTypeParameterNames: ReadonlySet<string>
  ): AnalysisType | undefined {
    if (!typeName) {
      return undefined;
    }
    const functionType = this.functionTypeFromAnnotationText(typeName);
    if (functionType) {
      return functionType;
    }
    if (this.looksLikeFunctionTypeAnnotation(typeName)) {
      return UNKNOWN_TYPE;
    }
    const objectType = this.objectTypeFromAnnotationText(typeName);
    if (objectType) {
      return objectType;
    }
    const computedType = this.typeFromComputedTypeNameLoose(typeName);
    if (computedType) {
      return computedType;
    }
    const normalizedTypeName = typeName.trim();
    const unionParts = splitTopLevelTypeText(normalizedTypeName, "|");
    if (unionParts.length > 1) {
      return unionType(unionParts.map((part) => this.typeFromTypeNameLooseWithTypeParameters(part, localTypeParameterNames) ?? UNKNOWN_TYPE));
    }
    const intersectionParts = splitTopLevelTypeText(normalizedTypeName, "&");
    if (intersectionParts.length > 1) {
      return intersectionType(intersectionParts.map((part) => this.typeFromTypeNameLooseWithTypeParameters(part, localTypeParameterNames) ?? UNKNOWN_TYPE));
    }
    if (normalizedTypeName.startsWith("[") && normalizedTypeName.endsWith("]")) {
      const tupleBody = normalizedTypeName.slice(1, -1).trim();
      return tupleType(
        tupleBody.length === 0
          ? []
          : splitTopLevelTypeText(tupleBody, ",").map((part) =>
            this.typeFromTypeNameLooseWithTypeParameters(this.tupleElementTypeText(part), localTypeParameterNames) ?? UNKNOWN_TYPE
          )
      );
    }
    const parsed = parseTypeNameShape(normalizedTypeName);
    const resolvedTypeArguments = parsed.typeArguments.map((typeArgument) =>
      this.typeFromTypeNameLooseWithTypeParameters(typeArgument, localTypeParameterNames) ?? UNKNOWN_TYPE
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
    if (this.typeAliasStatementsByName.has(parsed.baseName) || this.interfaceStatementsByName.has(parsed.baseName) || this.classStatementsByName.has(parsed.baseName) || this.enumStatementsByName.has(parsed.baseName) || this.namespaceStatementsByName.has(parsed.baseName)) {
      let resolved: AnalysisType = namedType(parsed.baseName, resolvedTypeArguments);
      for (let i = 0; i < parsed.arrayDepth; i += 1) {
        resolved = arrayType(resolved);
      }
      return this.expandTypeAliases(resolved);
    }
    return this.typeFromTypeNameLoose(typeName);
  }


  private tupleElementTypeText(elementText: string): string {
    let trimmed = elementText.trim();
    if (trimmed.startsWith("...")) {
      trimmed = trimmed.slice(3).trim();
    }
    const colonIndex = findTopLevelTypeCharacter(trimmed, ":");
    if (colonIndex >= 0) {
      const label = trimmed.slice(0, colonIndex).trim();
      if (/^[A-Za-z_$][\w$]*\??$/.test(label)) {
        return trimmed.slice(colonIndex + 1).trim();
      }
    }
    return trimmed;
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

  private applyCallArgumentContext(
    call: CallExpression,
    scope: Scope,
    calleeType: AnalysisType & { kind: "function" },
    argumentTypes: AnalysisType[]
  ): AnalysisType[] {
    let contextualArgumentTypes: AnalysisType[] | undefined;

    for (let index = 0; index < call.arguments.length && index < calleeType.parameters.length; index += 1) {
      const argument = call.arguments[index]!;
      const expectedParameterType = calleeType.parameters[index]?.type;
      const contextualExpectedType = expectedParameterType
        ? this.contextualTypeForExpressionArgument(
            argument,
            this.contextualTypeWithoutUnresolvedReturnType(expectedParameterType, calleeType.typeParameters ?? [])
          )
        : null;
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

  private contextualTypeWithoutUnresolvedReturnType(
    expectedType: AnalysisType,
    typeParameters: string[]
  ): AnalysisType {
    if (
      expectedType.kind !== "function" ||
      expectedType.returnType.kind !== "named" ||
      !typeParameters.includes(expectedType.returnType.name)
    ) {
      return expectedType;
    }

    return {
      ...expectedType,
      returnType: UNKNOWN_TYPE
    };
  }

  private isFunctionLikeExpression(expression: Expr): boolean {
    return expression.kind === "ArrowFunctionExpression" || expression.kind === "FunctionExpression";
  }

  private contextualTypeForExpressionArgument(
    argument: Expr,
    expectedType: AnalysisType
  ): AnalysisType | null {
    if (this.isFunctionLikeExpression(argument)) {
      const arrow = argument.kind === "ArrowFunctionExpression" ? argument as ArrowFunctionExpression : undefined;
      return expectedType.kind === "function" || arrow?.contextualObjectLiteral ? expectedType : null;
    }
    if (argument.kind === "ObjectLiteral") {
      return expectedType.kind === "object" || expectedType.kind === "named" ? expectedType : null;
    }
    if (argument.kind === "ArrayLiteral") {
      return expectedType.kind === "array" || expectedType.kind === "range" || expectedType.kind === "tuple" ? expectedType : null;
    }
    return null;
  }

  private instantiateFunctionType(
    calleeType: AnalysisType & { kind: "function" },
    explicitTypeArguments: AnalysisType[],
    argumentTypes: AnalysisType[],
    expectedReturnType?: AnalysisType
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
    for (let index = 0; index < calleeType.parameters.length && index < argumentTypes.length; index += 1) {
      this.inferTypeParameterSubstitutions(
        calleeType.parameters[index]!.type,
        argumentTypes[index]!,
        typeParameterSet,
        explicitlyProvidedTypeParameters,
        substitutions
      );
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
        substitutions.set(typeParameter, namedType(typeParameter));
      }
    }

    return this.substituteTypeParameters(calleeType, substitutions) as AnalysisType & { kind: "function" };
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
  }


  private callableTypeFrom(type: AnalysisType, argumentTypes: AnalysisType[] = []): (AnalysisType & { kind: "function" }) | null {
    if (type.kind === "function") {
      return type;
    }
    if (type.kind === "named") {
      const interfaceCallable = this.interfaceCallableTypeForNamedType(type, argumentTypes);
      if (interfaceCallable) {
        return interfaceCallable;
      }
    }
    if (type.kind !== "union") {
      return null;
    }
    const callableMembers = type.types.filter((member): member is AnalysisType & { kind: "function" } => member.kind === "function");
    return callableMembers.find((member) => this.isCallableMatch(member, argumentTypes)) ?? callableMembers[0] ?? null;
  }

  private interfaceCallableTypeForNamedType(
    type: AnalysisType & { kind: "named" },
    argumentTypes: AnalysisType[]
  ): (AnalysisType & { kind: "function" }) | null {
    const overloads = this.collectInterfaceCallableOverloads(type);
    if (overloads.length === 0) {
      return null;
    }
    return overloads.find((member) => this.isCallableMatch(member, argumentTypes)) ?? overloads[0] ?? null;
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
            type: this.typeFromAnnotationLooseWithTypeParameters(parameter.typeAnnotation, availableTypeParameterNames) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
          })),
          this.typeFromAnnotationLooseWithTypeParameters(interfaceMember.returnType, availableTypeParameterNames) ?? builtinType("void"),
          methodTypeParameterNames,
          this.typeParameterConstraintMapLoose(interfaceMember.typeParameters ?? [], availableTypeParameterNames)
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
        ? this.restParameterElementType(restParameter.type)
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

  private hasNullishUnionMember(type: AnalysisType): boolean {
    return type.kind === "union" && type.types.some((member) => this.isNullishType(member));
  }

  private removeNullishFromType(type: AnalysisType): AnalysisType {
    if (type.kind !== "union") {
      return type;
    }
    const nonNullishTypes = type.types.filter((member) => !this.isNullishType(member));
    if (nonNullishTypes.length === 0) {
      return UNKNOWN_TYPE;
    }
    return nonNullishTypes.length === 1 ? nonNullishTypes[0]! : unionType(nonNullishTypes);
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
      const propertyName = candidate.propertyName?.name ?? (candidate.name.kind === "Identifier" ? candidate.name.name : undefined);
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
        ? this.restParameterElementType(restParameter.type)
        : parameter.type;
      const comparableArgumentType = argumentExpression?.kind === "SpreadExpression"
        ? this.spreadArgumentElementType(argumentType)
        : argumentType;
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
        ? this.spreadArgumentElementType(argumentType)
        : argumentType;
      const expectedType = parameter.type;
      if (isUnknownType(expectedType) || isUnknownType(comparableArgumentType)) {
        continue;
      }
      if (this.isCallArgumentAssignable(comparableArgumentType, expectedType)) {
        continue;
      }
      this.issues.push({
        message: `Argument of type '${typeToString(comparableArgumentType)}' is not assignable to parameter '${parameter.name}' of type '${typeToString(expectedType)}'`,
        node: valueNode
      });
      this.reportNestedMismatchContext(comparableArgumentType, expectedType, valueNode);
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

  private validateConstructorArity(node: CallExpression | NewExpression, classStatement: ClassStatement): void {
    const parameters = classStatement.primaryConstructorParameters ?? [];
    if (parameters.length === 0) {
      return;
    }
    const requiredCount = parameters.filter((parameter) => parameter.defaultValue === undefined).length;
    const providedCount = node.arguments?.length ?? 0;
    const totalCount = parameters.length;
    const diagnosticNode = node.kind === "CallExpression"
      ? node.callee
      : node.callee;

    if (providedCount < requiredCount) {
      this.issues.push({
        message: `Expected at least ${requiredCount} argument(s), but got ${providedCount}`,
        node: diagnosticNode
      });
    } else if (providedCount > totalCount) {
      this.issues.push({
        message: `Expected at most ${totalCount} argument(s), but got ${providedCount}`,
        node: diagnosticNode
      });
      for (let index = totalCount; index < providedCount; index += 1) {
        this.issues.push({
          message: `Unexpected argument ${index + 1}; function expects at most ${totalCount} argument(s)`,
          node: node.arguments?.[index] ?? diagnosticNode
        });
      }
    }
  }

  private classStatementForNewExpression(newExpression: NewExpression, calleeType: AnalysisType): ClassStatement | undefined {
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
    newExpression: NewExpression,
    classStatement: ClassStatement,
    explicitTypeArguments: AnalysisType[],
    scope: Scope
  ): AnalysisType {
    const typeParameterNames = (classStatement.typeParameters ?? []).map((parameter) => parameter.name.name);
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
        this.typeParameterConstraintMapLoose(constructorMember.typeParameters ?? [], typeParameterNames)
      );
    });
    return result;
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
          ? this.restParameterElementType(restParam.type)
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
    newExpression: NewExpression,
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
    substitutions.set("T", this.combineTypes(resolvedTypes));
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

  private restParameterElementType(restParameterType: AnalysisType): AnalysisType {
    if (restParameterType.kind === "array") {
      return restParameterType.elementType;
    }
    if (restParameterType.kind === "named" && restParameterType.name === "Array" && restParameterType.typeArguments?.[0]) {
      return restParameterType.typeArguments[0];
    }
    return restParameterType;
  }

  private spreadArgumentElementType(argumentType: AnalysisType): AnalysisType {
    if (argumentType.kind === "array") {
      return argumentType.elementType;
    }
    if (argumentType.kind === "tuple") {
      return argumentType.elements.length === 1 ? argumentType.elements[0]! : unionType(argumentType.elements);
    }
    if (argumentType.kind === "named" && argumentType.name === "Array" && argumentType.typeArguments?.[0]) {
      return argumentType.typeArguments[0];
    }
    return UNKNOWN_TYPE;
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

  private finalizeFunctionReturnType(
    declaredOrExpectedReturnType: AnalysisType | undefined,
    body: BlockStatement,
    inAsync: boolean
  ): AnalysisType {
    if (declaredOrExpectedReturnType && !isUnknownType(declaredOrExpectedReturnType)) {
      if (inAsync && !this.getAsyncReturnValueType(declaredOrExpectedReturnType)) {
        return namedType("Promise", [declaredOrExpectedReturnType]);
      }
      return declaredOrExpectedReturnType;
    }
    const inferredReturnType = this.inferReturnTypeFromBlock(body);
    return inAsync ? namedType("Promise", [inferredReturnType]) : inferredReturnType;
  }

  private inferReturnTypeFromBlock(body: BlockStatement): AnalysisType {
    const returnExpressionTypes = this.collectReturnExpressionTypes(body.body);
    if (returnExpressionTypes.length === 0) {
      return builtinType("void");
    }
    return this.combineTypes(returnExpressionTypes);
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
        const spreadElementType = this.spreadArgumentElementType(elementType);
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
      default:
        return;
    }
  }

  private combineTypes(types: AnalysisType[]): AnalysisType {
    const uniqueTypes: AnalysisType[] = [];
    for (const type of types) {
      if (!uniqueTypes.some((existing) => isSameType(existing, type))) {
        uniqueTypes.push(type);
      }
    }
    if (uniqueTypes.length === 0) {
      return builtinType("void");
    }
    if (uniqueTypes.length === 1) {
      return uniqueTypes[0]!;
    }
    return unionType(uniqueTypes);
  }

  private unwrapPromiseType(type: AnalysisType): AnalysisType | null {
    if (type.kind !== "named" || type.name !== "Promise") {
      return null;
    }
    return type.typeArguments?.[0] ?? UNKNOWN_TYPE;
  }

  private getAsyncReturnValueType(returnType: AnalysisType): AnalysisType | null {
    return this.unwrapPromiseType(returnType);
  }

  private returnExpressionIsAssignable(
    actualReturnType: AnalysisType,
    expectedReturnType: AnalysisType,
    asyncReturnValueType: AnalysisType | null
  ): boolean {
    if (asyncReturnValueType) {
      return this.isTypeAssignable(actualReturnType, asyncReturnValueType) ||
        this.isTypeAssignable(actualReturnType, expectedReturnType);
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

  private reportMissingReturnPath(body: BlockStatement, returnType: AnalysisType, node: Node, inAsync: boolean = false): void {
    const asyncReturnValueType = inAsync ? this.getAsyncReturnValueType(returnType) : null;
    if (
      isUnknownType(returnType) ||
      (inAsync
        ? this.asyncReturnValueIsOptional(returnType, asyncReturnValueType)
        : this.returnValueIsOptional(returnType)) ||
      this.statementListAlwaysExits(body.body)
    ) {
      return;
    }
    this.issues.push({
      message: "Not all code paths return a value",
      node,
      code: ANALYSIS_ISSUE_CODES.NOT_ALL_CODE_PATHS_RETURN
    });
  }

  private statementListAlwaysExits(statements: Statement[]): boolean {
    for (const statement of statements) {
      if (this.statementAlwaysExits(statement)) {
        return true;
      }
      if (statement.kind === "BreakStatement" || statement.kind === "ContinueStatement") {
        return false;
      }
    }
    return false;
  }

  private statementAlwaysExits(statement: Statement): boolean {
    switch (statement.kind) {
      case "ReturnStatement":
      case "ThrowStatement":
        return true;
      case "BlockStatement":
        return this.statementListAlwaysExits((statement as BlockStatement).body);
      case "IfStatement": {
        const conditional = statement as IfStatement;
        return (
          conditional.elseBranch !== undefined &&
          this.statementAlwaysExits(conditional.thenBranch) &&
          this.statementAlwaysExits(conditional.elseBranch)
        );
      }
      case "DoWhileStatement":
        return this.statementAlwaysExits((statement as DoWhileStatement).body);
      case "SwitchStatement": {
        const switchStatement = statement as SwitchStatement;
        if (!switchStatement.cases.some((switchCase) => switchCase.test === undefined)) {
          return false;
        }
        return switchStatement.cases.every((_, index) =>
          this.statementListAlwaysExits(
            switchStatement.cases.slice(index).flatMap((switchCase) => switchCase.consequent)
          )
        );
      }
      case "TryStatement": {
        const tryStatement = statement as TryStatement;
        if (tryStatement.finallyBlock && this.statementAlwaysExits(tryStatement.finallyBlock)) {
          return true;
        }
        return (
          this.statementAlwaysExits(tryStatement.tryBlock) &&
          (tryStatement.catchClause === undefined || this.statementAlwaysExits(tryStatement.catchClause.body))
        );
      }
      case "WithStatement":
        return this.statementAlwaysExits((statement as WithStatement).body);
      case "LabeledStatement":
        return this.statementAlwaysExits((statement as LabeledStatement).body);
      default:
        return false;
    }
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
    const snippet = this.expressionSnippet(expression);
    if (!snippet) {
      return;
    }
    this.issues.push({
      message: `Nested type mismatch: expression '${snippet}' is '${typeToString(sourceType)}' but expected '${typeToString(targetType)}'`,
      node: expression
    });
  }

  private expressionSnippet(expression: Expr): string | null {
    if (expression.kind === "Identifier") {
      return null;
    }
    const first = expression.firstToken?.value;
    const last = expression.lastToken?.value;
    if (!first && !last) {
      return expression.kind;
    }
    if (first && last && first !== last) {
      return `${first} ... ${last}`;
    }
    if (first) {
      return first;
    }
    return last ?? expression.kind;
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
    const normalizedTypeName = stripEnclosingTypeParens(typeName);
    if (this.isDeferredAdvancedTypeName(normalizedTypeName)) {
      return UNKNOWN_TYPE;
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
            this.resolveTypeNameText(this.tupleElementTypeText(part), node, scope, false)
          );
      return tupleType(elements);
    }

    const arraySuffix = this.splitArraySuffixTypeName(normalizedTypeName);
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

    const literal = this.resolveLiteralTypeName(normalizedTypeName);
    if (literal) {
      return literal;
    }

    const functionAnnotation = this.resolveFunctionTypeAnnotation(normalizedTypeName, node, scope);
    if (functionAnnotation) {
      return functionAnnotation;
    }
    if (this.looksLikeFunctionTypeAnnotation(normalizedTypeName)) {
      return UNKNOWN_TYPE;
    }

    const objectAnnotation = this.resolveObjectTypeAnnotation(normalizedTypeName, node, scope);
    if (objectAnnotation) {
      return objectAnnotation;
    }

    const parsed = parseTypeNameShape(normalizedTypeName);
    let resolvedBase: AnalysisType;

    const resolvedTypeArguments = parsed.typeArguments.map((typeArgument) =>
      this.resolveTypeNameText(typeArgument, node, scope, false)
    );

    if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolvedBase = builtinType(
        parsed.baseName as BuiltinTypeName
      );
    } else if (this.isActiveTypeParameter(parsed.baseName)) {
      resolvedBase = namedType(parsed.baseName);
    } else {
      const symbol = this.resolve(parsed.baseName, scope, undefined);
      const typeAlias = this.typeAliasStatementsByName.get(parsed.baseName);
      if (symbol && (symbol.kind === "class" || symbol.kind === "variable")) {
        if (captureResolution && node.kind === "Identifier") {
          this.identifierResolutions.push({
            identifier: node as Node & { kind: "Identifier"; name: string },
            symbol
          });
        }
        this.validateNamedTypeArgumentConstraints(
          parsed.baseName,
          resolvedTypeArguments,
          node,
          scope
        );
        if (typeAlias) {
          resolvedBase = this.resolveTypeAliasTarget(typeAlias, resolvedTypeArguments, scope);
        } else {
          resolvedBase = namedType(parsed.baseName, resolvedTypeArguments);
        }
      } else {
        this.issues.push({
          message: `Unknown type '${normalizedTypeName}'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter`,
          node
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
    const indexedAccess = this.splitIndexedAccessTypeName(typeName);
    if (!indexedAccess) {
      return null;
    }

    const objectType = this.resolveTypeNameText(indexedAccess.objectTypeName, node, scope, false);
    const indexType = this.resolveTypeNameText(indexedAccess.indexTypeName, node, scope, false);
    return this.indexedAccessType(objectType, indexType, node);
  }

  private resolveLiteralTypeName(typeName: string): AnalysisType | null {
    if ((typeName.startsWith("\"") && typeName.endsWith("\"")) || (typeName.startsWith("'") && typeName.endsWith("'"))) {
      return literalType("string", typeName.slice(1, -1));
    }
    if (typeName === "true") {
      return literalType("boolean", true);
    }
    if (typeName === "false") {
      return literalType("boolean", false);
    }
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(typeName)) {
      return literalType("number", Number(typeName));
    }
    return null;
  }


  private typeFromComputedTypeNameLoose(typeName: string): AnalysisType | null {
    const normalizedTypeName = stripEnclosingTypeParens(typeName);
    if (this.isDeferredAdvancedTypeName(normalizedTypeName)) {
      return UNKNOWN_TYPE;
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
        : splitTopLevelTypeText(tupleBody, ",").map((part) => this.typeFromTypeNameLoose(this.tupleElementTypeText(part)));
      return tupleType(elements);
    }

    const arraySuffix = this.splitArraySuffixTypeName(normalizedTypeName);
    if (arraySuffix) {
      let elementType = this.typeFromTypeNameLoose(arraySuffix.elementTypeName);
      for (let i = 0; i < arraySuffix.arrayDepth; i += 1) {
        elementType = arrayType(elementType);
      }
      return elementType;
    }

    const literal = this.resolveLiteralTypeName(normalizedTypeName);
    if (literal) {
      return literal;
    }

    if (normalizedTypeName.startsWith("keyof ")) {
      return this.keyofType(this.typeFromTypeNameLoose(normalizedTypeName.slice("keyof ".length).trim()));
    }

    if (normalizedTypeName.startsWith("typeof ")) {
      return UNKNOWN_TYPE;
    }

    const indexedAccess = this.splitIndexedAccessTypeName(normalizedTypeName);
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
      /(?:^| )extends .+ \? /.test(typeName)
    );
  }

  private splitArraySuffixTypeName(typeName: string): { elementTypeName: string; arrayDepth: number } | null {
    let remaining = typeName.trim();
    let arrayDepth = 0;
    while (remaining.endsWith("[]")) {
      remaining = remaining.slice(0, -2).trim();
      arrayDepth += 1;
    }
    if (arrayDepth === 0 || remaining.length === 0) {
      return null;
    }
    return { elementTypeName: remaining, arrayDepth };
  }

  private splitIndexedAccessTypeName(typeName: string): { objectTypeName: string; indexTypeName: string } | null {
    const trimmed = typeName.trim();
    if (!trimmed.endsWith("]")) {
      return null;
    }

    let quote: string | null = null;
    let angleDepth = 0;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    for (let index = trimmed.length - 1; index >= 0; index -= 1) {
      const ch = trimmed[index]!;
      const previous = index > 0 ? trimmed[index - 1] : "";
      if (quote) {
        if (ch === quote && previous !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ">") angleDepth += 1;
      else if (ch === "<") angleDepth = Math.max(0, angleDepth - 1);
      else if (ch === ")") parenDepth += 1;
      else if (ch === "(") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "}") braceDepth += 1;
      else if (ch === "{") braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === "]") bracketDepth += 1;
      else if (ch === "[") {
        bracketDepth -= 1;
        if (bracketDepth === 0 && angleDepth === 0 && parenDepth === 0 && braceDepth === 0) {
          const objectTypeName = trimmed.slice(0, index).trim();
          const indexTypeName = trimmed.slice(index + 1, -1).trim();
          if (objectTypeName.length === 0 || indexTypeName.length === 0) {
            return null;
          }
          return { objectTypeName, indexTypeName };
        }
      }
    }
    return null;
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

    if (indexType.kind === "union") {
      const memberTypes = indexType.types.map((member) => this.indexedAccessType(objectType, member, node));
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }

    if (indexType.kind === "literal") {
      const propertyName = String(indexType.value);
      const propertyType = this.memberTypeFromObjectType(objectType, propertyName);
      if (propertyType) {
        return propertyType;
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
    }

    if (indexType.kind === "builtin" && indexType.name === "int") {
      return this.indexedAccessType(objectType, builtinType("number"), node);
    }

    return UNKNOWN_TYPE;
  }

  private propertyNamesForType(type: AnalysisType): string[] {
    if (type.kind === "object") {
      return Object.keys(type.properties).sort();
    }
    if (type.kind === "named") {
      return Array.from(this.resolveNamedTypeMembers(type)?.keys() ?? []).sort();
    }
    if (type.kind === "tuple") {
      return type.elements.map((_, index) => String(index));
    }
    return [];
  }

  private memberTypeFromObjectType(type: AnalysisType, propertyName: string): AnalysisType | null {
    if (type.kind === "object") {
      return type.properties[propertyName] ?? null;
    }
    if (type.kind === "named") {
      return this.resolveNamedTypeMembers(type)?.get(propertyName) ?? null;
    }
    if (type.kind === "tuple" && /^\d+$/.test(propertyName)) {
      return type.elements[Number(propertyName)] ?? null;
    }
    if (type.kind === "builtin") {
      const boxedName = this.boxedInterfaceNameForBuiltin(type.name);
      if (boxedName) {
        return this.resolveNamedTypeMembers(namedType(boxedName))?.get(propertyName) ?? null;
      }
    }
    if (type.kind === "literal") {
      const boxedName = this.boxedInterfaceNameForBuiltin(type.base);
      if (boxedName) {
        return this.resolveNamedTypeMembers(namedType(boxedName))?.get(propertyName) ?? null;
      }
    }
    return null;
  }

  private boxedInterfaceNameForBuiltin(name: string): string | null {
    if (name === "int" || name === "number" || name === "numeric") return "Number";
    if (name === "string") return "String";
    if (name === "boolean") return "Boolean";
    if (name === "bigint" || name === "long") return "BigInt";
    return null;
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
    if (!typeParameters || typeParameters.length === 0) {
      return;
    }
    this.validateTypeParameterConstraints(typeParameters, typeArguments, node, scope);
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

    this.activeTypeAliasNames.add(typeAlias.name.name);
    let targetType: AnalysisType = UNKNOWN_TYPE;
    this.withTypeParameters(typeParameters.map((parameter) => parameter.name.name), () => {
      targetType = this.resolveTypeNameText(typeAlias.targetType.name, typeAlias.targetType, scope, false);
    });
    this.activeTypeAliasNames.delete(typeAlias.name.name);

    return this.substituteTypeParameters(targetType, substitutions);
  }

  private withTypeParameters(typeParameters: string[], action: () => void): void {
    if (typeParameters.length <= 0) {
      action();
      return;
    }
    this.activeTypeParameterScopes.push(new Set(typeParameters));
    try {
      action();
    } finally {
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

  private isLValueExpression(expression: Expr): boolean {
    return expression.kind === "Identifier" || expression.kind === "MemberExpression";
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
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }

    const objectType = this.inferSimpleObjectType(member.object, scope);
    if (!objectType || objectType.kind !== "named") {
      return;
    }

    const propertyName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    const classStatement = this.classStatementsByName.get(objectType.name);
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
    if (parameter.rest !== true || parameterType.kind === "array" || isUnknownType(parameterType)) {
      return;
    }
    this.issues.push({
      message: `Rest parameter '${bindingNameText(parameter.name)}' must have an array type`,
      node: parameter.typeAnnotation ?? parameter.name
    });
  }

  private isIntType(type: AnalysisType): boolean {
    return (type.kind === "builtin" && type.name === "int") ||
      (type.kind === "literal" && type.base === "number" && Number.isInteger(type.value));
  }

  private isStringLikeType(type: AnalysisType): boolean {
    return (type.kind === "builtin" && type.name === "string") ||
      (type.kind === "literal" && type.base === "string");
  }

  private isBigIntType(type: AnalysisType): boolean {
    return type.kind === "builtin" && type.name === "bigint";
  }

  private isLongType(type: AnalysisType): boolean {
    return type.kind === "builtin" && type.name === "long";
  }

  private isNumberType(type: AnalysisType): boolean {
    return (type.kind === "builtin" && (type.name === "int" || type.name === "number")) ||
      (type.kind === "literal" && type.base === "number");
  }

  private isNumericType(type: AnalysisType): boolean {
    return type.kind === "builtin" && type.name === "numeric";
  }

  /**
   * Whether a type belongs to the numeric tower rooted at `numeric`:
   * `numeric` itself, the integer family (`int`/`number` and numeric literals)
   * and the big-integer family (`long`/`bigint`).
   */
  private isNumericFamilyType(type: AnalysisType): boolean {
    return this.isNumericType(type) ||
      this.isNumberType(type) ||
      this.isLongType(type) ||
      this.isBigIntType(type);
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
    if (this.isNumericFamilyType(a) && this.isNumericFamilyType(b)) {
      return builtinType("numeric");
    }
    return builtinType("any");
  }

  private contextualLiteralType(literal: AnalysisType, expectedType?: AnalysisType): AnalysisType | null {
    if (!expectedType || literal.kind !== "literal") {
      return null;
    }
    if (expectedType.kind === "literal" && this.isTypeAssignable(literal, expectedType)) {
      return expectedType;
    }
    if (expectedType.kind === "union") {
      return expectedType.types.find((member) => member.kind === "literal" && this.isTypeAssignable(literal, member)) ?? null;
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
        ? this.spreadArgumentElementType(visitedType)
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
        propertyName ? expectedProperties?.get(propertyName) : undefined
      );
      if (propertyName) {
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
    if (expectedType.kind === "object") {
      return new Map(Object.entries(expectedType.properties));
    }
    if (expectedType.kind === "named") {
      return this.resolveNamedTypeMembers(expectedType) ?? undefined;
    }
    return undefined;
  }

  private elementTypeFromIterable(type: AnalysisType): AnalysisType {
    if (type.kind === "array") {
      return type.elementType;
    }
    if (type.kind === "range") {
      return type.elementType;
    }
    return UNKNOWN_TYPE;
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

  private collectNamespaceStatements(program: Program): void {
    const visit = (statements: Statement[]): void => {
      for (const statement of statements) {
        const candidate = statement.kind === "ExportStatement" ? (statement as ExportStatement).declaration : statement;
        if (candidate?.kind !== "NamespaceStatement") continue;
        const namespaceStatement = candidate as NamespaceStatement;
        if (!namespaceStatement.globalAugmentation) {
          const name = namespaceStatement.names?.[0]?.name;
          if (name) {
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
    visit(program.body);
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

  private collectClassStatements(statements: readonly Statement[]): void {
    for (const classStatement of declarationIndexForStatements(statements).classes) {
      this.classStatementsByName.set(classStatement.name.name, classStatement);
    }
  }


  private collectImportedExtensionPropertyNames(program: Program): void {
    for (const statement of program.body) {
      if (statement.kind !== "ImportStatement") continue;
      for (const specifier of (statement as ImportStatement).specifiers) {
        this.importedExtensionPropertyNames.add((specifier.local ?? specifier.imported).name);
      }
    }
  }

  private extensionReceiverNames(objectType: AnalysisType): string[] {
    const receiverNames: string[] = [];
    if (objectType.kind === "builtin") {
      receiverNames.push(objectType.name);
      if (objectType.name === "int") receiverNames.push("number");
    } else if (objectType.kind === "named") {
      receiverNames.push(objectType.name);
    } else if (objectType.kind === "array" || objectType.kind === "tuple") {
      receiverNames.push("Array");
    }
    return receiverNames;
  }

  private resolveExtensionPropertyType(objectType: AnalysisType, propertyName: string): AnalysisType | null {
    const receiverNames = this.extensionReceiverNames(objectType);
    for (const receiverName of receiverNames) {
      const type = this.extensionPropertiesByReceiver.get(receiverName)?.get(propertyName);
      if (type) return type;
    }
    return null;
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

  private collectExtensionMethods(program: Program): void {
    for (const statement of program.body) {
      const candidate = statement.kind === "ExportStatement"
        ? (statement as ExportStatement).declaration
        : statement;
      if (candidate?.kind !== "FunctionStatement") continue;
      const extension = candidate as FunctionStatement;
      if (!extension.receiverType || extension.operator) continue;
      const methods = this.extensionMethodsByReceiver.get(extension.receiverType.name) ?? new Map<string, AnalysisType>();
      methods.set(extension.name.name, functionType(
        extension.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        this.typeFromAnnotationLoose(extension.returnType) ?? UNKNOWN_TYPE,
        extension.typeParameters?.map((parameter) => parameter.name.name)
      ));
      this.extensionMethodsByReceiver.set(extension.receiverType.name, methods);
    }
  }


  private collectExtensionOperators(program: Program): void {
    for (const statement of program.body) {
      const candidate = statement.kind === "ExportStatement"
        ? (statement as ExportStatement).declaration
        : statement;
      if (candidate?.kind !== "FunctionStatement") {
        continue;
      }
      const extension = candidate as FunctionStatement;
      if (!extension.receiverType || !extension.operator) {
        continue;
      }
      const receiverName = extension.receiverType.name;
      this.extensionOperatorsByReceiver.set(receiverName, [
        ...(this.extensionOperatorsByReceiver.get(receiverName) ?? []),
        extension
      ]);
    }
  }


  private collectEnumStatements(statements: readonly Statement[]): void {
    for (const enumStatement of declarationIndexForStatements(statements).enums) {
      this.enumStatementsByName.set(enumStatement.name.name, enumStatement);
    }
  }

  private collectInterfaceStatements(statements: readonly Statement[]): void {
    for (const interfaceStatement of declarationIndexForStatements(statements).interfaces) {
      const existing = this.interfaceStatementsByName.get(interfaceStatement.name.name);
      if (!existing) {
        this.interfaceStatementsByName.set(interfaceStatement.name.name, interfaceStatement);
        continue;
      }
      const merged: InterfaceStatement = {
        ...existing,
        members: [...existing.members, ...interfaceStatement.members],
      };
      const mergedTypeParameters = existing.typeParameters ?? interfaceStatement.typeParameters;
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
      this.interfaceStatementsByName.set(interfaceStatement.name.name, merged);
    }
  }

  private collectTypeAliasStatements(statements: readonly Statement[]): void {
    for (const typeAliasStatement of declarationIndexForStatements(statements).typeAliases) {
      this.typeAliasStatementsByName.set(typeAliasStatement.name.name, typeAliasStatement);
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
        this.namedTypeMembersCache.delete(name);
      }
    }
  }

  private resolveOptionalAccessType(type: AnalysisType, optional: boolean): AnalysisType {
    if (!optional || isUnknownType(type)) {
      return type;
    }
    if (type.kind === "union" && type.types.some((member) => member.kind === "builtin" && member.name === "undefined")) {
      return type;
    }
    return unionType([type, builtinType("undefined")]);
  }

  private validateKnownMemberAccess(member: MemberExpression, objectType: AnalysisType, scope: Scope): void {
    if (member.computed || member.property.kind !== "Identifier") {
      return;
    }

    const propertyName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    if (this.resolveExtensionMemberType(objectType, propertyName) || this.importedExtensionPropertyNames.has(propertyName)) {
      return;
    }

    const knownMembers = this.membersForType(objectType);
    if (!knownMembers) {
      return;
    }
    if (knownMembers.has(propertyName)) {
      this.validateMemberVisibility(member, objectType, propertyName, scope);
      return;
    }

    const displayType = objectType.kind === "named" ? objectType.name : typeToString(objectType);
    this.issues.push({
      message: `Property '${propertyName}' does not exist on type '${displayType}'`,
      node: member.property
    });
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

    const memberName = (member.property as Node & { kind: "Identifier"; name: string }).name;
    const extensionType = this.resolveExtensionMemberType(objectType, memberName);
    if (extensionType) {
      return extensionType;
    }
    if (this.importedExtensionPropertyNames.has(memberName)) {
      return UNKNOWN_TYPE;
    }
    if (objectType.kind === "union") {
      const memberTypes = objectType.types
        .filter((type) => !this.isNullishType(type))
        .map((type) => this.resolveKnownMemberType(member, type))
        .filter((type): type is AnalysisType => type !== null);
      if (memberTypes.length === 0) {
        return null;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (objectType.kind === "object") {
      return objectType.properties[memberName] ?? null;
    }
    if (objectType.kind === "array") {
      const arrayMembers = this.membersForArrayAlias(objectType);
      if (!arrayMembers) {
        return null;
      }
      return arrayMembers.get(memberName) ?? null;
    }
    if (objectType.kind !== "named") {
      return null;
    }

    const classMembers = this.resolveNamedTypeMembers(objectType);
    if (!classMembers) {
      return null;
    }
    return classMembers.get(memberName) ?? null;
  }

  private resolveComputedMemberType(objectType: AnalysisType, propertyType: AnalysisType): AnalysisType {
    if (objectType.kind === "union") {
      const memberTypes = objectType.types
        .filter((type) => !this.isNullishType(type))
        .map((type) => this.resolveComputedMemberType(type, propertyType))
        .filter((type) => !isUnknownType(type));
      if (memberTypes.length === 0) {
        return UNKNOWN_TYPE;
      }
      return memberTypes.length === 1 ? memberTypes[0]! : unionType(memberTypes);
    }
    if (objectType.kind === "array" && this.isIntType(propertyType)) {
      return objectType.elementType;
    }
    if (objectType.kind === "range" && this.isIntType(propertyType)) {
      return objectType.elementType;
    }
    return UNKNOWN_TYPE;
  }

  private isNullishType(type: AnalysisType): boolean {
    return type.kind === "builtin" && (type.name === "null" || type.name === "undefined");
  }

  private membersForType(type: AnalysisType): Map<string, AnalysisType> | null {
    if (type.kind === "union") {
      const merged = new Map<string, AnalysisType>();
      for (const memberType of type.types.filter((member) => !this.isNullishType(member))) {
        const members = this.membersForType(memberType);
        if (!members) {
          return null;
        }
        for (const [memberName, memberValueType] of members.entries()) {
          merged.set(memberName, memberValueType);
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
      const boxedName = this.boxedInterfaceNameForBuiltin(type.name);
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
      const returnType = this.typeFromAnnotationLoose(fn.returnType) ?? UNKNOWN_TYPE;
      const params = (fn.parameters ?? []).map((p) => ({
        name: typeof p.name === "object" && "name" in p.name ? (p.name as { name: string }).name : memberName,
        type: this.typeFromAnnotationLoose(p.typeAnnotation) ?? UNKNOWN_TYPE,
        optional: p.optional ?? false,
        rest: p.rest ?? false,
      }));
      return functionType(params, returnType);
    }
    if (candidate.kind === "VarStatement") {
      const v = candidate as VarStatement;
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

  private resolveNamedTypeMembers(type: AnalysisType & { kind: "named" }): Map<string, AnalysisType> | null {
    const cacheKey = typeToString(type);
    if (this.namedTypeMembersCache.has(cacheKey)) {
      return this.namedTypeMembersCache.get(cacheKey) ?? null;
    }

    const resolved = this.resolveNamedTypeMembersInternal(type, new Set<string>());
    this.namedTypeMembersCache.set(cacheKey, resolved);
    return resolved;
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
          if (name) members.set(name, memberType);
          if (child.kind === "ExportStatement") {
            for (const specifier of (child as ExportStatement).specifiers ?? []) {
              members.set(specifier.exported.name, UNKNOWN_TYPE);
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
        if (classMember.kind === "ClassFieldMember") {
          let fieldType = this.typeFromAnnotationLoose(classMember.typeAnnotation);
          if (!fieldType) {
            const classScope = this.bound.scopeByNode.get(classStatement);
            fieldType = classScope?.symbols.get(classMember.name.name)?.type ?? UNKNOWN_TYPE;
          }
          members.set(
            classMember.name.name,
            this.substituteTypeParameters(fieldType, substitutions)
          );
          continue;
        }

        const classScope = this.bound.scopeByNode.get(classStatement);
        const symbolType = classScope?.symbols.get(classMember.name.name)?.type;
        let rawReturnType = this.typeFromAnnotationLoose(classMember.returnType);
        if (!rawReturnType && symbolType?.kind === "function") {
          rawReturnType = symbolType?.kind === "function" ? symbolType.returnType : undefined;
        }
        rawReturnType ??= builtinType("void");
        const returnType = this.isAsyncLike(classMember) && !this.getAsyncReturnValueType(rawReturnType)
          ? namedType("Promise", [rawReturnType])
          : rawReturnType;
        if (classMember.accessorKind === "get") {
          members.set(classMember.name.name, this.substituteTypeParameters(returnType, substitutions));
          continue;
        }
        if (classMember.accessorKind === "set") {
          const parameterType = this.typeFromAnnotationLoose(classMember.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
          members.set(classMember.name.name, this.substituteTypeParameters(parameterType, substitutions));
          continue;
        }
        members.set(
          classMember.name.name,
          this.substituteTypeParameters(functionType(
            classMember.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
              name: bindingNameText(parameter.name),
              type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
              optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
              rest: parameter.rest === true
            })),
            returnType,
            classMember.typeParameters?.map((parameter) => parameter.name.name)
          ), substitutions)
        );
      }

      for (const classDelegate of classStatement.classDelegates ?? []) {
        const delegateType = this.substituteTypeParameters(
          this.typeFromTypeNameLoose(classDelegate.typeAnnotation.name),
          substitutions
        );
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
        const resolvedExtendsType = this.substituteTypeParameters(
          this.typeFromTypeNameLoose(classStatement.extendsType.name),
          substitutions
        );
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

      return members;
    }

    const members = new Map<string, AnalysisType>();
    const interfaceStatement = this.interfaceStatementsByName.get(type.name);
    if (!interfaceStatement) {
      return null;
    }
    const substitutions = this.typeParameterSubstitutions(interfaceStatement.typeParameters ?? [], type);
    for (const interfaceMember of interfaceStatement.members) {
      if (interfaceMember.kind === "InterfacePropertyMember") {
        const rawMemberType = this.typeFromAnnotationLoose(interfaceMember.typeAnnotation) ?? UNKNOWN_TYPE;
        const memberType = interfaceMember.optional === true
          ? unionType([rawMemberType, builtinType("undefined")])
          : rawMemberType;
        members.set(
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
            type: this.typeFromAnnotationLooseWithTypeParameters(parameter.typeAnnotation, availableTypeParameterNames) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
          })),
          this.typeFromAnnotationLooseWithTypeParameters(interfaceMember.returnType, availableTypeParameterNames) ?? builtinType("void"),
          methodTypeParameterNames,
          this.typeParameterConstraintMapLoose(interfaceMember.typeParameters ?? [], availableTypeParameterNames)
        );
      });
      members.set(
        interfaceMember.name.name,
        this.substituteTypeParameters(methodType, substitutions)
      );
    }

    for (const parentType of interfaceStatement.extendsTypes ?? []) {
      const resolvedParentType = this.substituteTypeParameters(
        this.typeFromTypeNameLoose(parentType.name),
        substitutions
      );
      if (resolvedParentType.kind !== "named") {
        continue;
      }
      const parentMembers = this.resolveNamedTypeMembersInternal(resolvedParentType, visited);
      if (!parentMembers) {
        continue;
      }
      for (const [memberName, memberType] of parentMembers.entries()) {
        if (!members.has(memberName)) {
          members.set(memberName, memberType);
        }
      }
    }

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

    addIfInterface(classStatement.extendsType);
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
        const actualType = this.typeToDiagnosticLabel(classMemberType);
        const expected = this.typeToDiagnosticLabel(expectedType);
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
        this.typeFromAnnotationLoose(classMember.returnType) ??
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

  private validateOverrideMembers(classStatement: ClassStatement): void {
    const overrideMembers = classStatement.members.filter((member) => member.override === true);
    if (overrideMembers.length === 0) {
      return;
    }

    if (!classStatement.extendsType) {
      for (const member of overrideMembers) {
        this.issues.push({
          message: `Member '${member.name.name}' cannot use 'override' because class '${classStatement.name.name}' does not extend another class`,
          node: member.name
        });
      }
      return;
    }

    const classTypeArguments = (classStatement.typeParameters ?? []).map((typeParameter) =>
      namedType(typeParameter.name.name)
    );
    const classType = namedType(classStatement.name.name, classTypeArguments);
    const classSubstitutions = this.typeParameterSubstitutions(classStatement.typeParameters ?? [], classType);
    const extendsType = this.substituteTypeParameters(
      this.typeFromTypeNameLoose(classStatement.extendsType.name),
      classSubstitutions
    );
    if (extendsType.kind !== "named") {
      return;
    }

    const baseMembers = this.resolveNamedTypeMembers(extendsType);
    if (!baseMembers) {
      return;
    }

    for (const member of overrideMembers) {
      const ownType = this.declaredClassMemberType(classStatement, member.name.name, classSubstitutions);
      if (!ownType) {
        continue;
      }
      const baseType = baseMembers.get(member.name.name);
      if (!baseType) {
        this.issues.push({
          message: `Member '${member.name.name}' cannot override because no member with that name exists in base type '${typeToString(extendsType)}'`,
          node: member.name
        });
        continue;
      }
      if (isSameType(ownType, baseType)) {
        continue;
      }
      this.issues.push({
        message: `Member '${member.name.name}' override type '${this.typeToDiagnosticLabel(ownType)}' does not match base type '${this.typeToDiagnosticLabel(baseType)}'`,
        node: member.name
      });
    }
  }

  private typeToDiagnosticLabel(type: AnalysisType): string {
    if (type.kind !== "function") {
      return typeToString(type);
    }

    const parameters = type.parameters
      .map((parameter) =>
        `${parameter.name}${parameter.optional === true ? "?" : ""}: ${this.typeToDiagnosticLabel(parameter.type)}`
      )
      .join(", ");
    return `(${parameters}) => ${this.typeToDiagnosticLabel(type.returnType)}`;
  }

  private typeFromAnnotationLoose(
    typeAnnotation: (Node & { kind: "Identifier"; name: string }) | undefined
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    const functionType = this.functionTypeFromAnnotationText(typeAnnotation.name);
    if (functionType) {
      return functionType;
    }
    if (this.looksLikeFunctionTypeAnnotation(typeAnnotation.name)) {
      return UNKNOWN_TYPE;
    }
    const objectType = this.objectTypeFromAnnotationText(typeAnnotation.name);
    if (objectType) {
      return objectType;
    }
    const computedType = this.typeFromComputedTypeNameLoose(typeAnnotation.name);
    if (computedType) {
      return computedType;
    }

    const parsed = parseTypeNameShape(typeAnnotation.name);
    let resolvedBase: AnalysisType;
    if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolvedBase = builtinType(
        parsed.baseName as BuiltinTypeName
      );
    } else {
      resolvedBase = namedType(
        parsed.baseName,
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
    const functionType = this.functionTypeFromAnnotationText(typeName);
    if (functionType) {
      return functionType;
    }
    if (this.looksLikeFunctionTypeAnnotation(typeName)) {
      return UNKNOWN_TYPE;
    }
    const objectType = this.objectTypeFromAnnotationText(typeName);
    if (objectType) {
      return objectType;
    }
    const computedType = this.typeFromComputedTypeNameLoose(typeName);
    if (computedType) {
      return computedType;
    }

    const parsed = parseTypeNameShape(typeName);
    let resolved: AnalysisType;
    if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      resolved = builtinType(
        parsed.baseName as BuiltinTypeName
      );
    } else {
      resolved = namedType(
        parsed.baseName,
        parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
      );
    }
    for (let i = 0; i < parsed.arrayDepth; i += 1) {
      resolved = arrayType(resolved);
    }
    return this.expandTypeAliases(resolved);
  }

  private expandTypeAliases(type: AnalysisType): AnalysisType {
    if (type.kind === "named") {
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
      this.activeTypeAliasNames.add(type.name);
      const targetType = this.typeFromTypeNameLoose(typeAlias.targetType.name);
      this.activeTypeAliasNames.delete(type.name);
      return this.expandTypeAliases(this.substituteTypeParameters(targetType, substitutions));
    }

    if (type.kind === "array") {
      return arrayType(this.expandTypeAliases(type.elementType));
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
        type.typeParameterConstraints
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
    typeParameters: Array<{ name: { name: string } }>,
    type: AnalysisType & { kind: "named" }
  ): Map<string, AnalysisType> {
    const substitutions = new Map<string, AnalysisType>();
    const typeArguments = type.typeArguments ?? [];
    for (let i = 0; i < typeParameters.length; i += 1) {
      const parameterName = typeParameters[i]?.name.name;
      if (!parameterName) {
        continue;
      }
      substitutions.set(parameterName, typeArguments[i] ?? namedType(parameterName));
    }
    return substitutions;
  }

  private substituteTypeParameters(
    sourceType: AnalysisType,
    substitutions: Map<string, AnalysisType>
  ): AnalysisType {
    if (sourceType.kind === "named") {
      if (!sourceType.typeArguments || sourceType.typeArguments.length === 0) {
        return substitutions.get(sourceType.name) ?? sourceType;
      }
      return namedType(
        sourceType.name,
        sourceType.typeArguments.map((typeArgument) =>
          this.substituteTypeParameters(typeArgument, substitutions)
        )
      );
    }

    if (sourceType.kind === "array") {
      return arrayType(this.substituteTypeParameters(sourceType.elementType, substitutions));
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
        substitutedConstraints
      );
    }

    if (sourceType.kind === "union") {
      return unionType(sourceType.types.map((type) => this.substituteTypeParameters(type, substitutions)));
    }

    if (sourceType.kind === "intersection") {
      return intersectionType(sourceType.types.map((type) => this.substituteTypeParameters(type, substitutions)));
    }

    if (sourceType.kind === "tuple") {
      return tupleType(sourceType.elements.map((element) => this.substituteTypeParameters(element, substitutions)));
    }

    return sourceType;
  }

  private resolveFunctionTypeAnnotation(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    const parsed = this.parseFunctionTypeAnnotation(typeName);
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
      this.resolveTypeNameText(parsed.returnTypeName, node, scope, false)
    );
  }

  private resolveObjectTypeAnnotation(typeName: string, node: Node, scope: Scope): AnalysisType | null {
    const members = this.parseObjectTypeAnnotation(typeName);
    if (!members) {
      return null;
    }
    const properties: Record<string, AnalysisType> = {};
    for (const member of members) {
      const propertyType = this.resolveTypeNameText(member.typeName, node, scope, false);
      properties[member.name] = member.optional
        ? unionType([propertyType, builtinType("undefined")])
        : propertyType;
    }
    return objectTypeWithProperties(properties);
  }

  private functionTypeFromAnnotationText(typeName: string): AnalysisType | null {
    const parsed = this.parseFunctionTypeAnnotation(typeName);
    if (!parsed) {
      return null;
    }
    return functionType(
      parsed.parameters.map((parameter) => ({
        name: parameter.name,
        type: this.typeFromTypeNameLoose(parameter.typeName),
        ...(parameter.optional ? { optional: true } : {}),
        ...(parameter.rest ? { rest: true } : {})
      })),
      this.typeFromTypeNameLoose(parsed.returnTypeName)
    );
  }

  private objectTypeFromAnnotationText(typeName: string): AnalysisType | null {
    const members = this.parseObjectTypeAnnotation(typeName);
    if (!members) {
      return null;
    }
    const properties: Record<string, AnalysisType> = {};
    for (const member of members) {
      const propertyType = this.typeFromTypeNameLoose(member.typeName);
      properties[member.name] = member.optional
        ? unionType([propertyType, builtinType("undefined")])
        : propertyType;
    }
    return objectTypeWithProperties(properties);
  }

  private parseFunctionTypeAnnotation(typeName: string): {
    parameters: Array<{ name: string; typeName: string; optional?: boolean; rest?: boolean }>;
    returnTypeName: string;
  } | null {
    const trimmed = typeName.trim();
    if (!trimmed.startsWith("(")) {
      return null;
    }

    const closeParenIndex = findMatchingTypeDelimiter(trimmed, 0, "(", ")");
    if (closeParenIndex < 0) {
      return null;
    }
    const afterParameters = trimmed.slice(closeParenIndex + 1).trimStart();
    if (!afterParameters.startsWith("=>")) {
      return null;
    }

    const parameterBody = trimmed.slice(1, closeParenIndex).trim();
    const parameters = parameterBody.length === 0
      ? []
      : splitTopLevelDelimitedTypeText(parameterBody).map((part, index) => {
          let text = part.trim();
          let rest = false;
          if (text.startsWith("...")) {
            rest = true;
            text = text.slice(3).trim();
          }

          const colonIndex = findTopLevelTypeCharacter(text, ":");
          if (colonIndex < 0) {
            return {
              name: `arg${index + 1}`,
              typeName: text.length > 0 ? text : "unknown",
              ...(rest ? { rest: true } : {})
            };
          }

          let name = text.slice(0, colonIndex).trim();
          const typeName = text.slice(colonIndex + 1).trim();
          let optional = false;
          if (name.endsWith("?")) {
            optional = true;
            name = name.slice(0, -1).trim();
          }
          return {
            name: name.length > 0 ? name : `arg${index + 1}`,
            typeName: typeName.length > 0 ? typeName : "unknown",
            ...(optional ? { optional: true } : {}),
            ...(rest ? { rest: true } : {})
          };
        });

    return {
      parameters,
      returnTypeName: afterParameters.slice(2).trim()
    };
  }

  private parseObjectTypeAnnotation(typeName: string): Array<{ name: string; typeName: string; optional?: boolean }> | null {
    const trimmed = typeName.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }

    const body = trimmed.slice(1, -1).trim();
    if (body.length === 0) {
      return [];
    }

    return splitTopLevelDelimitedTypeText(body, new Set([",", ";"])).map((part) => {
      const colonIndex = findTopLevelTypeCharacter(part, ":");
      if (colonIndex < 0) {
        return { name: part.trim(), typeName: "unknown" };
      }
      let name = part.slice(0, colonIndex).trim();
      const typeName = part.slice(colonIndex + 1).trim();
      let optional = false;
      if (name.endsWith("?")) {
        optional = true;
        name = name.slice(0, -1).trim();
      }
      if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
        name = name.slice(1, -1);
      }
      return {
        name,
        typeName: typeName.length > 0 ? typeName : "unknown",
        ...(optional ? { optional: true } : {})
      };
    });
  }

  private looksLikeFunctionTypeAnnotation(typeName: string): boolean {
    return typeName.includes("=>");
  }
}
