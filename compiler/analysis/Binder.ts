import type {
  BlockStatement,
  CatchClause,
  ClassMethodMember,
  ClassStatement,
  DoWhileStatement,
  EnumStatement,
  ForStatement,
  FunctionStatement,
  ExportStatement,
  Identifier,
  InterfaceStatement,
  ImportStatement,
  IfStatement,
  LabeledStatement,
  NamespaceStatement,
  Program,
  Statement,
  SwitchStatement,
  TypeAliasStatement,
  TypeAnnotation,
  TryStatement,
  VariableDeclarationKind,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import type { Node } from "compiler/ast/ast";
import {
  builtinType,
  functionType,
  isSameType,
  namedType,
  objectTypeWithProperties,
  typeToString,
  UNKNOWN_TYPE,
  unionType,
  BUILTIN_TYPE_NAMES
} from "./types";
import { findMatchingTypeDelimiter, findTopLevelTypeCharacter, parseTypeNameShape, splitOptionalTypeSuffix, splitTopLevelDelimitedTypeText } from "./typeNames";
import type { AnalysisType, BuiltinTypeName } from "./types";
import type { AnalysisSymbol, BoundAnalysis, Scope } from "./model";
import type { AnalysisIssue } from "./model";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { getVexaScriptRuntimeProgram } from "compiler/runtime/vexascriptDeclarations";
import { bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import { declarationIndexForStatements } from "./declarationIndex";

interface ImportedAnalysisSymbolResolution {
  type?: AnalysisType;
  displayType?: string;
}

const BUILTIN_IDENTIFIERS = new Map<string, ReturnType<typeof builtinType> | typeof UNKNOWN_TYPE>([
  ["true", builtinType("boolean")],
  ["false", builtinType("boolean")],
  ["null", builtinType("null")],
  ["undefined", builtinType("undefined")],
  ["console", objectTypeWithProperties({
    log: functionType([{ name: "args", type: UNKNOWN_TYPE, rest: true }], builtinType("void")),
    error: functionType([{ name: "args", type: UNKNOWN_TYPE, rest: true }], builtinType("void")),
    warn: functionType([{ name: "args", type: UNKNOWN_TYPE, rest: true }], builtinType("void")),
    info: functionType([{ name: "args", type: UNKNOWN_TYPE, rest: true }], builtinType("void"))
  })],
  ["setTimeout", functionType([
    { name: "code", type: functionType([], builtinType("void")) },
    { name: "time", type: builtinType("number") }
  ], builtinType("int"))],
  ["setInterval", functionType([
    { name: "code", type: functionType([], builtinType("void")) },
    { name: "time", type: builtinType("number") }
  ], builtinType("int"))]
]);

function symbolOffset(node: Node): number {
  return node.firstToken?.range.start.offset ?? -1;
}

function isReadonlyVariable(kind: VariableDeclarationKind): boolean {
  return kind === "const" || kind === "val";
}

function scopeHasGlobalPredeclaration(scope: Scope): boolean {
  return scope.node.kind === "Program" || scope.node.kind === "NamespaceStatement";
}

export class Binder {
  private readonly scopeByNode: WeakMap<Node, Scope> = new WeakMap();
  private readonly rootScope: Scope;
  private readonly classStatementsByName = new Map<string, ClassStatement>();
  private readonly interfaceStatementsByName = new Map<string, InterfaceStatement[]>();
  private readonly extensionsByReceiver = new Map<string, (FunctionStatement | VarStatement)[]>();
  private readonly issues: AnalysisIssue[] = [];

  constructor(
    private readonly program: Program,
    private readonly externalDeclarations: Statement[] = [],
    private readonly importedSymbolTypes: ReadonlyMap<string, AnalysisType> = new Map(),
    private readonly ambientDeclarations: Statement[] = [],
    private readonly importedSymbolDisplayTypes: ReadonlyMap<string, string> = new Map(),
    private readonly importedSymbols: ReadonlyMap<string, ImportedAnalysisSymbolResolution> = new Map()
  ) {
    this.rootScope = this.createScope(undefined, program);
  }

  private importedSymbolType(localName: string): AnalysisType {
    return this.importedSymbols.get(localName)?.type
      ?? this.importedSymbolTypes.get(localName)
      ?? UNKNOWN_TYPE;
  }

  private importedSymbolValueType(localName: string, resolvedType: AnalysisType): string {
    return this.importedSymbols.get(localName)?.displayType
      ?? this.importedSymbolDisplayTypes.get(localName)
      ?? typeToString(resolvedType);
  }

  bind(): BoundAnalysis {
    // External (imported) declarations are collected first so that same-file
    // declarations override them on name clashes.
    this.collectClassStatements(this.externalDeclarations);
    this.collectClassStatements(this.ambientDeclarations);
    this.collectClassStatements(this.program.body);
    // Interface declarations (including ambient runtime types such as `Array`)
    // feed implicit receiver member access inside extension methods/properties,
    // e.g. the `length` reference in `val <T> Array<T>.doubledLength => length`.
    this.collectInterfaceStatements(getEcmaScriptRuntimeProgram().body);
    this.collectInterfaceStatements(this.externalDeclarations);
    this.collectInterfaceStatements(this.ambientDeclarations);
    this.collectInterfaceStatements(this.program.body);
    this.collectExtensionStatements(this.externalDeclarations);
    this.collectExtensionStatements(this.ambientDeclarations);
    this.collectExtensionStatements(this.program.body);
    this.bindBuiltins();
    this.bindGlobalDeclarations(getVexaScriptRuntimeProgram().body, this.rootScope, -1);
    this.bindGlobalDeclarations(getEcmaScriptRuntimeProgram().body, this.rootScope, -1);
    this.bindGlobalDeclarations(this.ambientDeclarations, this.rootScope, -1);
    this.bindGlobalDeclarations(this.program.body, this.rootScope);
    this.bindStatements(this.program.body, this.rootScope);
    return {
      rootScope: this.rootScope,
      scopeByNode: this.scopeByNode,
      issues: [...this.issues]
    };
  }

  private createScope(parent: Scope | undefined, node: Node): Scope {
    const scope: Scope = {
      node,
      symbols: new Map<string, AnalysisSymbol>(),
      children: [],
      ...(parent ? { parent } : {})
    };
    if (parent) {
      parent.children.push(scope);
    }
    this.scopeByNode.set(node, scope);
    return scope;
  }

  private declare(
    scope: Scope,
    symbol: Omit<AnalysisSymbol, "declaredOffset">,
    declaredOffsetOverride?: number
  ): void {
    const existing = scope.symbols.get(symbol.name);
    if (existing?.node === symbol.node) {
      return;
    }
    if (existing?.implicitReceiver === true && symbol.implicitReceiver === true) {
      return;
    }
    const declaredOffset = declaredOffsetOverride ?? symbolOffset(symbol.node);
    if (
      existing &&
      (existing.kind === "variable" || existing.kind === "parameter") &&
      (symbol.kind === "variable" || symbol.kind === "parameter") &&
      existing.declaredOffset >= 0 &&
      declaredOffset >= 0
    ) {
      this.issues.push({
        message: `Duplicate declaration of '${symbol.name}'`,
        node: symbol.node
      });
      return;
    }
    if (existing?.kind === "function" && symbol.kind === "function" && existing.type && symbol.type) {
      const existingTypes = existing.type.kind === "union" ? existing.type.types : [existing.type];
      if (existingTypes.some((existingType) => existingType.kind === "function" && isSameType(existingType, symbol.type!))) {
        this.issues.push({
          message: `Duplicate function signature for '${symbol.name}'`,
          node: symbol.node
        });
        return;
      }
      const mergedType = unionType([...existingTypes, symbol.type]);
      existing.type = mergedType;
      existing.valueType = typeToString(mergedType);
      return;
    }
    if (
      existing?.kind === "function" &&
      symbol.kind === "class" &&
      symbol.type?.kind === "named" &&
      symbol.type.name === symbol.name
    ) {
      return;
    }
    scope.symbols.set(symbol.name, {
      ...symbol,
      declaredOffset
    });
  }

  private bindBuiltins(): void {
    for (const [name, symbolType] of BUILTIN_IDENTIFIERS) {
      this.declare(this.rootScope, {
        name,
        kind: "variable",
        node: this.program,
        type: symbolType,
        valueType: typeToString(symbolType)
      }, -1);
    }
  }

  private bindGlobalDeclarations(
    statements: Statement[],
    scope: Scope,
    declaredOffsetOverride?: number
  ): void {
    for (const facade of this.collectAmbientNamespaceExportFacades(statements)) {
      this.declare(scope, {
        name: facade.name.name,
        kind: facade.type.kind === "function" ? "function" : "variable",
        node: facade.name,
        type: facade.type,
        valueType: typeToString(facade.type)
      }, declaredOffsetOverride);
    }

    for (const statement of declarationIndexForStatements(statements).globalDeclarations) {
      if (statement.kind === "ExportStatement") {
        const exportStatement = statement as ExportStatement;
        if (exportStatement.declaration) {
          this.bindGlobalDeclarations([exportStatement.declaration], scope, declaredOffsetOverride);
        }
        continue;
      }

        if (statement.kind === "ImportStatement") {
          const importStatement = statement as ImportStatement;
          if (importStatement.defaultImport) {
          const resolvedType = this.importedSymbolType(importStatement.defaultImport.name);
          this.declare(scope, {
            name: importStatement.defaultImport.name,
            kind: resolvedType.kind === "function" ? "function" : "variable",
            node: importStatement.defaultImport,
            type: resolvedType,
            valueType: this.importedSymbolValueType(importStatement.defaultImport.name, resolvedType)
          }, declaredOffsetOverride);
        }
        if (importStatement.namespaceImport) {
          const resolvedType = this.importedSymbolType(importStatement.namespaceImport.name);
          this.declare(scope, {
            name: importStatement.namespaceImport.name,
            kind: resolvedType.kind === "function" ? "function" : "variable",
            node: importStatement.namespaceImport,
            type: resolvedType,
            valueType: this.importedSymbolValueType(importStatement.namespaceImport.name, resolvedType)
          }, declaredOffsetOverride);
        }
        for (const specifier of importStatement.specifiers) {
          const local = specifier.local ?? specifier.imported;
          // Prefer a cross-file resolved type when the importer provided one, so
          // imported values (e.g. functions returning a Promise) keep their type
          // instead of degrading to `unknown`.
          const resolvedType = this.importedSymbolType(local.name);
          this.declare(scope, {
            name: local.name,
            kind: resolvedType.kind === "function" ? "function" : "variable",
            node: local,
            type: resolvedType,
            valueType: this.importedSymbolValueType(local.name, resolvedType)
          }, declaredOffsetOverride);
        }
        continue;
      }

      if (statement.kind === "NamespaceStatement") {
        const namespaceStatement = statement as NamespaceStatement;
        if (namespaceStatement.globalAugmentation) {
          this.bindGlobalDeclarations(namespaceStatement.body.body, scope, declaredOffsetOverride);
          continue;
        }
        const name = namespaceStatement.names?.[0];
        if (name) {
          const symbolType = namedType(name.name);
          this.declare(scope, { name: name.name, kind: "class", node: name, type: symbolType, valueType: typeToString(symbolType) }, declaredOffsetOverride);
        }
        continue;
      }

      if (statement.kind === "VarStatement") {
        const variableStatement = statement as VarStatement;
        if (variableStatement.receiverType) {
          continue;
        }
        if (variableStatement.declarations && variableStatement.declarations.length > 0) {
          for (const declaration of variableStatement.declarations) {
            const symbolType = this.typeFromAnnotationLoose(declaration.typeAnnotation) ?? UNKNOWN_TYPE;
            this.declareBinding(scope, declaration.name, variableStatement.declarationKind, symbolType, declaredOffsetOverride);
          }
        } else {
          const symbolType = this.typeFromAnnotationLoose(variableStatement.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declareBinding(scope, variableStatement.name, variableStatement.declarationKind, symbolType, declaredOffsetOverride);
        }
        continue;
      }

      if (statement.kind === "FunctionStatement") {
        const functionStatement = statement as FunctionStatement;
        if (functionStatement.receiverType) {
          continue;
        }
        const fnIsAsyncLike = functionStatement.async === true || functionStatement.sync === true;
        const fnIsGenerator = functionStatement.generator === true;
        const symbolType = functionType(
          functionStatement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
            name: bindingNameText(parameter.name),
            type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
          })),
          this.effectiveReturnType(this.typeFromAnnotationLoose(functionStatement.returnType) ?? UNKNOWN_TYPE, fnIsAsyncLike, fnIsGenerator),
          functionStatement.typeParameters?.map((parameter) => parameter.name.name)
        );
        this.declare(scope, {
          name: functionStatement.name.name,
          kind: "function",
          node: functionStatement.name,
          type: symbolType,
          valueType: typeToString(symbolType)
        }, declaredOffsetOverride);
        continue;
      }

      if (statement.kind === "ClassStatement") {
        const classStatement = statement as ClassStatement;
        const symbolType = namedType(classStatement.name.name);
        this.declare(scope, {
          name: classStatement.name.name,
          kind: "class",
          node: classStatement.name,
          type: symbolType,
          valueType: typeToString(symbolType)
        }, declaredOffsetOverride);
        continue;
      }

      if (statement.kind === "EnumStatement") {
        const enumStatement = statement as EnumStatement;
        const symbolType = namedType(enumStatement.name.name);
        this.declare(scope, {
          name: enumStatement.name.name,
          kind: "class",
          node: enumStatement.name,
          type: symbolType,
          valueType: typeToString(symbolType)
        }, declaredOffsetOverride);
        continue;
      }

      if (statement.kind === "InterfaceStatement") {
        const interfaceStatement = statement as InterfaceStatement;
        // An interface only contributes to the type space. When a value symbol
        // already exists for the same name (for example `declare var Date:
        // DateConstructor` paired with `interface Date`), keep that value
        // symbol so member access on the value resolves against its declared
        // type (e.g. `Date.now()` on `DateConstructor`). Otherwise a later
        // `interface Date` merge would clobber the constructor value type with
        // the instance interface type.
        const existing = scope.symbols.get(interfaceStatement.name.name);
        if (existing && (existing.kind === "variable" || existing.kind === "function")) {
          continue;
        }
        const symbolType = namedType(interfaceStatement.name.name);
        this.declare(scope, {
          name: interfaceStatement.name.name,
          kind: "class",
          node: interfaceStatement.name,
          type: symbolType,
          valueType: typeToString(symbolType)
        }, declaredOffsetOverride);
        continue;
      }

      if (statement.kind === "TypeAliasStatement") {
        const typeAliasStatement = statement as TypeAliasStatement;
        const symbolType = this.typeFromAnnotationLoose(typeAliasStatement.targetType) ?? namedType(typeAliasStatement.name.name);
        this.declare(scope, {
          name: typeAliasStatement.name.name,
          kind: "class",
          node: typeAliasStatement.name,
          type: symbolType,
          valueType: typeToString(symbolType)
        }, declaredOffsetOverride);
        continue;
      }

      if (statement.kind === "AnnotationStatement") {
        const annotationStatement = statement as import("compiler/ast/ast").AnnotationStatement;
        this.declare(scope, {
          name: annotationStatement.name.name,
          kind: "annotation",
          node: annotationStatement.name,
          type: namedType(annotationStatement.name.name),
          valueType: `annotation ${annotationStatement.name.name}`
        }, declaredOffsetOverride);
      }
    }
  }

  private collectAmbientNamespaceExportFacades(
    statements: readonly Statement[]
  ): Array<{ name: Identifier; type: AnalysisType }> {
    const facades = [] as Array<{ name: Identifier; type: AnalysisType }>;
    const namespaceNames = new Set(
      declarationIndexForStatements([...statements]).namespaces
        .map((namespaceStatement) => namespaceStatement.names?.[0]?.name)
        .filter((name): name is string => !!name)
    );

    for (const statement of statements) {
      if (statement.kind !== "ExportStatement") {
        continue;
      }
      const exportStatement = statement as ExportStatement;
      if (!exportStatement.namespaceExport || exportStatement.from || exportStatement.typeOnly) {
        continue;
      }

      const facadeType = namespaceNames.has(exportStatement.namespaceExport.name)
        ? namedType(exportStatement.namespaceExport.name)
        : objectTypeWithProperties(this.collectAmbientNamespaceFacadeProperties(statements));
      facades.push({
        name: exportStatement.namespaceExport,
        type: facadeType
      });
    }

    return facades;
  }

  private collectAmbientNamespaceFacadeProperties(
    statements: readonly Statement[]
  ): Record<string, AnalysisType> {
    const properties: Record<string, AnalysisType> = {};

    for (const statement of statements) {
      if (statement.kind !== "ExportStatement") {
        continue;
      }
      const exportStatement = statement as ExportStatement;
      if (exportStatement.typeOnly || !exportStatement.declaration) {
        continue;
      }

      const declaration = exportStatement.declaration;
      if (declaration.kind === "FunctionStatement") {
        const functionStatement = declaration as FunctionStatement;
        const fnIsAsyncLike = functionStatement.async === true || functionStatement.sync === true;
        const fnIsGenerator = functionStatement.generator === true;
        properties[functionStatement.name.name] = functionType(
          functionStatement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
            name: bindingNameText(parameter.name),
            type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
          })),
          this.effectiveReturnType(this.typeFromAnnotationLoose(functionStatement.returnType) ?? UNKNOWN_TYPE, fnIsAsyncLike, fnIsGenerator),
          functionStatement.typeParameters?.map((parameter) => parameter.name.name)
        );
        continue;
      }

      if (declaration.kind === "VarStatement") {
        const variableStatement = declaration as VarStatement;
        const declarations = variableStatement.declarations && variableStatement.declarations.length > 0
          ? variableStatement.declarations
          : [{ name: variableStatement.name, typeAnnotation: variableStatement.typeAnnotation }];
        for (const variableDeclaration of declarations) {
          const symbolType = this.typeFromAnnotationLoose(variableDeclaration.typeAnnotation) ?? UNKNOWN_TYPE;
          for (const binding of bindingIdentifiers(variableDeclaration.name)) {
            properties[binding.name] = symbolType;
          }
        }
        continue;
      }

      if (declaration.kind === "ClassStatement") {
        properties[(declaration as ClassStatement).name.name] = namedType((declaration as ClassStatement).name.name);
        continue;
      }

      if (declaration.kind === "InterfaceStatement") {
        properties[(declaration as InterfaceStatement).name.name] = namedType((declaration as InterfaceStatement).name.name);
        continue;
      }

      if (declaration.kind === "TypeAliasStatement") {
        properties[(declaration as TypeAliasStatement).name.name] = namedType((declaration as TypeAliasStatement).name.name);
        continue;
      }

      if (declaration.kind === "EnumStatement") {
        properties[(declaration as EnumStatement).name.name] = namedType((declaration as EnumStatement).name.name);
        continue;
      }

      if (declaration.kind === "NamespaceStatement") {
        const namespaceName = (declaration as NamespaceStatement).names?.[0]?.name;
        if (namespaceName) {
          properties[namespaceName] = namedType(namespaceName);
        }
      }
    }

    return properties;
  }

  private bindStatements(statements: Statement[], scope: Scope): void {
    for (const statement of statements) {
      this.bindStatement(statement, scope);
    }
  }

  private bindStatement(statement: Statement, scope: Scope): void {
    switch (statement.kind) {
      case "ExportStatement": {
        const exportStatement = statement as ExportStatement;
        if (exportStatement.declaration) {
          this.bindStatement(exportStatement.declaration, scope);
        }
        return;
      }
      case "ImportStatement":
        return;
      case "VarStatement":
        this.bindVarStatement(statement as VarStatement, scope);
        return;
      case "FunctionStatement":
        this.bindFunctionStatement(statement as FunctionStatement, scope, true);
        return;
      case "ClassStatement":
        this.bindClassStatement(statement as ClassStatement, scope);
        return;
      case "EnumStatement":
        this.bindEnumStatement(statement as EnumStatement, scope);
        return;
      case "NamespaceStatement": {
        const namespaceStatement = statement as NamespaceStatement;
        if (namespaceStatement.globalAugmentation) {
          this.bindGlobalDeclarations(namespaceStatement.body.body, scope);
          this.bindStatements(namespaceStatement.body.body, scope);
          return;
        }
        const namespaceScope = this.createScope(scope, namespaceStatement);
        this.bindGlobalDeclarations(namespaceStatement.body.body, namespaceScope);
        this.bindStatements(namespaceStatement.body.body, namespaceScope);
        return;
      }
      case "InterfaceStatement":
      case "TypeAliasStatement":
      case "AnnotationStatement":
        return;
      case "BlockStatement": {
        const blockScope = this.createScope(scope, statement);
        this.bindStatements((statement as BlockStatement).body, blockScope);
        return;
      }
      case "WhileStatement": {
        const loopScope = this.createScope(scope, statement);
        this.bindStatement((statement as WhileStatement).body, loopScope);
        return;
      }
      case "DoWhileStatement": {
        const loopScope = this.createScope(scope, statement);
        this.bindStatement((statement as DoWhileStatement).body, loopScope);
        return;
      }
      case "ForStatement":
        this.bindForStatement(statement as ForStatement, scope);
        return;
      case "IfStatement":
        this.bindIfStatement(statement as IfStatement, scope);
        return;
      case "SwitchStatement":
        this.bindSwitchStatement(statement as SwitchStatement, scope);
        return;
      case "WithStatement": {
        const withScope = this.createScope(scope, statement);
        this.bindStatement((statement as WithStatement).body, withScope);
        return;
      }
      case "LabeledStatement":
        this.bindStatement((statement as LabeledStatement).body, scope);
        return;
      case "TryStatement":
        this.bindTryStatement(statement as TryStatement, scope);
        return;
      case "DeferStatement":
      case "ThrowStatement":
        return;
      default:
        return;
    }
  }

  private bindVarStatement(statement: VarStatement, scope: Scope): void {
    if (statement.receiverType) {
      const extensionScope = this.createScope(scope, statement);
      this.declareReceiverMembers(extensionScope, statement.receiverType.name);
      const receiverType = this.typeFromAnnotationLoose(statement.receiverType) ?? namedType(statement.receiverType.name);
      this.declare(extensionScope, {
        name: "this",
        kind: "variable",
        node: statement.receiverType,
        type: receiverType,
        valueType: typeToString(receiverType)
      }, -1);
      for (const accessor of statement.accessors ?? []) {
        const accessorScope = this.createScope(extensionScope, accessor);
        for (const parameter of accessor.parameters) {
          if (parameter.thisParameter === true) {
            continue;
          }
          const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declareParameterBinding(accessorScope, parameter.name, parameterType);
        }
        this.bindStatements(accessor.body.body, accessorScope);
      }
      return;
    }
    if (statement.declarations && statement.declarations.length > 0) {
      for (const declaration of statement.declarations) {
        const symbolType = this.typeFromAnnotationLoose(declaration.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declareBinding(scope, declaration.name, statement.declarationKind, symbolType);
      }
      return;
    }

    const symbolType = this.typeFromAnnotationLoose(statement.typeAnnotation) ?? UNKNOWN_TYPE;
    this.declareBinding(scope, statement.name, statement.declarationKind, symbolType);
  }

  private declareParameterBinding(scope: Scope, binding: VarStatement["name"], type: AnalysisType): void {
    for (const identifier of bindingIdentifiers(binding)) {
      this.declare(scope, {
        name: identifier.name,
        kind: "parameter",
        node: identifier,
        type,
        valueType: typeToString(type)
      });
    }
  }

  private declareBinding(scope: Scope, binding: VarStatement["name"], kind: VariableDeclarationKind, type: AnalysisType, declaredOffsetOverride?: number): void {
    for (const identifier of bindingIdentifiers(binding)) {
      this.declare(scope, {
        name: identifier.name,
        kind: "variable",
        node: identifier,
        isReadonly: isReadonlyVariable(kind),
        type,
        valueType: typeToString(type)
      }, declaredOffsetOverride);
    }
  }

  private bindFunctionStatement(statement: FunctionStatement, scope: Scope, declareInParent: boolean): void {
    if (declareInParent && !statement.receiverType && !(scopeHasGlobalPredeclaration(scope) && scope.symbols.has(statement.name.name))) {
      const stmtIsAsyncLike = statement.async === true || statement.sync === true;
      const stmtIsGenerator = statement.generator === true;
      const symbolType = functionType(
        statement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        this.effectiveReturnType(this.typeFromAnnotationLoose(statement.returnType) ?? UNKNOWN_TYPE, stmtIsAsyncLike, stmtIsGenerator),
        statement.typeParameters?.map((parameter) => parameter.name.name)
      );
      this.declare(scope, {
        name: statement.name.name,
        kind: "function",
        node: statement.name,
        type: symbolType,
        valueType: typeToString(symbolType)
      });
    }

    const functionScope = this.createScope(scope, statement);
    if (statement.receiverType) {
      this.declareReceiverMembers(functionScope, statement.receiverType.name);
      const receiverType = this.typeFromAnnotationLoose(statement.receiverType) ?? namedType(statement.receiverType.name);
      this.declare(functionScope, {
        name: "this",
        kind: "variable",
        node: statement.receiverType,
        type: receiverType,
        valueType: typeToString(receiverType)
      }, -1);
    }
    for (const parameter of statement.parameters) {
      if (parameter.thisParameter === true) {
        continue;
      }
      const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
      this.declareParameterBinding(functionScope, parameter.name, parameterType);
    }

    this.bindStatements(statement.body.body, functionScope);
  }

  private bindClassStatement(statement: ClassStatement, scope: Scope): void {
    this.declare(scope, {
      name: statement.name.name,
      kind: "class",
      node: statement.name,
      type: namedType(statement.name.name),
      valueType: statement.name.name
    });

    const classScope = this.createScope(scope, statement);
    this.declareClassMembers(classScope, statement);
    for (const member of statement.members) {
      if (member.kind === "ClassMethodMember") {
        const method = member as ClassMethodMember;
        if (method.accessorKind === "get") {
          const propertyType = this.typeFromAnnotationLoose(method.returnType) ?? UNKNOWN_TYPE;
          this.declare(classScope, {
            name: method.name.name,
            kind: "variable",
            node: method.name,
            type: propertyType,
            valueType: typeToString(propertyType)
          });
        } else if (method.accessorKind === "set") {
          if (!classScope.symbols.has(method.name.name)) {
            const propertyType = this.typeFromAnnotationLoose(method.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
            this.declare(classScope, {
              name: method.name.name,
              kind: "variable",
              node: method.name,
              type: propertyType,
              valueType: typeToString(propertyType)
            });
          }
        } else {
          const methodType = functionType(
            method.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
              name: bindingNameText(parameter.name),
              type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
              optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
              rest: parameter.rest === true
            })),
            this.typeFromAnnotationLoose(method.returnType) ?? UNKNOWN_TYPE,
            method.typeParameters?.map((parameter) => parameter.name.name)
          );
          this.declare(classScope, {
            name: method.name.name,
            kind: "method",
            node: method.name,
            type: methodType,
            valueType: typeToString(methodType)
          });
        }
        const methodScope = this.createScope(classScope, method);
        this.declare(methodScope, {
          name: "this",
          kind: "variable",
          node: statement.name,
          type: namedType(statement.name.name),
          valueType: statement.name.name
        }, -1);
        if (statement.extendsType) {
          const superType = this.typeFromAnnotationLoose(statement.extendsType) ?? namedType(statement.extendsType.name);
          this.declare(methodScope, {
            name: "super",
            kind: "variable",
            node: statement.extendsType,
            type: superType,
            valueType: typeToString(superType)
          }, -1);
        }
        for (const parameter of method.parameters) {
          if (parameter.thisParameter === true) {
            continue;
          }
          const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declareParameterBinding(methodScope, parameter.name, parameterType);
        }
        this.bindStatements(method.body.body, methodScope);
      }
    }
  }


  private collectClassStatements(statements: Statement[]): void {
    for (const classStatement of declarationIndexForStatements(statements).classes) {
      this.classStatementsByName.set(classStatement.name.name, classStatement);
    }
  }

  private collectInterfaceStatements(statements: Statement[]): void {
    for (const interfaceStatement of declarationIndexForStatements(statements).interfaces) {
      const existing = this.interfaceStatementsByName.get(interfaceStatement.name.name) ?? [];
      existing.push(interfaceStatement);
      this.interfaceStatementsByName.set(interfaceStatement.name.name, existing);
    }
  }

  private collectExtensionStatements(statements: Statement[]): void {
    const index = declarationIndexForStatements(statements);
    for (const fn of index.functions) {
      if (!fn.receiverType) continue;
      const existing = this.extensionsByReceiver.get(fn.receiverType.name) ?? [];
      existing.push(fn);
      this.extensionsByReceiver.set(fn.receiverType.name, existing);
    }
    for (const varStmt of index.vars) {
      if (!varStmt.receiverType) continue;
      const existing = this.extensionsByReceiver.get(varStmt.receiverType.name) ?? [];
      existing.push(varStmt);
      this.extensionsByReceiver.set(varStmt.receiverType.name, existing);
    }
  }

  private declareReceiverMembers(scope: Scope, receiverName: string): void {
    const classStatement = this.classStatementsByName.get(receiverName);
    if (classStatement) {
      this.declareClassMembers(scope, classStatement);
    } else {
      const interfaceStatements = this.interfaceStatementsByName.get(receiverName);
      if (interfaceStatements) {
        const visited = new Set<string>();
        for (const interfaceStatement of interfaceStatements) {
          this.declareInterfaceMembers(scope, interfaceStatement, visited);
        }
        this.declareInterfaceImplementorMembers(scope, receiverName);
      }
    }
    this.declareExtensionReceiverMembers(scope, receiverName);
  }

  private declareInterfaceImplementorMembers(scope: Scope, receiverName: string): void {
    for (const classStatement of this.classStatementsByName.values()) {
      if (!this.classMatchesInterfaceReceiver(classStatement, receiverName, new Set<string>())) {
        continue;
      }
      this.declareClassMembers(scope, classStatement);
    }
  }

  private classMatchesInterfaceReceiver(
    classStatement: ClassStatement,
    receiverName: string,
    visitedClasses: Set<string>
  ): boolean {
    if (visitedClasses.has(classStatement.name.name)) {
      return false;
    }
    visitedClasses.add(classStatement.name.name);

    for (const implementedType of classStatement.implementsTypes ?? []) {
      if (this.interfaceMatchesReceiver(implementedType.name, receiverName, new Set<string>())) {
        return true;
      }
    }

    if (!classStatement.extendsType) {
      return false;
    }

    if (this.interfaceMatchesReceiver(classStatement.extendsType.name, receiverName, new Set<string>())) {
      return true;
    }

    const baseClass = this.classStatementsByName.get(classStatement.extendsType.name);
    if (!baseClass) {
      return false;
    }

    return this.classMatchesInterfaceReceiver(baseClass, receiverName, visitedClasses);
  }

  private interfaceMatchesReceiver(
    interfaceName: string,
    receiverName: string,
    visitedInterfaces: Set<string>
  ): boolean {
    if (interfaceName === receiverName) {
      return true;
    }
    if (visitedInterfaces.has(interfaceName)) {
      return false;
    }
    visitedInterfaces.add(interfaceName);

    const interfaceStatements = this.interfaceStatementsByName.get(interfaceName);
    if (!interfaceStatements) {
      return false;
    }

    for (const interfaceStatement of interfaceStatements) {
      for (const parentType of interfaceStatement.extendsTypes ?? []) {
        if (this.interfaceMatchesReceiver(parentType.name, receiverName, visitedInterfaces)) {
          return true;
        }
      }
    }

    return false;
  }

  private declareExtensionReceiverMembers(scope: Scope, receiverName: string): void {
    const extensions = this.extensionsByReceiver.get(receiverName);
    if (!extensions) return;
    for (const ext of extensions) {
      if (ext.kind === "VarStatement") {
        const name = ext.name.kind === "Identifier" ? (ext.name as Identifier).name : null;
        if (!name) continue;
        const propertyType = this.typeFromAnnotationLoose(ext.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name,
          kind: "variable",
          node: ext.name as Identifier,
          implicitReceiver: true,
          implicitReceiverExtensionReceiver: receiverName,
          type: propertyType,
          valueType: typeToString(propertyType)
        });
      } else {
        const fn = ext as FunctionStatement;
        if (fn.operator || !fn.name) continue;
        const methodType = functionType(
          fn.parameters.filter((p) => p.thisParameter !== true).map((p) => ({
            name: bindingNameText(p.name),
            type: this.typeFromAnnotationLoose(p.typeAnnotation) ?? UNKNOWN_TYPE,
            optional: p.optional === true || p.defaultValue !== undefined || p.rest === true,
            rest: p.rest === true
          })),
          this.typeFromAnnotationLoose(fn.returnType) ?? UNKNOWN_TYPE,
          fn.typeParameters?.map((tp) => tp.name.name)
        );
        const existingMethod = scope.symbols.get(fn.name.name);
        if (existingMethod?.kind === "method" && existingMethod.type) {
          const existingTypes = existingMethod.type.kind === "union" ? existingMethod.type.types : [existingMethod.type];
          if (!existingTypes.some((t) => t.kind === "function" && isSameType(t, methodType))) {
            existingMethod.type = unionType([...existingTypes, methodType]);
            existingMethod.valueType = typeToString(existingMethod.type);
          }
          continue;
        }
        this.declare(scope, {
          name: fn.name.name,
          kind: "method",
          node: fn.name,
          implicitReceiver: true,
          implicitReceiverExtensionReceiver: receiverName,
          type: methodType,
          valueType: typeToString(methodType)
        });
      }
    }
  }

  private declareInterfaceMembers(scope: Scope, statement: InterfaceStatement, visited?: Set<string>): void {
    if (visited) {
      if (visited.has(statement.name.name)) return;
      visited.add(statement.name.name);
    }
    for (const extendedType of statement.extendsTypes ?? []) {
      const parentStatements = this.interfaceStatementsByName.get(extendedType.name);
      if (parentStatements) {
        const visitedSet = visited ?? new Set<string>();
        for (const parentStatement of parentStatements) {
          this.declareInterfaceMembers(scope, parentStatement, visitedSet);
        }
      }
    }
    for (const member of statement.members) {
      if (member.kind === "InterfacePropertyMember") {
        const propertyType = this.typeFromAnnotationLoose(member.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: member.name.name,
          kind: "variable",
          node: member.name,
          implicitReceiver: true,
          type: propertyType,
          valueType: typeToString(propertyType)
        });
        continue;
      }
      if (member.accessorKind === "get") {
        if (member.computed) {
          continue;
        }
        const propertyType = this.typeFromAnnotationLooseWithContext(member.returnType, statement.name.name) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: member.name.name,
          kind: "variable",
          node: member.name,
          implicitReceiver: true,
          type: propertyType,
          valueType: typeToString(propertyType)
        });
        continue;
      }
      if (member.accessorKind === "set") {
        if (member.computed) {
          continue;
        }
        if (!scope.symbols.has(member.name.name)) {
          const propertyType = this.typeFromAnnotationLoose(member.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declare(scope, {
            name: member.name.name,
            kind: "variable",
            node: member.name,
            implicitReceiver: true,
            type: propertyType,
            valueType: typeToString(propertyType)
          });
        }
        continue;
      }
      const methodType = functionType(
        member.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        this.typeFromAnnotationLooseWithContext(member.returnType, statement.name.name) ?? UNKNOWN_TYPE,
        member.typeParameters?.map((parameter) => parameter.name.name)
      );
      if (member.computed) {
        continue;
      }
      const existingMethod = scope.symbols.get(member.name.name);
      if (existingMethod?.kind === "method" && existingMethod.type) {
        const existingTypes = existingMethod.type.kind === "union" ? existingMethod.type.types : [existingMethod.type];
        if (!existingTypes.some((t) => t.kind === "function" && isSameType(t, methodType))) {
          const mergedType = unionType([...existingTypes, methodType]);
          existingMethod.type = mergedType;
          existingMethod.valueType = typeToString(mergedType);
        }
        continue;
      }
      this.declare(scope, {
        name: member.name.name,
        kind: "method",
        node: member.name,
        implicitReceiver: true,
        type: methodType,
        valueType: typeToString(methodType)
      });
    }
  }

  private declareClassMembers(scope: Scope, statement: ClassStatement, visited = new Set<string>()): void {
    if (visited.has(statement.name.name)) {
      return;
    }
    visited.add(statement.name.name);

    const baseClassName = statement.extendsType?.name;
    if (baseClassName) {
      const baseClass = this.classStatementsByName.get(baseClassName);
      if (baseClass) {
        this.declareClassMembers(scope, baseClass, visited);
      }
    }

    for (const parameter of statement.primaryConstructorParameters ?? []) {
      const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
      this.declare(scope, {
        name: bindingNameText(parameter.name),
        kind: "variable",
        node: parameter.name,
        isReadonly: isReadonlyVariable(parameter.declarationKind),
        implicitReceiver: true,
        type: parameterType,
        valueType: typeToString(parameterType)
      });
    }
    for (const constructor of statement.members.filter(
      (member): member is ClassMethodMember => member.kind === "ClassMethodMember" && member.name.name === "constructor"
    )) {
      for (const parameter of constructor.parameters.filter(
        (candidate) => candidate.accessModifier !== undefined || candidate.readonly === true
      )) {
        const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: bindingNameText(parameter.name),
          kind: "variable",
          node: parameter.name,
          isReadonly: parameter.readonly === true,
          implicitReceiver: true,
          type: parameterType,
          valueType: typeToString(parameterType)
        });
      }
    }
    const className = statement.name.name;
    for (const member of statement.members) {
      if (member.kind === "ClassFieldMember") {
        const fieldType = this.typeFromAnnotationLoose(member.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: member.name.name,
          kind: "variable",
          node: member.name,
          isReadonly: member.readonly === true,
          implicitReceiver: true,
          ...(member.static === true ? { implicitReceiverClassName: className } : {}),
          type: fieldType,
          valueType: typeToString(fieldType)
        });
        continue;
      }
      if (member.accessorKind === "get") {
        if (member.computed) {
          continue;
        }
        const propertyType = this.typeFromAnnotationLooseWithContext(member.returnType, className) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: member.name.name,
          kind: "variable",
          node: member.name,
          implicitReceiver: true,
          ...(member.static === true ? { implicitReceiverClassName: className } : {}),
          type: propertyType,
          valueType: typeToString(propertyType)
        });
        continue;
      }
      if (member.accessorKind === "set") {
        if (member.computed) {
          continue;
        }
        if (!scope.symbols.has(member.name.name)) {
          const propertyType = this.typeFromAnnotationLoose(member.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declare(scope, {
            name: member.name.name,
            kind: "variable",
            node: member.name,
            implicitReceiver: true,
            ...(member.static === true ? { implicitReceiverClassName: className } : {}),
            type: propertyType,
            valueType: typeToString(propertyType)
          });
        }
        continue;
      }
      const methodType = functionType(
        member.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        this.typeFromAnnotationLooseWithContext(member.returnType, className) ?? UNKNOWN_TYPE,
        member.typeParameters?.map((parameter) => parameter.name.name)
      );
      if (member.computed) {
        continue;
      }
      this.declare(scope, {
        name: member.name.name,
        kind: "method",
        node: member.name,
        implicitReceiver: true,
        ...(member.static === true ? { implicitReceiverClassName: className } : {}),
        type: methodType,
        valueType: typeToString(methodType)
      });
    }
  }


  private bindEnumStatement(statement: EnumStatement, scope: Scope): void {
    this.declare(scope, {
      name: statement.name.name,
      kind: "class",
      node: statement.name,
      type: namedType(statement.name.name),
      valueType: statement.name.name
    });

    const enumScope = this.createScope(scope, statement);
    for (const member of statement.members) {
      this.declare(enumScope, {
        name: member.name.name,
        kind: "variable",
        node: member.name,
        isReadonly: true,
        type: namedType(statement.name.name),
        valueType: statement.name.name
      });
    }
  }

  private bindForStatement(statement: ForStatement, scope: Scope): void {
    const loopScope = this.createScope(scope, statement);

    if (statement.iterationKind && statement.iterator && statement.iterable) {
      if (statement.iterator.kind === "VarStatement") {
        this.bindVarStatement(statement.iterator as VarStatement, loopScope);
      } else if (statement.iterator.kind === "Identifier") {
        const iteratorIdentifier = statement.iterator as Node & { kind: "Identifier"; name: string };
        this.declare(loopScope, {
          name: iteratorIdentifier.name,
          kind: "variable",
          node: iteratorIdentifier,
          type: UNKNOWN_TYPE,
          valueType: typeToString(UNKNOWN_TYPE)
        });
      }
      this.bindStatement(statement.body, loopScope);
      return;
    }

    if (statement.initializer && statement.initializer.kind === "VarStatement") {
      this.bindVarStatement(statement.initializer as VarStatement, loopScope);
    }
    this.bindStatement(statement.body, loopScope);
  }

  private bindIfStatement(statement: IfStatement, scope: Scope): void {
    const thenScope = this.createScope(scope, statement.thenBranch);
    this.bindStatement(statement.thenBranch, thenScope);

    if (statement.elseBranch) {
      const elseScope = this.createScope(scope, statement.elseBranch);
      this.bindStatement(statement.elseBranch, elseScope);
    }
  }

  private bindSwitchStatement(statement: SwitchStatement, scope: Scope): void {
    const switchScope = this.createScope(scope, statement);
    for (const switchCase of statement.cases) {
      const caseScope = this.createScope(switchScope, switchCase);
      this.bindStatements(switchCase.consequent, caseScope);
    }
  }

  private bindTryStatement(statement: TryStatement, scope: Scope): void {
    const tryScope = this.createScope(scope, statement.tryBlock);
    this.bindStatements(statement.tryBlock.body, tryScope);

    if (statement.catchClause) {
      this.bindCatchClause(statement.catchClause as CatchClause, scope);
    }

    if (statement.finallyBlock) {
      const finallyScope = this.createScope(scope, statement.finallyBlock);
      this.bindStatements(statement.finallyBlock.body, finallyScope);
    }
  }

  private bindCatchClause(catchClause: CatchClause, scope: Scope): void {
    const catchScope = this.createScope(scope, catchClause);
    if (catchClause.parameter) {
      this.declare(catchScope, {
        name: catchClause.parameter.name,
        kind: "variable",
        node: catchClause.parameter,
        type: UNKNOWN_TYPE,
        valueType: typeToString(UNKNOWN_TYPE)
      });
    }
    this.bindStatements(catchClause.body.body, catchScope);
  }

  private effectiveReturnType(rawReturnType: AnalysisType, isAsyncLike: boolean, isGenerator: boolean = false): AnalysisType {
    if (isGenerator) {
      const wrapperName = isAsyncLike ? "AsyncGenerator" : "Generator";
      if (rawReturnType.kind === "named" && (rawReturnType.name === "AsyncGenerator" || rawReturnType.name === "Generator" || rawReturnType.name === "AsyncIterator" || rawReturnType.name === "Iterator")) {
        return rawReturnType;
      }
      return namedType(wrapperName, [rawReturnType]);
    }
    if (!isAsyncLike) return rawReturnType;
    if (rawReturnType.kind === "named" && rawReturnType.name === "Promise") return rawReturnType;
    return namedType("Promise", [rawReturnType]);
  }

  private typeFromAnnotationLoose(typeAnnotation: TypeAnnotation | undefined) {
    if (!typeAnnotation) {
      return undefined;
    }
    if (typeAnnotation.kind === "ArrayTypeAnnotation") {
      return UNKNOWN_TYPE;
    }

    const typeName =
      typeAnnotation.kind === "TypeReference" ? typeAnnotation.name.name : typeAnnotation.name;

    const functionAnnotation = this.functionTypeFromAnnotationText(typeName);
    if (functionAnnotation) {
      return functionAnnotation;
    }

    const optionalSuffix = splitOptionalTypeSuffix(typeName);
    if (optionalSuffix.optional) {
      return unionType([
        this.typeFromTypeNameLoose(optionalSuffix.typeName),
        builtinType("undefined")
      ]);
    }

    const parsed = parseTypeNameShape(typeName);
    if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      return builtinType(parsed.baseName as BuiltinTypeName);
    }
    return namedType(
      parsed.baseName,
      parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
    );
  }

  private typeFromAnnotationLooseWithContext(
    typeAnnotation: TypeAnnotation | undefined,
    contextualThisTypeName?: string
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    const typeName = typeAnnotation.kind === "TypeReference" ? typeAnnotation.name.name : typeAnnotation.kind === "Identifier" ? typeAnnotation.name : undefined;
    if (
      contextualThisTypeName &&
      typeName === "this"
    ) {
      return this.typeFromTypeNameLoose(contextualThisTypeName);
    }
    return this.typeFromAnnotationLoose(typeAnnotation);
  }

  private typeFromTypeNameLoose(typeName: string): AnalysisType {
    const functionAnnotation = this.functionTypeFromAnnotationText(typeName);
    if (functionAnnotation) {
      return functionAnnotation;
    }
    const optionalSuffix = splitOptionalTypeSuffix(typeName);
    if (optionalSuffix.optional) {
      return unionType([
        this.typeFromTypeNameLoose(optionalSuffix.typeName),
        builtinType("undefined")
      ]);
    }
    const parsed = parseTypeNameShape(typeName);
    if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      return builtinType(parsed.baseName as BuiltinTypeName);
    }
    return namedType(
      parsed.baseName,
      parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
    );
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
          const nestedTypeName = text.slice(colonIndex + 1).trim();
          let optional = false;
          if (name.endsWith("?")) {
            optional = true;
            name = name.slice(0, -1).trim();
          }
          return {
            name: name.length > 0 ? name : `arg${index + 1}`,
            typeName: nestedTypeName.length > 0 ? nestedTypeName : "unknown",
            ...(optional ? { optional: true } : {}),
            ...(rest ? { rest: true } : {})
          };
        });
    return { parameters, returnTypeName: afterParameters.slice(2).trim() };
  }
}
