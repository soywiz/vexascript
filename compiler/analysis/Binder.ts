import { AnnotationStatement, ArrayTypeAnnotation, ClassFieldMember, ClassMethodMember, ClassStatement, EnumStatement, ExportStatement, FunctionStatement, Identifier, ImportStatement, InterfacePropertyMember, InterfaceStatement, NamespaceStatement, NodeKind, nodeStartOffset, Program, TypeAliasStatement, TypeReference, VarStatement } from "compiler/ast/ast";
import type { BlockStatement, CatchClause, DoWhileStatement, ForStatement, FunctionParameter, IfStatement, InterfaceMethodMember, LabeledStatement, Node, Statement, SwitchStatement, TryStatement, TypeAnnotation, TypeParameter, VariableDeclarationKind, WhileStatement, WithStatement } from "compiler/ast/ast";


import {
    arrayType,
  builtinType,
  functionType,
  isSameType,
  namedType,
  objectTypeWithProperties,
  tupleType,
  typeToString,
  UNKNOWN_TYPE,
  unionType,
  BUILTIN_TYPE_NAMES, UnionType, FunctionType, FunctionTypeParameter, NamedType
} from "./types";
import { parseFunctionTypeAnnotation, parseTypeNameShape, splitArraySuffixTypeName, splitOptionalTypeSuffix, splitTopLevelDelimitedTypeText, tupleElementTypeText } from "./typeNames";
import type { AnalysisType, BuiltinTypeName } from "./types";
import { AnalysisSymbol, Scope } from "./model";
import type { BoundAnalysis } from "./model";
import type { AnalysisIssue } from "./model";
import { ANALYSIS_ISSUE_CODES } from "./issueCodes";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations.shared";
import { getVexaScriptRuntimeProgram } from "compiler/runtime/vexascriptDeclarations.shared";
import { bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";
import { declarationIndexForStatements } from "./declarationIndex";
import type { ImportedSymbolResolution } from "compiler/importedSymbols";

function noFunctionParameters(): FunctionTypeParameter[] {
  return [];
}

const BUILTIN_IDENTIFIERS = new Map<string, ReturnType<typeof builtinType> | typeof UNKNOWN_TYPE>([
  ["true", builtinType("boolean")],
  ["false", builtinType("boolean")],
  ["null", builtinType("null")],
  ["undefined", builtinType("undefined")],
  ["console", objectTypeWithProperties({
    log: functionType([new FunctionTypeParameter("args", UNKNOWN_TYPE, undefined, undefined, true)], builtinType("void")),
    error: functionType([new FunctionTypeParameter("args", UNKNOWN_TYPE, undefined, undefined, true)], builtinType("void")),
    warn: functionType([new FunctionTypeParameter("args", UNKNOWN_TYPE, undefined, undefined, true)], builtinType("void")),
    info: functionType([new FunctionTypeParameter("args", UNKNOWN_TYPE, undefined, undefined, true)], builtinType("void"))
  })],
  ["setTimeout", functionType([
    new FunctionTypeParameter("code", functionType(noFunctionParameters(), builtinType("void"))),
    new FunctionTypeParameter("time", builtinType("number")),
    new FunctionTypeParameter("arguments", UNKNOWN_TYPE, undefined, undefined, true)
  ], builtinType("int"))],
  ["setInterval", functionType([
    new FunctionTypeParameter("code", functionType(noFunctionParameters(), builtinType("void"))),
    new FunctionTypeParameter("time", builtinType("number")),
    new FunctionTypeParameter("arguments", UNKNOWN_TYPE, undefined, undefined, true)
  ], builtinType("int"))],
  ["clearTimeout", functionType([
    new FunctionTypeParameter("id", builtinType("int"))
  ], builtinType("void"))],
  ["clearInterval", functionType([
    new FunctionTypeParameter("id", builtinType("int"))
  ], builtinType("void"))],
  ["readTextFile", functionType([
    new FunctionTypeParameter("path", builtinType("string"))
  ], namedType("Promise", [builtinType("string")]))]
]);

function symbolOffset(node: Node): number {
  return nodeStartOffset(node) ?? -1;
}

function typeParameterNames(parameters: readonly TypeParameter[] | undefined): string[] | undefined {
  if (!parameters) return undefined;
  const names: string[] = [];
  for (const parameter of parameters) names.push(parameter.name.name);
  return names;
}

function isReadonlyVariable(kind: VariableDeclarationKind): boolean {
  return kind === "const" || kind === "val";
}

function scopeHasGlobalPredeclaration(scope: Scope): boolean {
  return scope.node instanceof Program || scope.node instanceof NamespaceStatement;
}

export class Binder {
  private readonly scopeByNode: WeakMap<Node, Scope> = new WeakMap<Node, Scope>();
  private readonly rootScope: Scope;
  private readonly classStatementsByName = new Map<string, ClassStatement>();
  private readonly interfaceStatementsByName = new Map<string, InterfaceStatement[]>();
  private readonly extensionsByReceiver = new Map<string, (FunctionStatement | VarStatement)[]>();
  private readonly duplicateClassVariableNodes = new WeakSet<Node>();
  private readonly issues: AnalysisIssue[] = [];

  constructor(
    private readonly program: Program,
    private readonly externalDeclarations: Statement[] = [],
    private readonly ambientDeclarations: Statement[] = [],
    private readonly importedSymbols: ReadonlyMap<string, ImportedSymbolResolution> = new Map()
  ) {
    this.rootScope = this.createScope(undefined, program);
  }

  private importedSymbolType(localName: string): AnalysisType {
    return this.importedSymbols.get(localName)?.type ?? UNKNOWN_TYPE;
  }

  private importedSymbolValueType(localName: string, resolvedType: AnalysisType): string {
    return this.importedSymbols.get(localName)?.displayType ?? typeToString(resolvedType);
  }

  bind(): BoundAnalysis {
    const vexaRuntimeProgram = getVexaScriptRuntimeProgram();
    // External (imported) declarations are collected first so that same-file
    // declarations override them on name clashes.
    this.collectClassStatements(this.externalDeclarations);
    this.collectClassStatements(this.ambientDeclarations);
    this.collectClassStatements(vexaRuntimeProgram.body);
    this.collectClassStatements(this.program.body);
    // Interface declarations (including ambient runtime types such as `Array`)
    // feed implicit receiver member access inside extension methods/properties,
    // e.g. the `length` reference in `val <T> Array<T>.doubledLength => length`.
    this.collectInterfaceStatements(getEcmaScriptRuntimeProgram().body);
    this.collectInterfaceStatements(vexaRuntimeProgram.body);
    this.collectInterfaceStatements(this.externalDeclarations);
    this.collectInterfaceStatements(this.ambientDeclarations);
    this.collectInterfaceStatements(this.program.body);
    this.collectExtensionStatements(vexaRuntimeProgram.body);
    this.collectExtensionStatements(this.externalDeclarations);
    this.collectExtensionStatements(this.ambientDeclarations);
    this.collectExtensionStatements(this.program.body);
    this.bindBuiltins();
    this.bindGlobalDeclarations(vexaRuntimeProgram.body, this.rootScope, -1);
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
    const scope = new Scope(node, new Map<string, AnalysisSymbol>(), [], parent);
    if (parent) {
      parent.children.push(scope);
    }
    this.scopeByNode.set(node, scope);
    return scope;
  }

  private declare(
    scope: Scope,
    symbol: AnalysisSymbol,
    declaredOffsetOverride?: number
  ): void {
    const existing = scope.symbols.get(symbol.name);
    if (existing?.node === symbol.node) {
      return;
    }
    if (existing?.implicitReceiver === true && symbol.implicitReceiver === true) {
      return;
    }
    const declaredOffset: number = declaredOffsetOverride === undefined
      ? symbolOffset(symbol.node)
      : Number(declaredOffsetOverride);
    if (
      existing &&
      (existing.kind === "variable" || existing.kind === "parameter") &&
      (symbol.kind === "variable" || symbol.kind === "parameter") &&
      existing.declaredOffset >= 0 &&
      declaredOffset >= 0
    ) {
      if (this.duplicateClassVariableNodes.has(symbol.node)) {
        return;
      }
      this.issues.push({
        message: `Duplicate declaration of '${symbol.name}'`,
        node: symbol.node
      });
      return;
    }
    if (existing?.kind === "function" && symbol.kind === "function" && existing.type && symbol.type) {
      const existingTypes: AnalysisType[] = [];
      if (existing.type instanceof UnionType) existingTypes.push(...existing.type.types);
      else existingTypes.push(existing.type);
      if (existingTypes.some((existingType) => existingType instanceof FunctionType && isSameType(existingType, symbol.type!))) {
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
      symbol.type instanceof NamedType &&
      symbol.type.name === symbol.name
    ) {
      return;
    }
    symbol.declaredOffset = declaredOffset;
    scope.symbols.set(symbol.name, symbol);
  }

  private bindBuiltins(): void {
    for (const [name, symbolType] of BUILTIN_IDENTIFIERS) {
      this.declare(this.rootScope, new AnalysisSymbol(name, "variable", this.program, -1, undefined, undefined, undefined, undefined, symbolType, typeToString(symbolType)), -1);
    }
  }

  private bindGlobalDeclarations(
    statements: Statement[],
    scope: Scope,
    declaredOffsetOverride?: number
  ): void {
    for (const facade of this.collectAmbientNamespaceExportFacades(statements)) {
      this.declare(scope, new AnalysisSymbol(facade.name.name, facade.type instanceof FunctionType ? "function" : "variable", facade.name, -1, undefined, undefined, undefined, undefined, facade.type, typeToString(facade.type)), declaredOffsetOverride);
    }

    for (const statement of declarationIndexForStatements(statements).globalDeclarations) {
      if (statement instanceof ExportStatement) {
        const exportStatement = statement as ExportStatement;
        if (exportStatement.declaration) {
          this.bindGlobalDeclarations([exportStatement.declaration], scope, declaredOffsetOverride);
        }
        continue;
      }

        if (statement instanceof ImportStatement) {
          const importStatement = statement as ImportStatement;
          if (importStatement.defaultImport) {
          const resolvedType = this.importedSymbolType(importStatement.defaultImport.name);
          this.declare(scope, new AnalysisSymbol(importStatement.defaultImport.name, resolvedType instanceof FunctionType ? "function" : "variable", importStatement.defaultImport, -1, undefined, undefined, undefined, undefined, resolvedType, this.importedSymbolValueType(importStatement.defaultImport.name, resolvedType)), declaredOffsetOverride);
        }
        if (importStatement.namespaceImport) {
          const resolvedType = this.importedSymbolType(importStatement.namespaceImport.name);
          this.declare(scope, new AnalysisSymbol(importStatement.namespaceImport.name, resolvedType instanceof FunctionType ? "function" : "variable", importStatement.namespaceImport, -1, undefined, undefined, undefined, undefined, resolvedType, this.importedSymbolValueType(importStatement.namespaceImport.name, resolvedType)), declaredOffsetOverride);
        }
        for (const specifier of importStatement.specifiers) {
          const local = specifier.local ?? specifier.imported;
          // Prefer a cross-file resolved type when the importer provided one, so
          // imported values (e.g. functions returning a Promise) keep their type
          // instead of degrading to `unknown`.
          const resolvedType = this.importedSymbolType(local.name);
          this.declare(scope, new AnalysisSymbol(local.name, resolvedType instanceof FunctionType ? "function" : "variable", local, -1, undefined, undefined, undefined, undefined, resolvedType, this.importedSymbolValueType(local.name, resolvedType)), declaredOffsetOverride);
        }
        continue;
      }

      if (statement instanceof NamespaceStatement) {
        const namespaceStatement = statement as NamespaceStatement;
        if (namespaceStatement.globalAugmentation) {
          this.bindGlobalDeclarations(namespaceStatement.body.body, scope, declaredOffsetOverride);
          continue;
        }
        const name = namespaceStatement.names?.[0];
        if (name) {
          const symbolType = namedType(name.name);
          this.declare(scope, new AnalysisSymbol(name.name, "class", name, -1, undefined, undefined, undefined, undefined, symbolType, typeToString(symbolType)), declaredOffsetOverride);
        }
        continue;
      }

      if (statement instanceof VarStatement) {
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

      if (statement instanceof FunctionStatement) {
        const functionStatement = statement as FunctionStatement;
        if (functionStatement.receiverType) {
          continue;
        }
        const fnIsAsyncLike = functionStatement.async === true || functionStatement.sync === true;
        const fnIsGenerator = functionStatement.generator === true;
        const symbolType = functionType(
          functionStatement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => new FunctionTypeParameter(
            bindingNameText(parameter.name),
            this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            undefined,
            parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            parameter.rest === true
          )),
          this.effectiveReturnType(this.typeFromAnnotationLoose(functionStatement.returnType) ?? UNKNOWN_TYPE, fnIsAsyncLike, fnIsGenerator),
          typeParameterNames(functionStatement.typeParameters)
        );
        this.declare(scope, new AnalysisSymbol(functionStatement.name.name, "function", functionStatement.name, -1, undefined, undefined, undefined, undefined, symbolType, typeToString(symbolType)), declaredOffsetOverride);
        continue;
      }

      if (statement instanceof ClassStatement) {
        const classStatement = statement as ClassStatement;
        const symbolType = namedType(classStatement.name.name);
        this.declare(scope, new AnalysisSymbol(classStatement.name.name, "class", classStatement.name, -1, undefined, undefined, undefined, undefined, symbolType, typeToString(symbolType)), declaredOffsetOverride);
        continue;
      }

      if (statement instanceof EnumStatement) {
        const enumStatement = statement as EnumStatement;
        const symbolType = namedType(enumStatement.name.name);
        this.declare(scope, new AnalysisSymbol(enumStatement.name.name, "class", enumStatement.name, -1, undefined, undefined, undefined, undefined, symbolType, typeToString(symbolType)), declaredOffsetOverride);
        continue;
      }

      if (statement instanceof InterfaceStatement) {
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
        this.declare(scope, new AnalysisSymbol(interfaceStatement.name.name, "class", interfaceStatement.name, -1, undefined, undefined, undefined, undefined, symbolType, typeToString(symbolType)), declaredOffsetOverride);
        continue;
      }

      if (statement instanceof TypeAliasStatement) {
        const typeAliasStatement = statement as TypeAliasStatement;
        const symbolType = this.typeFromAnnotationLoose(typeAliasStatement.targetType) ?? namedType(typeAliasStatement.name.name);
        this.declare(scope, new AnalysisSymbol(typeAliasStatement.name.name, "class", typeAliasStatement.name, -1, undefined, undefined, undefined, undefined, symbolType, typeToString(symbolType)), declaredOffsetOverride);
        continue;
      }

      if (statement instanceof AnnotationStatement) {
        const annotationStatement = statement as AnnotationStatement;
        this.declare(scope, new AnalysisSymbol(annotationStatement.name.name, "annotation", annotationStatement.name, -1, undefined, undefined, undefined, undefined, namedType(annotationStatement.name.name), `annotation ${annotationStatement.name.name}`), declaredOffsetOverride);
      }
    }
  }

  private collectAmbientNamespaceExportFacades(
    statements: readonly Statement[]
  ): Array<{ name: Identifier; type: AnalysisType }> {
    const facades = [] as Array<{ name: Identifier; type: AnalysisType }>;
    const namespaceNames = new Set(
      declarationIndexForStatements([...statements]).namespaces
        .map((namespaceStatement) => {
          const firstName: Identifier | undefined = namespaceStatement.names?.[0];
          return firstName?.name;
        })
        .filter((name): name is string => !!name)
    );

    for (const statement of statements) {
      if (!(statement instanceof ExportStatement)) {
        continue;
      }
      const exportStatement = statement as ExportStatement;
      if (!exportStatement.namespaceExport || exportStatement.from || exportStatement.typeOnly) {
        continue;
      }

      const facadeType: AnalysisType = namespaceNames.has(exportStatement.namespaceExport.name)
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
      if (!(statement instanceof ExportStatement)) {
        continue;
      }
      const exportStatement = statement as ExportStatement;
      if (exportStatement.typeOnly || !exportStatement.declaration) {
        continue;
      }

      const declaration = exportStatement.declaration;
      if (declaration instanceof FunctionStatement) {
        const functionStatement = declaration as FunctionStatement;
        const fnIsAsyncLike = functionStatement.async === true || functionStatement.sync === true;
        const fnIsGenerator = functionStatement.generator === true;
        properties[functionStatement.name.name] = functionType(
          functionStatement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => new FunctionTypeParameter(
            bindingNameText(parameter.name),
            this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            undefined,
            parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            parameter.rest === true
          )),
          this.effectiveReturnType(this.typeFromAnnotationLoose(functionStatement.returnType) ?? UNKNOWN_TYPE, fnIsAsyncLike, fnIsGenerator),
          typeParameterNames(functionStatement.typeParameters)
        );
        continue;
      }

      if (declaration instanceof VarStatement) {
        const variableStatement = declaration as VarStatement;
        if (variableStatement.declarations && variableStatement.declarations.length > 0) {
          for (const variableDeclaration of variableStatement.declarations) {
            const symbolType = this.typeFromAnnotationLoose(variableDeclaration.typeAnnotation) ?? UNKNOWN_TYPE;
            for (const binding of bindingIdentifiers(variableDeclaration.name)) {
              properties[binding.name] = symbolType;
            }
          }
        } else {
          const symbolType = this.typeFromAnnotationLoose(variableStatement.typeAnnotation) ?? UNKNOWN_TYPE;
          for (const binding of bindingIdentifiers(variableStatement.name)) {
            properties[binding.name] = symbolType;
          }
        }
        continue;
      }

      if (declaration instanceof ClassStatement) {
        properties[(declaration as ClassStatement).name.name] = namedType((declaration as ClassStatement).name.name);
        continue;
      }

      if (declaration instanceof InterfaceStatement) {
        properties[(declaration as InterfaceStatement).name.name] = namedType((declaration as InterfaceStatement).name.name);
        continue;
      }

      if (declaration instanceof TypeAliasStatement) {
        properties[(declaration as TypeAliasStatement).name.name] = namedType((declaration as TypeAliasStatement).name.name);
        continue;
      }

      if (declaration instanceof EnumStatement) {
        properties[(declaration as EnumStatement).name.name] = namedType((declaration as EnumStatement).name.name);
        continue;
      }

      if (declaration instanceof NamespaceStatement) {
        const firstName: Identifier | undefined = (declaration as NamespaceStatement).names?.[0];
        const namespaceName = firstName?.name;
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
      case NodeKind.ExportStatement: {
        const exportStatement = statement as ExportStatement;
        if (exportStatement.declaration) {
          this.bindStatement(exportStatement.declaration, scope);
        }
        return;
      }
      case NodeKind.ImportStatement:
        return;
      case NodeKind.VarStatement:
        this.bindVarStatement(statement as VarStatement, scope);
        return;
      case NodeKind.FunctionStatement:
        this.bindFunctionStatement(statement as FunctionStatement, scope, true);
        return;
      case NodeKind.ClassStatement:
        this.bindClassStatement(statement as ClassStatement, scope);
        return;
      case NodeKind.EnumStatement:
        this.bindEnumStatement(statement as EnumStatement, scope);
        return;
      case NodeKind.NamespaceStatement: {
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
      case NodeKind.InterfaceStatement:
      case NodeKind.TypeAliasStatement:
      case NodeKind.AnnotationStatement:
        return;
      case NodeKind.BlockStatement: {
        const blockScope = this.createScope(scope, statement);
        this.bindStatements((statement as BlockStatement).body, blockScope);
        return;
      }
      case NodeKind.WhileStatement: {
        const loopScope = this.createScope(scope, statement);
        this.bindStatement((statement as WhileStatement).body, loopScope);
        return;
      }
      case NodeKind.DoWhileStatement: {
        const loopScope = this.createScope(scope, statement);
        this.bindStatement((statement as DoWhileStatement).body, loopScope);
        return;
      }
      case NodeKind.ForStatement:
        this.bindForStatement(statement as ForStatement, scope);
        return;
      case NodeKind.IfStatement:
        this.bindIfStatement(statement as IfStatement, scope);
        return;
      case NodeKind.SwitchStatement:
        this.bindSwitchStatement(statement as SwitchStatement, scope);
        return;
      case NodeKind.WithStatement: {
        const withScope = this.createScope(scope, statement);
        this.bindStatement((statement as WithStatement).body, withScope);
        return;
      }
      case NodeKind.LabeledStatement:
        this.bindStatement((statement as LabeledStatement).body, scope);
        return;
      case NodeKind.TryStatement:
        this.bindTryStatement(statement as TryStatement, scope);
        return;
      case NodeKind.DeferStatement:
      case NodeKind.ThrowStatement:
        return;
      default:
        return;
    }
  }

  private bindVarStatement(statement: VarStatement, scope: Scope): void {
    if (statement.receiverType) {
      const extensionScope = this.createScope(scope, statement);
      this.declareReceiverMembers(extensionScope, statement.receiverType.name);
      const receiverType = this.typeFromReceiverAnnotation(statement.receiverType, statement.receiverTypeArguments);
      this.declare(extensionScope, new AnalysisSymbol("this", "variable", statement.receiverType, -1, undefined, undefined, undefined, undefined, receiverType, typeToString(receiverType)), -1);
      if (statement.accessors) {
        for (const accessor of statement.accessors) {
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
      this.declare(scope, new AnalysisSymbol(identifier.name, "parameter", identifier, -1, undefined, undefined, undefined, undefined, type, typeToString(type)));
    }
  }

  private declareBinding(scope: Scope, binding: VarStatement["name"], kind: VariableDeclarationKind, type: AnalysisType, declaredOffsetOverride?: number): void {
    for (const identifier of bindingIdentifiers(binding)) {
      this.declare(scope, new AnalysisSymbol(identifier.name, "variable", identifier, -1, isReadonlyVariable(kind), undefined, undefined, undefined, type, typeToString(type)), declaredOffsetOverride);
    }
  }

  private bindFunctionStatement(statement: FunctionStatement, scope: Scope, declareInParent: boolean): void {
    if (declareInParent && !statement.receiverType && !(scopeHasGlobalPredeclaration(scope) && scope.symbols.has(statement.name.name))) {
      const stmtIsAsyncLike = statement.async === true || statement.sync === true;
      const stmtIsGenerator = statement.generator === true;
      const symbolType = functionType(
        statement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => new FunctionTypeParameter(
          bindingNameText(parameter.name),
          this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          undefined,
          parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          parameter.rest === true
        )),
        this.effectiveReturnType(this.typeFromAnnotationLoose(statement.returnType) ?? UNKNOWN_TYPE, stmtIsAsyncLike, stmtIsGenerator),
        typeParameterNames(statement.typeParameters)
      );
      this.declare(scope, new AnalysisSymbol(statement.name.name, "function", statement.name, -1, undefined, undefined, undefined, undefined, symbolType, typeToString(symbolType)));
    }

    const functionScope = this.createScope(scope, statement);
    if (statement.receiverType) {
      this.declareReceiverMembers(functionScope, statement.receiverType.name);
      const receiverType = this.typeFromReceiverAnnotation(statement.receiverType, statement.receiverTypeArguments);
      this.declare(functionScope, new AnalysisSymbol("this", "variable", statement.receiverType, -1, undefined, undefined, undefined, undefined, receiverType, typeToString(receiverType)), -1);
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
    this.declare(scope, new AnalysisSymbol(statement.name.name, "class", statement.name, -1, undefined, undefined, undefined, undefined, namedType(statement.name.name), statement.name.name));

    const classScope = this.createScope(scope, statement);
    this.reportDuplicateClassVariables(statement);
    this.declareClassMembers(classScope, statement);
    for (const member of statement.members) {
      if (member instanceof ClassMethodMember) {
        const method = member as ClassMethodMember;
        if (method.accessorKind === "get" || method.getterShorthand === true) {
          const propertyType = this.typeFromAnnotationLoose(method.returnType) ?? UNKNOWN_TYPE;
          this.declare(classScope, new AnalysisSymbol(method.name.name, "variable", method.name, -1, undefined, undefined, undefined, undefined, propertyType, typeToString(propertyType)));
        } else if (method.accessorKind === "set") {
          if (!classScope.symbols.has(method.name.name)) {
            const propertyType = this.typeFromAnnotationLoose(method.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
            this.declare(classScope, new AnalysisSymbol(method.name.name, "variable", method.name, -1, undefined, undefined, undefined, undefined, propertyType, typeToString(propertyType)));
          }
        } else {
          const methodType = functionType(
            method.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => new FunctionTypeParameter(
              bindingNameText(parameter.name),
              this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
              undefined,
              parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
              parameter.rest === true
            )),
            this.typeFromAnnotationLoose(method.returnType) ?? UNKNOWN_TYPE,
            typeParameterNames(method.typeParameters)
          );
          this.declare(classScope, new AnalysisSymbol(method.name.name, "method", method.name, -1, undefined, undefined, undefined, undefined, methodType, typeToString(methodType)));
        }
        const methodScope = this.createScope(classScope, method);
        this.declare(methodScope, new AnalysisSymbol("this", "variable", statement.name, -1, undefined, undefined, undefined, undefined, namedType(statement.name.name), statement.name.name), -1);
        if (statement.extendsType) {
          const superType = this.typeFromAnnotationLoose(statement.extendsType) ?? namedType(statement.extendsType.name);
          this.declare(methodScope, new AnalysisSymbol("super", "variable", statement.extendsType, -1, undefined, undefined, undefined, undefined, superType, typeToString(superType)), -1);
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


  private reportDuplicateClassVariables(statement: ClassStatement): void {
    const fieldsByName = new Map<string, Identifier[]>();
    for (const member of statement.members) {
      if (!(member instanceof ClassFieldMember)) {
        continue;
      }
      const field = member as ClassFieldMember;
      if (field.computed) {
        continue;
      }
      const fields: Identifier[] = fieldsByName.get(field.name.name) ?? [];
      fields.push(field.name);
      fieldsByName.set(field.name.name, fields);
    }

    for (const [name, fields] of fieldsByName) {
      if (fields.length < 2) {
        continue;
      }
      for (const field of fields) {
        this.duplicateClassVariableNodes.add(field);
        this.issues.push({
          message: `Duplicate class variable '${name}'`,
          node: field,
          code: ANALYSIS_ISSUE_CODES.DUPLICATE_CLASS_VARIABLE
        });
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

    if (classStatement.implementsTypes) {
      for (const implementedType of classStatement.implementsTypes) {
        if (this.interfaceMatchesReceiver(implementedType.name, receiverName, new Set<string>())) {
          return true;
        }
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
      const currentInterface = interfaceStatement as InterfaceStatement;
      if (currentInterface.extendsTypes) {
        for (const parentType of currentInterface.extendsTypes) {
          if (this.interfaceMatchesReceiver(parentType.name, receiverName, visitedInterfaces)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private declareExtensionReceiverMembers(scope: Scope, receiverName: string): void {
    const extensions = this.extensionsByReceiver.get(receiverName);
    if (!extensions) return;
    for (const candidate of extensions) {
      const ext = candidate as Statement;
      if (ext instanceof VarStatement) {
        const property = ext as VarStatement;
        if (!(property.name instanceof Identifier)) continue;
        const name = (property.name as Identifier).name;
        const propertyType = this.typeFromAnnotationLoose(property.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, new AnalysisSymbol(name, "variable", property.name as Identifier, -1, undefined, true, undefined, receiverName, propertyType, typeToString(propertyType)));
      } else {
        const fn = candidate as FunctionStatement;
        if (fn.operator || !fn.name) continue;
        const methodType = functionType(
          fn.parameters.filter((p) => p.thisParameter !== true).map((p) => new FunctionTypeParameter(
            bindingNameText(p.name),
            this.typeFromAnnotationLoose(p.typeAnnotation) ?? UNKNOWN_TYPE,
            undefined,
            p.optional === true || p.defaultValue !== undefined || p.rest === true,
            p.rest === true
          )),
          this.typeFromAnnotationLoose(fn.returnType) ?? UNKNOWN_TYPE,
          typeParameterNames(fn.typeParameters)
        );
        const existingMethod = scope.symbols.get(fn.name.name);
        if (existingMethod?.kind === "method" && existingMethod.type) {
          const existingTypes: AnalysisType[] = [];
          if (existingMethod.type instanceof UnionType) existingTypes.push(...existingMethod.type.types);
          else existingTypes.push(existingMethod.type);
          if (!existingTypes.some((t) => t instanceof FunctionType && isSameType(t, methodType))) {
            existingMethod.type = unionType([...existingTypes, methodType]);
            existingMethod.valueType = typeToString(existingMethod.type);
          }
          continue;
        }
        this.declare(scope, new AnalysisSymbol(fn.name.name, "method", fn.name, -1, undefined, true, undefined, receiverName, methodType, typeToString(methodType)));
      }
    }
  }

  private declareInterfaceMembers(scope: Scope, statement: InterfaceStatement, visited?: Set<string>): void {
    if (visited) {
      if (visited.has(statement.name.name)) return;
      visited.add(statement.name.name);
    }
    if (statement.extendsTypes) {
      for (const extendedType of statement.extendsTypes) {
        const parentStatements = this.interfaceStatementsByName.get(extendedType.name);
        if (parentStatements) {
          const visitedSet = visited ?? new Set<string>();
          for (const parentStatement of parentStatements) {
            this.declareInterfaceMembers(scope, parentStatement, visitedSet);
          }
        }
      }
    }
    for (const member of statement.members) {
      if (member instanceof InterfacePropertyMember) {
        const property = member as InterfacePropertyMember;
        const propertyType = this.typeFromAnnotationLoose(property.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, new AnalysisSymbol(property.name.name, "variable", property.name, -1, undefined, true, undefined, undefined, propertyType, typeToString(propertyType)));
        continue;
      }
      const method = member as InterfaceMethodMember;
      if (method.accessorKind === "get") {
        if (method.computed) {
          continue;
        }
        const propertyType = this.typeFromAnnotationLooseWithContext(method.returnType, statement.name.name) ?? UNKNOWN_TYPE;
        this.declare(scope, new AnalysisSymbol(method.name.name, "variable", method.name, -1, undefined, true, undefined, undefined, propertyType, typeToString(propertyType)));
        continue;
      }
      if (method.accessorKind === "set") {
        if (method.computed) {
          continue;
        }
        if (!scope.symbols.has(method.name.name)) {
          const propertyType = this.typeFromAnnotationLoose(method.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declare(scope, new AnalysisSymbol(method.name.name, "variable", method.name, -1, undefined, true, undefined, undefined, propertyType, typeToString(propertyType)));
        }
        continue;
      }
      const methodType = functionType(
        method.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => new FunctionTypeParameter(
          bindingNameText(parameter.name),
          this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          undefined,
          parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          parameter.rest === true
        )),
        this.typeFromAnnotationLooseWithContext(method.returnType, statement.name.name) ?? UNKNOWN_TYPE,
        typeParameterNames(method.typeParameters)
      );
      if (method.computed) {
        continue;
      }
      const existingMethod = scope.symbols.get(method.name.name);
      if (existingMethod?.kind === "method" && existingMethod.type) {
        const existingTypes: AnalysisType[] = [];
        if (existingMethod.type instanceof UnionType) existingTypes.push(...existingMethod.type.types);
        else existingTypes.push(existingMethod.type);
        if (!existingTypes.some((t) => t instanceof FunctionType && isSameType(t, methodType))) {
          const mergedType = unionType([...existingTypes, methodType]);
          existingMethod.type = mergedType;
          existingMethod.valueType = typeToString(mergedType);
        }
        continue;
      }
      this.declare(scope, new AnalysisSymbol(method.name.name, "method", method.name, -1, undefined, true, undefined, undefined, methodType, typeToString(methodType)));
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

    if (statement.primaryConstructorParameters) {
      for (const parameter of statement.primaryConstructorParameters) {
        const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, new AnalysisSymbol(bindingNameText(parameter.name), "variable", parameter.name, -1, isReadonlyVariable(parameter.declarationKind), true, undefined, undefined, parameterType, typeToString(parameterType)));
      }
    }
    for (const candidate of statement.members) {
      if (!(candidate instanceof ClassMethodMember)) continue;
      const constructor = candidate as ClassMethodMember;
      if (constructor.name.name !== "constructor") continue;
      for (const parameterCandidate of constructor.parameters) {
        const parameter = parameterCandidate as FunctionParameter;
        if (parameter.accessModifier === undefined && parameter.isReadonly !== true) continue;
        const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, new AnalysisSymbol(bindingNameText(parameter.name), "variable", parameter.name, -1, parameter.isReadonly === true, true, undefined, undefined, parameterType, typeToString(parameterType)));
      }
    }
    const className = statement.name.name;
    for (const member of statement.members) {
      if (member instanceof ClassFieldMember) {
        const field = member as ClassFieldMember;
        const fieldType = this.typeFromAnnotationLoose(field.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, new AnalysisSymbol(
          field.name.name,
          "variable",
          field.name,
          -1,
          field.isReadonly === true,
          true,
          field.isStatic === true ? className : undefined,
          undefined,
          fieldType,
          typeToString(fieldType)
        ));
        continue;
      }
      const method = member as ClassMethodMember;
      if (method.accessorKind === "get" || method.getterShorthand === true) {
        if (method.computed) {
          continue;
        }
        const propertyType = this.typeFromAnnotationLooseWithContext(method.returnType, className) ?? UNKNOWN_TYPE;
        this.declare(scope, new AnalysisSymbol(
          method.name.name,
          "variable",
          method.name,
          -1,
          undefined,
          true,
          method.isStatic === true ? className : undefined,
          undefined,
          propertyType,
          typeToString(propertyType)
        ));
        continue;
      }
      if (method.accessorKind === "set") {
        if (method.computed) {
          continue;
        }
        if (!scope.symbols.has(method.name.name)) {
          const propertyType = this.typeFromAnnotationLoose(method.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declare(scope, new AnalysisSymbol(
            method.name.name,
            "variable",
            method.name,
            -1,
            undefined,
            true,
            method.isStatic === true ? className : undefined,
            undefined,
            propertyType,
            typeToString(propertyType)
          ));
        }
        continue;
      }
      const methodType = functionType(
        method.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => new FunctionTypeParameter(
          bindingNameText(parameter.name),
          this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          undefined,
          parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          parameter.rest === true
        )),
        this.typeFromAnnotationLooseWithContext(method.returnType, className) ?? UNKNOWN_TYPE,
        typeParameterNames(method.typeParameters)
      );
      if (method.computed) {
        continue;
      }
      this.declare(scope, new AnalysisSymbol(
        method.name.name,
        "method",
        method.name,
        -1,
        undefined,
        true,
        method.isStatic === true ? className : undefined,
        undefined,
        methodType,
        typeToString(methodType)
      ));
    }
  }


  private bindEnumStatement(statement: EnumStatement, scope: Scope): void {
    this.declare(scope, new AnalysisSymbol(statement.name.name, "class", statement.name, -1, undefined, undefined, undefined, undefined, namedType(statement.name.name), statement.name.name));

    const enumScope = this.createScope(scope, statement);
    for (const member of statement.members) {
      this.declare(enumScope, new AnalysisSymbol(member.name.name, "variable", member.name, -1, true, undefined, undefined, undefined, namedType(statement.name.name), statement.name.name));
    }
  }

  private bindForStatement(statement: ForStatement, scope: Scope): void {
    const loopScope = this.createScope(scope, statement);

    if (statement.iterationKind && statement.iterator && statement.iterable) {
      if (statement.iterator instanceof VarStatement) {
        this.bindVarStatement(statement.iterator as VarStatement, loopScope);
      } else if (statement.iterator instanceof Identifier) {
        const iteratorIdentifier = statement.iterator as Identifier;
        this.declare(loopScope, new AnalysisSymbol(iteratorIdentifier.name, "variable", iteratorIdentifier, -1, undefined, undefined, undefined, undefined, UNKNOWN_TYPE, typeToString(UNKNOWN_TYPE)));
      }
      this.bindStatement(statement.body, loopScope);
      return;
    }

    if (statement.initializer && statement.initializer instanceof VarStatement) {
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
      this.declare(catchScope, new AnalysisSymbol(catchClause.parameter.name, "variable", catchClause.parameter, -1, undefined, undefined, undefined, undefined, UNKNOWN_TYPE, typeToString(UNKNOWN_TYPE)));
    }
    this.bindStatements(catchClause.body.body, catchScope);
  }

  private effectiveReturnType(rawReturnType: AnalysisType, isAsyncLike: boolean, isGenerator: boolean = false): AnalysisType {
    if (isGenerator) {
      const wrapperName = isAsyncLike ? "AsyncGenerator" : "Generator";
      if (rawReturnType instanceof NamedType && (rawReturnType.name === "AsyncGenerator" || rawReturnType.name === "Generator" || rawReturnType.name === "AsyncIterator" || rawReturnType.name === "Iterator")) {
        return rawReturnType;
      }
      return namedType(wrapperName, [rawReturnType]);
    }
    if (!isAsyncLike) return rawReturnType;
    if (rawReturnType instanceof NamedType && rawReturnType.name === "Promise") return rawReturnType;
    return namedType("Promise", [rawReturnType]);
  }

  private typeFromAnnotationLoose(typeAnnotation: TypeAnnotation | undefined): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    if (typeAnnotation instanceof ArrayTypeAnnotation) {
      return arrayType(this.typeFromAnnotationLoose(typeAnnotation.elementType) ?? UNKNOWN_TYPE);
    }

    const typeName =
      typeAnnotation instanceof TypeReference ? typeAnnotation.name.name : typeAnnotation.name;

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
    return this.typeFromTypeNameLoose(typeName);
  }

  private typeFromReceiverAnnotation(receiverType: Identifier, receiverTypeArguments?: Identifier[]): AnalysisType {
    if (!receiverTypeArguments || receiverTypeArguments.length === 0) {
      return this.typeFromAnnotationLoose(receiverType) ?? namedType(receiverType.name);
    }
    return namedType(
      receiverType.name,
      receiverTypeArguments.map((argument): AnalysisType => this.typeFromAnnotationLoose(argument) ?? UNKNOWN_TYPE)
    );
  }

  private typeFromAnnotationLooseWithContext(
    typeAnnotation: TypeAnnotation | undefined,
    contextualThisTypeName?: string
  ): AnalysisType | undefined {
    if (!typeAnnotation) {
      return undefined;
    }
    if (typeAnnotation instanceof ArrayTypeAnnotation) {
      return arrayType(
        this.typeFromAnnotationLooseWithContext(typeAnnotation.elementType, contextualThisTypeName) ?? UNKNOWN_TYPE
      );
    }
    const typeName = typeAnnotation instanceof TypeReference ? typeAnnotation.name.name : typeAnnotation instanceof Identifier ? typeAnnotation.name : undefined;
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
    const arraySuffix = splitArraySuffixTypeName(typeName);
    if (arraySuffix) {
      let elementType = this.typeFromTypeNameLoose(arraySuffix.elementTypeName);
      for (let i = 0; i < arraySuffix.arrayDepth; i += 1) {
        elementType = arrayType(elementType);
      }
      return elementType;
    }
    const normalizedTypeName = typeName.trim();
    if (normalizedTypeName.startsWith("[") && normalizedTypeName.endsWith("]")) {
      const tupleBody = normalizedTypeName.slice(1, -1).trim();
      return tupleType(
        tupleBody.length === 0
          ? []
          : splitTopLevelDelimitedTypeText(tupleBody).map((part): AnalysisType =>
            this.typeFromTypeNameLoose(tupleElementTypeText(part))
          )
      );
    }
    const parsed = parseTypeNameShape(typeName);
    let resolved: AnalysisType = BUILTIN_TYPE_NAMES.has(parsed.baseName)
      ? builtinType(parsed.baseName as BuiltinTypeName)
      : namedType(
      parsed.baseName,
      parsed.typeArguments.map((typeArgument): AnalysisType => this.typeFromTypeNameLoose(typeArgument))
    );
    for (let i = 0; i < parsed.arrayDepth; i += 1) {
      resolved = arrayType(resolved);
    }
    return resolved;
  }

  private functionTypeFromAnnotationText(typeName: string): AnalysisType | null {
    const parsed = parseFunctionTypeAnnotation(typeName);
    if (!parsed) {
      return null;
    }
    const parameters: FunctionTypeParameter[] = parsed.receiverTypeName
      ? [new FunctionTypeParameter("this", this.typeFromTypeNameLoose(parsed.receiverTypeName), true)]
      : [];
    parameters.push(...parsed.parameters.map((parameter) => new FunctionTypeParameter(
      parameter.name,
      this.typeFromTypeNameLoose(parameter.typeName),
      undefined,
      parameter.optional || undefined,
      parameter.rest || undefined
    )));
    return functionType(
      parameters,
      this.typeFromTypeNameLoose(parsed.returnTypeName)
    );
  }
}
