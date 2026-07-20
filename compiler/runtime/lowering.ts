import { NodeKind } from "compiler/ast/ast";
import {
  BlockStatement,
  BinaryExpression,
  CatchClause,
  ClassMethodMember,
  ClassStatement,
  DeferStatement,
  DoWhileStatement,
  ExprStatement,
  Expr,
  ExportStatement,
  ForStatement,
  FunctionParameter,
  FunctionStatement,
  Identifier,
  IfStatement,
  Node,
  Program,
  RangeExpression,
  Statement,
  SwitchStatement,
  SwitchCase,
  TryStatement,
  UpdateExpression,
  VarStatement,
  VarDeclarator,
  WhileStatement
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";

export interface LoweringOptions {
  lowerRangeForLoops?: boolean;
}

function cloneExpression<T extends Expr>(expression: T): T {
  return expression;
}

function copyNodeBounds<T extends Node>(target: T, source: Node): T {
  if (source.firstToken) {
    Object.defineProperty(target, "firstToken", {
      value: source.firstToken,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (source.lastToken) {
    Object.defineProperty(target, "lastToken", {
      value: source.lastToken,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (source.__vexaNativeSourcePath) {
    (target as Node).__vexaNativeSourcePath = source.__vexaNativeSourcePath;
  }
  return target;
}

function cloneIdentifier(identifier: Identifier): Identifier {
  return copyNodeBounds(new Identifier(identifier.name, identifier.__vexaNativeOriginalName, identifier.receiverLabel), identifier);
}

function cloneFunctionParameter(parameter: FunctionParameter): FunctionParameter {
  return copyNodeBounds(new FunctionParameter(
    parameter.name,
    parameter.accessModifier,
    parameter.isReadonly,
    parameter.thisParameter,
    parameter.rest,
    parameter.optional,
    parameter.typeAnnotation,
    parameter.defaultValue
  ), parameter);
}

function cloneClassMethod(method: ClassMethodMember, body = method.body): ClassMethodMember {
  return copyNodeBounds(new ClassMethodMember(
    body,
    method.name,
    method.parameters.map(cloneFunctionParameter),
    method.declarationKind,
    method.accessorKind,
    method.accessorToken,
    method.declarationKeywordToken,
    method.readonlyToken,
    method.async,
    method.sync,
    method.generator,
    method.getterShorthand,
    method.computed,
    method.computedKey,
    method.operator,
    method.override,
    method.missingBody,
    method.parametersCloseParen,
    method.accessModifier,
    method.isReadonly,
    method.isStatic,
    method.abstract,
    method.annotations,
    method.returnType,
    method.typeParameters,
    method.optional
  ), method);
}

function cloneVarDeclarator(declaration: VarDeclarator): VarDeclarator {
  return copyNodeBounds(new VarDeclarator(
    declaration.name,
    declaration.typeAnnotation,
    declaration.initializer,
    declaration.delegate
  ), declaration);
}

function cloneVarStatement(statement: VarStatement): VarStatement {
  let accessors: ClassMethodMember[] | undefined;
  if (statement.accessors) {
    accessors = [];
    for (const accessor of statement.accessors) accessors.push(cloneClassMethod(accessor));
  }
  let declarations: VarDeclarator[] | undefined;
  if (statement.declarations) {
    declarations = [];
    for (const declaration of statement.declarations) declarations.push(cloneVarDeclarator(declaration));
  }
  return copyNodeBounds(new VarStatement(
    statement.declarationKind,
    statement.name,
    statement.declared,
    statement.delegate,
    statement.receiverType,
    statement.receiverTypeArguments,
    statement.typeParameters,
    statement.typeAnnotation,
    statement.initializer,
    accessors,
    declarations,
    statement.annotations,
    statement.jsName
  ), statement);
}

function lowerForStatement(statement: ForStatement, options: LoweringOptions): ForStatement {
  if (!(statement.iterationKind && statement.iterator && statement.iterable)) {
    const initializer = statement.initializer instanceof VarStatement
      ? cloneVarStatement(statement.initializer)
      : statement.initializer;
    return copyNodeBounds(new ForStatement(
      lowerStatement(statement.body, options),
      statement.isAwait,
      statement.iterationKind,
      statement.iterator,
      statement.iterable,
      initializer,
      statement.condition,
      statement.update,
      statement.annotations,
      statement.jsName
    ), statement);
  }

  if (options.lowerRangeForLoops !== false && statement.iterationKind === "of" && statement.iterable.kind === NodeKind.RangeExpression) {
    const iteratorName =
      statement.iterator.kind === NodeKind.Identifier
        ? (statement.iterator as Identifier).name
        : statement.iterator.kind === NodeKind.VarStatement
          ? (bindingIdentifiers((statement.iterator as VarStatement).declarations?.[0]?.name ?? (statement.iterator as VarStatement).name)[0]?.name)
          : null;

    if (iteratorName) {
      const range = statement.iterable as RangeExpression;
      const loweredInitializer: VarStatement = new VarStatement("let", new Identifier(iteratorName), undefined, undefined, undefined, undefined, undefined, undefined, cloneExpression(range.start));
      const loweredCondition: Expr = new BinaryExpression(range.exclusive ? "<" : "<=", new Identifier(iteratorName), cloneExpression(range.end));
      const loweredUpdate: UpdateExpression = new UpdateExpression("++", new Identifier(iteratorName), false);

      return copyNodeBounds(new ForStatement(
        lowerStatement(statement.body, options),
        undefined,
        undefined,
        undefined,
        undefined,
        loweredInitializer,
        loweredCondition,
        loweredUpdate,
        statement.annotations,
        statement.jsName
      ), statement);
    }
  }

  const iterator = statement.iterator instanceof VarStatement
    ? cloneVarStatement(statement.iterator)
    : statement.iterator instanceof Identifier
      ? cloneIdentifier(statement.iterator)
      : statement.iterator;
  return copyNodeBounds(new ForStatement(
    lowerStatement(statement.body, options),
    statement.isAwait,
    statement.iterationKind,
    iterator,
    statement.iterable,
    statement.initializer,
    statement.condition,
    statement.update,
    statement.annotations,
    statement.jsName
  ), statement);
}

function lowerBlockStatement(statement: BlockStatement, options: LoweringOptions): BlockStatement {
  const loweredBody: Statement[] = [];
  for (let index = statement.body.length - 1; index >= 0; index -= 1) {
    const child = statement.body[index]!;
    if (child.kind === NodeKind.DeferStatement) {
      const deferred = child as DeferStatement;
      const tryBlock = copyNodeBounds(new BlockStatement([...loweredBody]), statement);
      const finallyStatement = copyNodeBounds(new ExprStatement(cloneExpression(deferred.expression)), deferred);
      const finallyBlock = copyNodeBounds(new BlockStatement([finallyStatement]), deferred);
      const wrapped = copyNodeBounds(new TryStatement(tryBlock, undefined, finallyBlock), deferred);
      loweredBody.splice(0, loweredBody.length, wrapped);
      continue;
    }
    loweredBody.unshift(lowerStatement(child, options));
  }
  return copyNodeBounds(new BlockStatement(loweredBody, statement.annotations, statement.jsName), statement);
}

function lowerStatement(statement: Statement, options: LoweringOptions): Statement {
  switch (statement.kind) {
    case NodeKind.ExportStatement: {
      const s = statement as ExportStatement;
      return copyNodeBounds(new ExportStatement(
        s.declaration ? lowerStatement(s.declaration, options) : undefined,
        s.namespaceExport,
        s.specifiers,
        s.from,
        s.exportAll,
        s.isDefault,
        s.typeOnly,
        s.annotations,
        s.jsName
      ), statement);
    }
    case NodeKind.ForStatement:
      return lowerForStatement(statement as ForStatement, options);
    case NodeKind.BlockStatement:
      return lowerBlockStatement(statement as BlockStatement, options);
    case NodeKind.FunctionStatement: {
      const s = statement as FunctionStatement;
      return copyNodeBounds(new FunctionStatement(
        s.declarationKind,
        s.name,
        s.parameters.map(cloneFunctionParameter),
        lowerBlockStatement(s.body, options),
        s.declared,
        s.async,
        s.sync,
        s.generator,
        s.missingBody,
        s.jsInline,
        s.receiverType,
        s.receiverTypeArguments,
        s.operator,
        s.typeParameters,
        s.parametersCloseParen,
        s.returnType,
        s.annotations,
        s.jsName
      ), statement);
    }
    case NodeKind.ClassStatement: {
      const s = statement as ClassStatement;
      return copyNodeBounds(new ClassStatement(
        s.name,
        s.members.map((member) => member instanceof ClassMethodMember
          ? cloneClassMethod(member, lowerBlockStatement(member.body, options))
          : member),
        s.declared,
        s.abstract,
        s.typeParameters,
        s.extendsType,
        s.implementsTypes,
        s.extraExtendsTypes,
        s.extraImplementsTypes,
        s.classDelegates,
        s.primaryConstructorParameters,
        s.annotations,
        s.jsName
      ), statement);
    }
    case NodeKind.IfStatement: {
      const s = statement as IfStatement;
      return copyNodeBounds(new IfStatement(
        s.condition,
        lowerStatement(s.thenBranch, options),
        s.elseBranch ? lowerStatement(s.elseBranch, options) : undefined,
        s.annotations,
        s.jsName
      ), statement);
    }
    case NodeKind.WhileStatement: {
      const s = statement as WhileStatement;
      return copyNodeBounds(new WhileStatement(
        s.condition,
        lowerStatement(s.body, options),
        s.annotations,
        s.jsName
      ), statement);
    }
    case NodeKind.DoWhileStatement: {
      const s = statement as DoWhileStatement;
      return copyNodeBounds(new DoWhileStatement(
        lowerStatement(s.body, options),
        s.condition,
        s.annotations,
        s.jsName
      ), statement);
    }
    case NodeKind.SwitchStatement: {
      const s = statement as SwitchStatement;
      return copyNodeBounds(new SwitchStatement(
        s.discriminant,
        s.cases.map((switchCase) => copyNodeBounds(new SwitchCase(
          switchCase.consequent.map((child) => lowerStatement(child, options)),
          switchCase.test
        ), switchCase)),
        s.annotations,
        s.jsName
      ), statement);
    }
    case NodeKind.TryStatement: {
      const s = statement as TryStatement;
      const catchClause = s.catchClause
        ? copyNodeBounds(new CatchClause(
            lowerBlockStatement(s.catchClause.body, options),
            s.catchClause.parameter
          ), s.catchClause)
        : undefined;
      return copyNodeBounds(new TryStatement(
        lowerBlockStatement(s.tryBlock, options),
        catchClause,
        s.finallyBlock ? lowerBlockStatement(s.finallyBlock, options) : undefined,
        s.annotations,
        s.jsName
      ), statement);
    }
    case NodeKind.VarStatement:
      return cloneVarStatement(statement as VarStatement);
    default:
      return statement;
  }
}

export function lowerProgram(program: Program, options: LoweringOptions = {}): Program {
  return copyNodeBounds(new Program(
    program.body.map((statement) => lowerStatement(statement, options)),
    program.__vexaRecoveryMarkers
  ), program);
}
