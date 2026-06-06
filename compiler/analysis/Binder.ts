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
import { builtinType, functionType, namedType, typeToString, UNKNOWN_TYPE, unionType, BUILTIN_TYPE_NAMES } from "./types";
import { findMatchingTypeDelimiter, findTopLevelTypeCharacter, parseTypeNameShape, splitTopLevelDelimitedTypeText } from "./typeNames";
import type { AnalysisType, BuiltinTypeName } from "./types";
import type { AnalysisSymbol, BoundAnalysis, Scope } from "./model";
import { getEcmaScriptRuntimeProgram } from "compiler/runtime/ecmascriptDeclarations";
import { bindingIdentifiers, bindingNameText } from "compiler/ast/bindingPatterns";

const BUILTIN_IDENTIFIERS = new Map<string, ReturnType<typeof builtinType> | typeof UNKNOWN_TYPE>([
  ["true", builtinType("boolean")],
  ["false", builtinType("boolean")],
  ["null", builtinType("null")],
  ["undefined", builtinType("undefined")],
  ["console", UNKNOWN_TYPE],
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

export class Binder {
  private readonly scopeByNode: WeakMap<Node, Scope> = new WeakMap();
  private readonly rootScope: Scope;
  private readonly classStatementsByName = new Map<string, ClassStatement>();

  constructor(
    private readonly program: Program,
    private readonly externalDeclarations: Statement[] = [],
    private readonly importedSymbolTypes: ReadonlyMap<string, AnalysisType> = new Map()
  ) {
    this.rootScope = this.createScope(undefined, program);
  }

  bind(): BoundAnalysis {
    // External (imported) declarations are collected first so that same-file
    // declarations override them on name clashes.
    this.collectClassStatements(this.externalDeclarations);
    this.collectClassStatements(this.program.body);
    this.bindBuiltins();
    this.bindGlobalDeclarations(getEcmaScriptRuntimeProgram().body, this.rootScope, -1);
    this.bindGlobalDeclarations(this.program.body, this.rootScope);
    this.bindStatements(this.program.body, this.rootScope);
    return {
      rootScope: this.rootScope,
      scopeByNode: this.scopeByNode
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
    if (existing?.kind === "function" && symbol.kind === "function" && existing.type && symbol.type) {
      const existingTypes = existing.type.kind === "union" ? existing.type.types : [existing.type];
      const mergedType = unionType([...existingTypes, symbol.type]);
      existing.type = mergedType;
      existing.valueType = typeToString(mergedType);
      return;
    }
    scope.symbols.set(symbol.name, {
      ...symbol,
      declaredOffset: declaredOffsetOverride ?? symbolOffset(symbol.node)
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
    for (const statement of statements) {
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
          this.declare(scope, {
            name: importStatement.defaultImport.name,
            kind: "variable",
            node: importStatement.defaultImport,
            type: UNKNOWN_TYPE,
            valueType: typeToString(UNKNOWN_TYPE)
          }, declaredOffsetOverride);
        }
        if (importStatement.namespaceImport) {
          this.declare(scope, {
            name: importStatement.namespaceImport.name,
            kind: "variable",
            node: importStatement.namespaceImport,
            type: UNKNOWN_TYPE,
            valueType: typeToString(UNKNOWN_TYPE)
          }, declaredOffsetOverride);
        }
        for (const specifier of importStatement.specifiers) {
          const local = specifier.local ?? specifier.imported;
          // Prefer a cross-file resolved type when the importer provided one, so
          // imported values (e.g. functions returning a Promise) keep their type
          // instead of degrading to `unknown`.
          const resolvedType = this.importedSymbolTypes.get(local.name) ?? UNKNOWN_TYPE;
          this.declare(scope, {
            name: local.name,
            kind: resolvedType.kind === "function" ? "function" : "variable",
            node: local,
            type: resolvedType,
            valueType: typeToString(resolvedType)
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
        const symbolType = functionType(
          functionStatement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
            name: bindingNameText(parameter.name),
            type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
            rest: parameter.rest === true
          })),
          this.typeFromAnnotationLoose(functionStatement.returnType) ?? UNKNOWN_TYPE,
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
      }
    }
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
      this.declare(extensionScope, {
        name: "this",
        kind: "variable",
        node: statement.receiverType,
        type: namedType(statement.receiverType.name),
        valueType: statement.receiverType.name
      }, -1);
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
    if (declareInParent && !statement.receiverType) {
      const symbolType = functionType(
        statement.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        this.typeFromAnnotationLoose(statement.returnType) ?? UNKNOWN_TYPE,
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
      this.declare(functionScope, {
        name: "this",
        kind: "variable",
        node: statement.receiverType,
        type: namedType(statement.receiverType.name),
        valueType: statement.receiverType.name
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
          const propertyType = this.typeFromAnnotationLoose(method.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declare(classScope, {
            name: method.name.name,
            kind: "variable",
            node: method.name,
            type: propertyType,
            valueType: typeToString(propertyType)
          });
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
    for (const statement of statements) {
      const candidate = statement.kind === "ExportStatement" ? (statement as ExportStatement).declaration : statement;
      if (candidate?.kind === "ClassStatement") {
        const classStatement = candidate as ClassStatement;
        this.classStatementsByName.set(classStatement.name.name, classStatement);
      }
    }
  }

  private declareReceiverMembers(scope: Scope, receiverName: string): void {
    const classStatement = this.classStatementsByName.get(receiverName);
    if (classStatement) {
      this.declareClassMembers(scope, classStatement);
    }
  }

  private declareClassMembers(scope: Scope, statement: ClassStatement): void {
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
      }, -1);
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
        }, -1);
      }
    }
    for (const member of statement.members) {
      if (member.kind === "ClassFieldMember") {
        const fieldType = this.typeFromAnnotationLoose(member.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: member.name.name,
          kind: "variable",
          node: member.name,
          isReadonly: member.readonly === true,
          implicitReceiver: true,
          type: fieldType,
          valueType: typeToString(fieldType)
        }, -1);
        continue;
      }
      if (member.accessorKind === "get") {
        const propertyType = this.typeFromAnnotationLoose(member.returnType) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: member.name.name,
          kind: "variable",
          node: member.name,
          implicitReceiver: true,
          type: propertyType,
          valueType: typeToString(propertyType)
        }, -1);
        continue;
      }
      if (member.accessorKind === "set") {
        const propertyType = this.typeFromAnnotationLoose(member.parameters[0]?.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: member.name.name,
          kind: "variable",
          node: member.name,
          implicitReceiver: true,
          type: propertyType,
          valueType: typeToString(propertyType)
        }, -1);
        continue;
      }
      const methodType = functionType(
        member.parameters.filter((parameter) => parameter.thisParameter !== true).map((parameter) => ({
          name: bindingNameText(parameter.name),
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
          rest: parameter.rest === true
        })),
        this.typeFromAnnotationLoose(member.returnType) ?? UNKNOWN_TYPE,
        member.typeParameters?.map((parameter) => parameter.name.name)
      );
      this.declare(scope, {
        name: member.name.name,
        kind: "method",
        node: member.name,
        implicitReceiver: true,
        type: methodType,
        valueType: typeToString(methodType)
      }, -1);
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

    const parsed = parseTypeNameShape(typeName);
    if (BUILTIN_TYPE_NAMES.has(parsed.baseName)) {
      return builtinType(parsed.baseName as BuiltinTypeName);
    }
    return namedType(
      parsed.baseName,
      parsed.typeArguments.map((typeArgument) => this.typeFromTypeNameLoose(typeArgument))
    );
  }

  private typeFromTypeNameLoose(typeName: string): AnalysisType {
    const functionAnnotation = this.functionTypeFromAnnotationText(typeName);
    if (functionAnnotation) {
      return functionAnnotation;
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
