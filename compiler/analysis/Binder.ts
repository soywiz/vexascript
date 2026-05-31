import type {
  BlockStatement,
  CatchClause,
  ClassMethodMember,
  ClassStatement,
  DoWhileStatement,
  ForStatement,
  FunctionStatement,
  ImportStatement,
  IfStatement,
  Program,
  Statement,
  SwitchStatement,
  TryStatement,
  VarStatement,
  WhileStatement
} from "compiler/ast/ast";
import type { Node } from "compiler/ast/ast";
import { builtinType, functionType, namedType, typeToString, UNKNOWN_TYPE } from "./types";
import type { AnalysisSymbol, BoundAnalysis, Scope } from "./model";

const BUILTIN_TYPE_NAMES = new Set([
  "int",
  "number",
  "string",
  "boolean",
  "bigint",
  "long"
]);

const BUILTIN_IDENTIFIERS = new Map<string, ReturnType<typeof builtinType> | typeof UNKNOWN_TYPE>([
  ["true", builtinType("boolean")],
  ["false", builtinType("boolean")],
  ["null", builtinType("null")],
  ["undefined", builtinType("undefined")],
  ["console", UNKNOWN_TYPE]
]);

function symbolOffset(node: Node): number {
  return node.firstToken?.range.start.offset ?? -1;
}

export class Binder {
  private readonly scopeByNode: WeakMap<Node, Scope> = new WeakMap();
  private readonly rootScope: Scope;

  constructor(private readonly program: Program) {
    this.rootScope = this.createScope(undefined, program);
  }

  bind(): BoundAnalysis {
    this.bindBuiltins();
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

  private bindGlobalDeclarations(statements: Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (statement.kind === "ImportStatement") {
        const importStatement = statement as ImportStatement;
        for (const specifier of importStatement.specifiers) {
          this.declare(scope, {
            name: specifier.imported.name,
            kind: "variable",
            node: specifier.imported,
            type: UNKNOWN_TYPE,
            valueType: typeToString(UNKNOWN_TYPE)
          });
        }
        continue;
      }

      if (statement.kind === "VarStatement") {
        const variableStatement = statement as VarStatement;
        if (variableStatement.declarations && variableStatement.declarations.length > 0) {
          for (const declaration of variableStatement.declarations) {
            const symbolType = this.typeFromAnnotationLoose(declaration.typeAnnotation) ?? UNKNOWN_TYPE;
            this.declare(scope, {
              name: declaration.name.name,
              kind: "variable",
              node: declaration.name,
              type: symbolType,
              valueType: typeToString(symbolType)
            });
          }
        } else {
          const symbolType = this.typeFromAnnotationLoose(variableStatement.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declare(scope, {
            name: variableStatement.name.name,
            kind: "variable",
            node: variableStatement.name,
            type: symbolType,
            valueType: typeToString(symbolType)
          });
        }
        continue;
      }

      if (statement.kind === "FunctionStatement") {
        const functionStatement = statement as FunctionStatement;
        const symbolType = functionType(
          functionStatement.parameters.map((parameter) => ({
            name: parameter.name.name,
            type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined
          })),
          this.typeFromAnnotationLoose(functionStatement.returnType) ?? UNKNOWN_TYPE
        );
        this.declare(scope, {
          name: functionStatement.name.name,
          kind: "function",
          node: functionStatement.name,
          type: symbolType,
          valueType: typeToString(symbolType)
        });
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
        });
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
    if (statement.declarations && statement.declarations.length > 0) {
      for (const declaration of statement.declarations) {
        const symbolType = this.typeFromAnnotationLoose(declaration.typeAnnotation) ?? UNKNOWN_TYPE;
        this.declare(scope, {
          name: declaration.name.name,
          kind: "variable",
          node: declaration.name,
          type: symbolType,
          valueType: typeToString(symbolType)
        });
      }
      return;
    }

    const symbolType = this.typeFromAnnotationLoose(statement.typeAnnotation) ?? UNKNOWN_TYPE;
    this.declare(scope, {
      name: statement.name.name,
      kind: "variable",
      node: statement.name,
      type: symbolType,
      valueType: typeToString(symbolType)
    });
  }

  private bindFunctionStatement(statement: FunctionStatement, scope: Scope, declareInParent: boolean): void {
    if (declareInParent) {
      const symbolType = functionType(
        statement.parameters.map((parameter) => ({
          name: parameter.name.name,
          type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
          optional: parameter.optional === true || parameter.defaultValue !== undefined
        })),
        this.typeFromAnnotationLoose(statement.returnType) ?? UNKNOWN_TYPE
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
    for (const parameter of statement.parameters) {
      const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
      this.declare(functionScope, {
        name: parameter.name.name,
        kind: "parameter",
        node: parameter.name,
        type: parameterType,
        valueType: typeToString(parameterType)
      });
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
    for (const member of statement.members) {
      if (member.kind === "ClassMethodMember") {
        const method = member as ClassMethodMember;
        const methodType = functionType(
          method.parameters.map((parameter) => ({
            name: parameter.name.name,
            type: this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE,
            optional: parameter.optional === true || parameter.defaultValue !== undefined
          })),
          this.typeFromAnnotationLoose(method.returnType) ?? UNKNOWN_TYPE
        );
        this.declare(classScope, {
          name: method.name.name,
          kind: "method",
          node: method.name,
          type: methodType,
          valueType: typeToString(methodType)
        });
        const methodScope = this.createScope(classScope, method);
        for (const parameter of method.parameters) {
          const parameterType = this.typeFromAnnotationLoose(parameter.typeAnnotation) ?? UNKNOWN_TYPE;
          this.declare(methodScope, {
            name: parameter.name.name,
            kind: "parameter",
            node: parameter.name,
            type: parameterType,
            valueType: typeToString(parameterType)
          });
        }
        this.bindStatements(method.body.body, methodScope);
      }
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

  private typeFromAnnotationLoose(typeAnnotation: { name: string } | undefined) {
    if (!typeAnnotation) {
      return undefined;
    }
    if (BUILTIN_TYPE_NAMES.has(typeAnnotation.name)) {
      return builtinType(
        typeAnnotation.name as "int" | "number" | "string" | "boolean" | "bigint" | "long"
      );
    }
    return namedType(typeAnnotation.name);
  }
}
