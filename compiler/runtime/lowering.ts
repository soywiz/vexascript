import {
  AsExpression,
  ArrayLiteral,
  ArrowFunctionExpression,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  BooleanLiteral,
  BreakStatement,
  CatchClause,
  ClassInitBlock,
  ClassMethodMember,
  ClassExpression,
  ClassStatement,
  CallExpression,
  CommaExpression,
  ConditionalExpression,
  ContinueStatement,
  DeferStatement,
  DoWhileStatement,
  ExportStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionParameter,
  FunctionExpression,
  FunctionStatement,
  Identifier,
  IfStatement,
  LabeledStatement,
  MemberExpression,
  NamedArgument,
  NewExpression,
  Node,
  NodeKind,
  NonNullExpression,
  NullLiteral,
  ObjectLiteral,
  ObjectProperty,
  ObjectSpreadProperty,
  Program,
  RangeExpression,
  ReturnStatement,
  SatisfiesExpression,
  SpreadExpression,
  Statement,
  SwitchCase,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UndefinedLiteral,
  UpdateExpression,
  VarDeclarator,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";

import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { childNodes, walkAst } from "compiler/ast/traversal";

export interface LoweringOptions {
  lowerRangeForLoops?: boolean;
  expressionTypeName?: (expression: Expr) => string | undefined;
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

type ExpressionContinuation = (value: Expr) => Statement[];

interface ControlExpressionLoweringState {
  nextTemporary: number;
  usedNames: Set<string>;
  expressionTypeName?: (expression: Expr) => string | undefined;
}

function containsControlExpression(expression: Expr): boolean {
  switch (expression.kind) {
    case NodeKind.IfStatement:
    case NodeKind.ReturnStatement:
    case NodeKind.ThrowStatement:
    case NodeKind.ContinueStatement:
    case NodeKind.BreakStatement:
      return true;
    case NodeKind.BinaryExpression:
    case NodeKind.AssignmentExpression: {
      const binary = expression as BinaryExpression | AssignmentExpression;
      return containsControlExpression(binary.left) || containsControlExpression(binary.right);
    }
    case NodeKind.RangeExpression: {
      const range = expression as RangeExpression;
      return containsControlExpression(range.start) || containsControlExpression(range.end);
    }
    case NodeKind.ConditionalExpression: {
      const conditional = expression as ConditionalExpression;
      return containsControlExpression(conditional.test) ||
        containsControlExpression(conditional.consequent) ||
        containsControlExpression(conditional.alternate);
    }
    case NodeKind.CommaExpression:
      return (expression as CommaExpression).expressions.some(containsControlExpression);
    case NodeKind.AsExpression:
    case NodeKind.SatisfiesExpression:
    case NodeKind.NonNullExpression:
      return containsControlExpression((expression as AsExpression | SatisfiesExpression | NonNullExpression).expression);
    case NodeKind.UnaryExpression:
    case NodeKind.UpdateExpression:
      return containsControlExpression((expression as UnaryExpression | UpdateExpression).argument);
    case NodeKind.MemberExpression: {
      const member = expression as MemberExpression;
      return containsControlExpression(member.object) || containsControlExpression(member.property);
    }
    case NodeKind.CallExpression: {
      const call = expression as CallExpression;
      return containsControlExpression(call.callee) || call.args.some(containsControlExpression);
    }
    case NodeKind.NewExpression: {
      const construct = expression as NewExpression;
      return containsControlExpression(construct.callee) || (construct.args?.some(containsControlExpression) ?? false);
    }
    case NodeKind.SpreadExpression:
      return containsControlExpression((expression as SpreadExpression).argument);
    case NodeKind.NamedArgument:
      return containsControlExpression((expression as NamedArgument).value);
    case NodeKind.ArrayLiteral:
      return (expression as ArrayLiteral).elements.some(containsControlExpression);
    case NodeKind.ObjectLiteral:
      return (expression as ObjectLiteral).properties.some((property) => property instanceof ObjectProperty
        ? containsControlExpression(property.key) || containsControlExpression(property.value)
        : containsControlExpression((property as ObjectSpreadProperty).argument));
    default:
      return false;
  }
}

function temporaryIdentifier(state: ControlExpressionLoweringState): Identifier {
  let name: string;
  do {
    name = `__vexa_control_${state.nextTemporary}`;
    state.nextTemporary += 1;
  } while (state.usedNames.has(name));
  state.usedNames.add(name);
  const identifier = new Identifier(name);
  return identifier;
}

function materializeExpression(
  value: Expr,
  state: ControlExpressionLoweringState,
  continuation: ExpressionContinuation
): Statement[] {
  const temporary = temporaryIdentifier(state);
  return [
    new VarStatement("val", temporary, undefined, undefined, undefined, undefined, undefined, undefined, value),
    ...continuation(new Identifier(temporary.name))
  ];
}

function statementsAsBody(statements: Statement[], source: Node): Statement {
  if (statements.length === 1) return statements[0]!;
  return copyNodeBounds(new BlockStatement(statements), source);
}

function assignmentTo(name: Identifier, value: Expr): ExprStatement {
  return new ExprStatement(new AssignmentExpression("=", new Identifier(name.name), value));
}

function lowerValueBranch(
  branch: Statement,
  state: ControlExpressionLoweringState,
  continuation: ExpressionContinuation
): Statement[] {
  if (branch instanceof ExprStatement) {
    return lowerControlExpression(branch.expression, state, continuation);
  }
  if (branch instanceof BlockStatement) {
    if (branch.body.length === 0) return continuation(new UndefinedLiteral());
    const prefix = branch.body.slice(0, -1).flatMap((statement) => lowerControlStatement(statement, state));
    const last = branch.body[branch.body.length - 1]!;
    const valueStatements = lowerValueBranch(last, state, continuation);
    return [copyNodeBounds(new BlockStatement([...prefix, ...valueStatements], branch.annotations, branch.jsName), branch)];
  }
  if (
    branch instanceof IfStatement ||
    branch instanceof ReturnStatement ||
    branch instanceof ThrowStatement ||
    branch instanceof ContinueStatement ||
    branch instanceof BreakStatement
  ) {
    return lowerControlExpression(branch, state, continuation);
  }
  return [...lowerControlStatement(branch, state), ...continuation(new UndefinedLiteral())];
}

function lowerIfExpression(
  expression: IfStatement,
  state: ControlExpressionLoweringState,
  continuation: ExpressionContinuation
): Statement[] {
  return lowerControlExpression(expression.condition, state, (condition) => {
    const thenBranch = statementsAsBody(
      lowerValueBranch(expression.thenBranch, state, continuation),
      expression.thenBranch
    );
    const elseBranch = expression.elseBranch
      ? statementsAsBody(lowerValueBranch(expression.elseBranch, state, continuation), expression.elseBranch)
      : statementsAsBody(continuation(new UndefinedLiteral()), expression);
    return [copyNodeBounds(new IfStatement(condition, thenBranch, elseBranch), expression)];
  });
}

function lowerLogicalExpression(
  expression: BinaryExpression,
  state: ControlExpressionLoweringState,
  continuation: ExpressionContinuation
): Statement[] {
  return lowerControlExpression(expression.left, state, (left) =>
    materializeExpression(left, state, (savedLeft) => {
      const useRight = lowerControlExpression(expression.right, state, continuation);
      const useLeft = continuation(savedLeft);
      let condition: Expr = savedLeft;
      if (expression.operator === "||") condition = new UnaryExpression("!", savedLeft);
      if (expression.operator === "??") {
        condition = new BinaryExpression("==", savedLeft, new NullLiteral());
      }
      const thenBranch = statementsAsBody(useRight, expression.right);
      const elseBranch = statementsAsBody(useLeft, expression.left);
      return [new IfStatement(condition, thenBranch, elseBranch)];
    })
  );
}

function lowerExpressionSequence(
  expressions: readonly Expr[],
  state: ControlExpressionLoweringState,
  build: (values: Expr[]) => Expr,
  continuation: ExpressionContinuation,
  index = 0,
  values: Expr[] = []
): Statement[] {
  if (index >= expressions.length) return continuation(build(values));
  const expression = expressions[index]!;
  return lowerControlExpression(expression, state, (value) => {
    const next = (saved: Expr) => lowerExpressionSequence(
      expressions,
      state,
      build,
      continuation,
      index + 1,
      [...values, saved]
    );
    const laterContainsControl = expressions.slice(index + 1).some(containsControlExpression);
    return laterContainsControl ? materializeExpression(value, state, next) : next(value);
  });
}

function lowerAssignmentTarget(
  target: Expr,
  state: ControlExpressionLoweringState,
  continuation: ExpressionContinuation
): Statement[] {
  if (!(target instanceof MemberExpression)) {
    return lowerControlExpression(target, state, continuation);
  }
  return lowerControlExpression(target.object, state, (object) =>
    materializeExpression(object, state, (savedObject) => {
      const build = (property: Expr) => continuation(copyNodeBounds(new MemberExpression(
        savedObject,
        property,
        target.computed,
        target.optional,
        target.nonNullAsserted
      ), target));
      if (!target.computed) return build(target.property);
      return lowerControlExpression(target.property, state, (property) =>
        materializeExpression(property, state, build)
      );
    })
  );
}

function lowerControlExpression(
  expression: Expr,
  state: ControlExpressionLoweringState,
  continuation: ExpressionContinuation
): Statement[] {
  switch (expression.kind) {
    case NodeKind.ReturnStatement: {
      const returned = expression as ReturnStatement;
      return returned.expression
        ? lowerControlExpression(returned.expression, state, (value) => [copyNodeBounds(new ReturnStatement(value), returned)])
        : [copyNodeBounds(new ReturnStatement(), returned)];
    }
    case NodeKind.ThrowStatement: {
      const thrown = expression as ThrowStatement;
      return lowerControlExpression(thrown.expression, state, (value) => [copyNodeBounds(new ThrowStatement(value), thrown)]);
    }
    case NodeKind.ContinueStatement:
      return [expression as ContinueStatement];
    case NodeKind.BreakStatement:
      return [expression as BreakStatement];
    case NodeKind.IfStatement:
      return lowerIfExpression(expression as IfStatement, state, continuation);
  }

  if (!containsControlExpression(expression)) return continuation(expression);

  switch (expression.kind) {
    case NodeKind.BinaryExpression: {
      const binary = expression as BinaryExpression;
      if (binary.operator === "&&" || binary.operator === "||" || binary.operator === "??") {
        return lowerLogicalExpression(binary, state, continuation);
      }
      return lowerExpressionSequence(
        [binary.left, binary.right],
        state,
        ([left, right]) => copyNodeBounds(new BinaryExpression(binary.operator, left!, right!, binary.operatorToken), binary),
        continuation
      );
    }
    case NodeKind.RangeExpression: {
      const range = expression as RangeExpression;
      return lowerExpressionSequence(
        [range.start, range.end],
        state,
        ([start, end]) => copyNodeBounds(new RangeExpression(start!, end!, range.exclusive), range),
        continuation
      );
    }
    case NodeKind.AssignmentExpression: {
      const assignment = expression as AssignmentExpression;
      return lowerAssignmentTarget(assignment.left, state, (target) => {
        if (assignment.operator === "&&=" || assignment.operator === "||=" || assignment.operator === "??=") {
          return materializeExpression(target, state, (currentValue) => {
            let condition: Expr = currentValue;
            if (assignment.operator === "||=") condition = new UnaryExpression("!", currentValue);
            if (assignment.operator === "??=") condition = new BinaryExpression("==", currentValue, new NullLiteral());
            const assignRight = lowerControlExpression(assignment.right, state, (right) => continuation(
              copyNodeBounds(new AssignmentExpression("=", target, right), assignment)
            ));
            return [new IfStatement(
              condition,
              statementsAsBody(assignRight, assignment.right),
              statementsAsBody(continuation(currentValue), assignment.left)
            )];
          });
        }
        return lowerControlExpression(assignment.right, state, (right) => continuation(
          copyNodeBounds(new AssignmentExpression(assignment.operator, target, right), assignment)
        ));
      });
    }
    case NodeKind.ConditionalExpression: {
      const conditional = expression as ConditionalExpression;
      return lowerControlExpression(conditional.test, state, (test) => [
        copyNodeBounds(new IfStatement(
          test,
          statementsAsBody(lowerControlExpression(conditional.consequent, state, continuation), conditional.consequent),
          statementsAsBody(lowerControlExpression(conditional.alternate, state, continuation), conditional.alternate)
        ), conditional)
      ]);
    }
    case NodeKind.CommaExpression: {
      const comma = expression as CommaExpression;
      if (comma.expressions.length === 0) return continuation(new UndefinedLiteral());
      const prefix = comma.expressions.slice(0, -1);
      const last = comma.expressions[comma.expressions.length - 1]!;
      return lowerExpressionSequence(
        prefix,
        state,
        (values) => new CommaExpression(values),
        (value) => [new ExprStatement(value), ...lowerControlExpression(last, state, continuation)]
      );
    }
    case NodeKind.AsExpression: {
      const asserted = expression as AsExpression;
      return lowerControlExpression(asserted.expression, state, (value) => continuation(
        copyNodeBounds(new AsExpression(value, asserted.typeAnnotation), asserted)
      ));
    }
    case NodeKind.SatisfiesExpression: {
      const satisfies = expression as SatisfiesExpression;
      return lowerControlExpression(satisfies.expression, state, (value) => continuation(
        copyNodeBounds(new SatisfiesExpression(value, satisfies.typeAnnotation), satisfies)
      ));
    }
    case NodeKind.NonNullExpression: {
      const nonNull = expression as NonNullExpression;
      return lowerControlExpression(nonNull.expression, state, (value) => continuation(
        copyNodeBounds(new NonNullExpression(value), nonNull)
      ));
    }
    case NodeKind.UnaryExpression: {
      const unary = expression as UnaryExpression;
      return lowerControlExpression(unary.argument, state, (value) => continuation(
        copyNodeBounds(new UnaryExpression(unary.operator, value), unary)
      ));
    }
    case NodeKind.UpdateExpression: {
      const update = expression as UpdateExpression;
      return lowerAssignmentTarget(update.argument, state, (target) => continuation(
        copyNodeBounds(new UpdateExpression(update.operator, target, update.prefix), update)
      ));
    }
    case NodeKind.MemberExpression: {
      const member = expression as MemberExpression;
      return lowerExpressionSequence(
        [member.object, member.property],
        state,
        ([object, property]) => copyNodeBounds(
          new MemberExpression(object!, property!, member.computed, member.optional, member.nonNullAsserted),
          member
        ),
        continuation
      );
    }
    case NodeKind.CallExpression: {
      const call = expression as CallExpression;
      if (call.callee instanceof MemberExpression && call.args.some(containsControlExpression)) {
        const member = call.callee;
        return lowerControlExpression(member.object, state, (object) =>
          materializeExpression(object, state, (savedObject) => {
            const lowerArgs = (property: Expr): Statement[] => lowerExpressionSequence(
              call.args,
              state,
              (args) => copyNodeBounds(new CallExpression(
                copyNodeBounds(new MemberExpression(
                  savedObject,
                  property,
                  member.computed,
                  member.optional,
                  member.nonNullAsserted
                ), member),
                args,
                call.typeArguments,
                call.optional
              ), call),
              continuation
            );
            if (!member.computed) return lowerArgs(member.property);
            return lowerControlExpression(member.property, state, (property) =>
              materializeExpression(property, state, lowerArgs)
            );
          })
        );
      }
      return lowerExpressionSequence(
        [call.callee, ...call.args],
        state,
        ([callee, ...args]) => copyNodeBounds(new CallExpression(callee!, args, call.typeArguments, call.optional), call),
        continuation
      );
    }
    case NodeKind.NewExpression: {
      const construct = expression as NewExpression;
      return lowerExpressionSequence(
        [construct.callee, ...(construct.args ?? [])],
        state,
        ([callee, ...args]) => copyNodeBounds(new NewExpression(callee!, construct.args ? args : undefined, construct.typeArguments), construct),
        continuation
      );
    }
    case NodeKind.SpreadExpression: {
      const spread = expression as SpreadExpression;
      return lowerControlExpression(spread.argument, state, (value) => continuation(
        copyNodeBounds(new SpreadExpression(value), spread)
      ));
    }
    case NodeKind.NamedArgument: {
      const named = expression as NamedArgument;
      return lowerControlExpression(named.value, state, (value) => continuation(
        copyNodeBounds(new NamedArgument(named.name, value), named)
      ));
    }
    case NodeKind.ArrayLiteral: {
      const array = expression as ArrayLiteral;
      return lowerExpressionSequence(
        array.elements,
        state,
        (elements) => copyNodeBounds(new ArrayLiteral(elements, array.__vexaEmptyRest), array),
        continuation
      );
    }
    case NodeKind.ObjectLiteral: {
      const object = expression as ObjectLiteral;
      const flatExpressions: Expr[] = [];
      for (const property of object.properties) {
        if (property instanceof ObjectProperty) flatExpressions.push(property.key, property.value);
        else flatExpressions.push(property.argument);
      }
      return lowerExpressionSequence(flatExpressions, state, (values) => {
        let valueIndex = 0;
        const properties = object.properties.map((property) => {
          if (property instanceof ObjectProperty) {
            const key = values[valueIndex++]!;
            const value = values[valueIndex++]!;
            return copyNodeBounds(new ObjectProperty(key, value, property.computed, property.shorthand, property.method), property);
          }
          return copyNodeBounds(new ObjectSpreadProperty(values[valueIndex++]!), property);
        });
        return copyNodeBounds(new ObjectLiteral(properties, object.trailingComma), object);
      }, continuation);
    }
    default:
      return continuation(expression);
  }
}

function lowerControlVarStatement(
  statement: VarStatement,
  state: ControlExpressionLoweringState
): Statement[] {
  if (!statement.initializer || !containsControlExpression(statement.initializer)) {
    return [statement];
  }
  const name = statement.name;
  if (!(name instanceof Identifier)) return [statement];
  const declaration = copyNodeBounds(new VarStatement(
    "let",
    name,
    statement.declared,
    statement.delegate,
    statement.receiverType,
    statement.receiverTypeArguments,
    statement.typeParameters,
    statement.typeAnnotation ?? (() => {
      const inferredTypeName = state.expressionTypeName?.(statement.initializer!);
      return inferredTypeName ? new Identifier(inferredTypeName) : undefined;
    })(),
    undefined,
    statement.accessors,
    statement.declarations,
    statement.annotations,
    statement.jsName
  ), statement);
  return [declaration, ...lowerControlExpression(statement.initializer, state, (value) => [assignmentTo(name, value)])];
}

function lowerControlStatement(
  statement: Statement,
  state: ControlExpressionLoweringState
): Statement[] {
  switch (statement.kind) {
    case NodeKind.ExportStatement: {
      const exported = statement as ExportStatement;
      if (!exported.declaration) return [statement];
      const lowered = lowerControlStatement(exported.declaration, state);
      if (lowered.length === 1) {
        return [copyNodeBounds(new ExportStatement(
          lowered[0], exported.namespaceExport, exported.specifiers, exported.from,
          exported.exportAll, exported.isDefault, exported.typeOnly, exported.annotations, exported.jsName
        ), exported)];
      }
      return [
        copyNodeBounds(new ExportStatement(
          lowered[0], exported.namespaceExport, exported.specifiers, exported.from,
          exported.exportAll, exported.isDefault, exported.typeOnly, exported.annotations, exported.jsName
        ), exported),
        ...lowered.slice(1)
      ];
    }
    case NodeKind.VarStatement:
      return lowerControlVarStatement(statement as VarStatement, state);
    case NodeKind.ExprStatement: {
      const expression = (statement as ExprStatement).expression;
      return containsControlExpression(expression)
        ? lowerControlExpression(expression, state, (value) => [new ExprStatement(value)])
        : [statement];
    }
    case NodeKind.ReturnStatement: {
      const returned = statement as ReturnStatement;
      return returned.expression && containsControlExpression(returned.expression)
        ? lowerControlExpression(returned.expression, state, (value) => [copyNodeBounds(new ReturnStatement(value), returned)])
        : [statement];
    }
    case NodeKind.ThrowStatement: {
      const thrown = statement as ThrowStatement;
      return containsControlExpression(thrown.expression)
        ? lowerControlExpression(thrown.expression, state, (value) => [copyNodeBounds(new ThrowStatement(value), thrown)])
        : [statement];
    }
    case NodeKind.BlockStatement: {
      const block = statement as BlockStatement;
      return [copyNodeBounds(new BlockStatement(
        block.body.flatMap((child) => lowerControlStatement(child, state)),
        block.annotations,
        block.jsName
      ), block)];
    }
    case NodeKind.IfStatement: {
      const conditional = statement as IfStatement;
      return lowerControlExpression(conditional.condition, state, (condition) => [copyNodeBounds(new IfStatement(
        condition,
        statementsAsBody(lowerControlStatement(conditional.thenBranch, state), conditional.thenBranch),
        conditional.elseBranch
          ? statementsAsBody(lowerControlStatement(conditional.elseBranch, state), conditional.elseBranch)
          : undefined,
        conditional.annotations,
        conditional.jsName
      ), conditional)]);
    }
    case NodeKind.WhileStatement: {
      const loop = statement as WhileStatement;
      const body = statementsAsBody(lowerControlStatement(loop.body, state), loop.body);
      if (!containsControlExpression(loop.condition)) {
        return [copyNodeBounds(new WhileStatement(loop.condition, body, loop.annotations, loop.jsName), loop)];
      }
      const iteration = lowerControlExpression(loop.condition, state, (condition) => [
        new IfStatement(new UnaryExpression("!", condition), new BreakStatement()),
        body
      ]);
      return [copyNodeBounds(new WhileStatement(
        new BooleanLiteral(true),
        new BlockStatement(iteration),
        loop.annotations,
        loop.jsName
      ), loop)];
    }
    case NodeKind.DoWhileStatement: {
      const loop = statement as DoWhileStatement;
      return [copyNodeBounds(new DoWhileStatement(
        statementsAsBody(lowerControlStatement(loop.body, state), loop.body),
        loop.condition,
        loop.annotations,
        loop.jsName
      ), loop)];
    }
    case NodeKind.ForStatement: {
      const loop = statement as ForStatement;
      return [copyNodeBounds(new ForStatement(
        statementsAsBody(lowerControlStatement(loop.body, state), loop.body),
        loop.isAwait,
        loop.iterationKind,
        loop.iterator,
        loop.iterable,
        loop.initializer,
        loop.condition,
        loop.update,
        loop.annotations,
        loop.jsName
      ), loop)];
    }
    case NodeKind.SwitchStatement: {
      const switched = statement as SwitchStatement;
      const cases = switched.cases.map((switchCase) => copyNodeBounds(new SwitchCase(
        switchCase.consequent.flatMap((child) => lowerControlStatement(child, state)),
        switchCase.test
      ), switchCase));
      return [copyNodeBounds(new SwitchStatement(
        switched.discriminant,
        cases,
        switched.annotations,
        switched.jsName
      ), switched)];
    }
    case NodeKind.TryStatement: {
      const tried = statement as TryStatement;
      const tryBlock = lowerControlStatement(tried.tryBlock, state)[0] as BlockStatement;
      const catchClause = tried.catchClause
        ? copyNodeBounds(new CatchClause(
            lowerControlStatement(tried.catchClause.body, state)[0] as BlockStatement,
            tried.catchClause.parameter
          ), tried.catchClause)
        : undefined;
      const finallyBlock = tried.finallyBlock
        ? lowerControlStatement(tried.finallyBlock, state)[0] as BlockStatement
        : undefined;
      return [copyNodeBounds(new TryStatement(
        tryBlock,
        catchClause,
        finallyBlock,
        tried.annotations,
        tried.jsName
      ), tried)];
    }
    case NodeKind.LabeledStatement: {
      const labeled = statement as LabeledStatement;
      return [copyNodeBounds(new LabeledStatement(
        labeled.label,
        statementsAsBody(lowerControlStatement(labeled.body, state), labeled.body),
        labeled.annotations,
        labeled.jsName
      ), labeled)];
    }
    case NodeKind.WithStatement: {
      const withStatement = statement as WithStatement;
      return [copyNodeBounds(new WithStatement(
        withStatement.object,
        statementsAsBody(lowerControlStatement(withStatement.body, state), withStatement.body),
        withStatement.annotations,
        withStatement.jsName
      ), withStatement)];
    }
    case NodeKind.FunctionStatement: {
      const fn = statement as FunctionStatement;
      const body = lowerControlStatement(fn.body, state)[0] as BlockStatement;
      return [copyNodeBounds(new FunctionStatement(
        fn.declarationKind, fn.name, fn.parameters, body, fn.declared, fn.async, fn.sync, fn.generator,
        fn.missingBody, fn.jsInline, fn.receiverType, fn.receiverTypeArguments, fn.operator,
        fn.typeParameters, fn.parametersCloseParen, fn.returnType, fn.annotations, fn.jsName
      ), fn)];
    }
    case NodeKind.ClassStatement: {
      const klass = statement as ClassStatement;
      const members = klass.members.map((member) => member instanceof ClassMethodMember
        ? cloneClassMethod(member, lowerControlStatement(member.body, state)[0] as BlockStatement)
        : member);
      const initBlocks = klass.initBlocks?.map((initBlock) => copyNodeBounds(
        new ClassInitBlock(lowerControlStatement(initBlock.body, state)[0] as BlockStatement),
        initBlock
      ));
      return [copyNodeBounds(new ClassStatement(
        klass.name, members, klass.declared, klass.abstract, klass.typeParameters, klass.extendsType,
        klass.implementsTypes, klass.extraExtendsTypes, klass.extraImplementsTypes, klass.classDelegates,
        klass.primaryConstructorParameters, klass.annotations, klass.jsName, initBlocks
      ), klass)];
    }
    default:
      return [statement];
  }
}

function lowerNestedFunctionBodies(root: Node, state: ControlExpressionLoweringState): void {
  const pending = childNodes(root);
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node instanceof ArrowFunctionExpression) {
      if (node.body instanceof BlockStatement) {
        node.body = lowerControlStatement(node.body, state)[0] as BlockStatement;
      } else if (containsControlExpression(node.body)) {
        node.body = copyNodeBounds(new BlockStatement(
          lowerControlExpression(node.body, state, (value) => [new ReturnStatement(value)])
        ), node.body);
      }
    } else if (node instanceof FunctionExpression) {
      node.body = lowerControlStatement(node.body, state)[0] as BlockStatement;
    } else if (node instanceof ClassExpression) {
      for (const member of node.members) {
        if (member instanceof ClassMethodMember) {
          member.body = lowerControlStatement(member.body, state)[0] as BlockStatement;
        }
      }
    }
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
}

function lowerControlExpressions(program: Program, options: LoweringOptions): Program {
  const usedNames = new Set<string>();
  walkAst(program, (node) => {
    if (node instanceof Identifier) usedNames.add(node.name);
  });
  const state: ControlExpressionLoweringState = {
    nextTemporary: 0,
    usedNames,
    ...(options.expressionTypeName ? { expressionTypeName: options.expressionTypeName } : {})
  };
  lowerNestedFunctionBodies(program, state);
  return copyNodeBounds(new Program(
    program.body.flatMap((statement) => lowerControlStatement(statement, state)),
    program.__vexaRecoveryMarkers
  ), program);
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

  if (options.lowerRangeForLoops !== false && statement.iterationKind === "of" && statement.iterable instanceof RangeExpression) {
    const iteratorName =
      statement.iterator instanceof Identifier
        ? (statement.iterator as Identifier).name
        : statement.iterator instanceof VarStatement
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
    if (child instanceof DeferStatement) {
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
        s.jsName,
        s.initBlocks?.map((initBlock) => copyNodeBounds(
          new ClassInitBlock(lowerBlockStatement(initBlock.body, options)),
          initBlock
        ))
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
  const structurallyLowered = copyNodeBounds(new Program(
    program.body.map((statement) => lowerStatement(statement, options)),
    program.__vexaRecoveryMarkers
  ), program);
  return lowerControlExpressions(structurallyLowered, options);
}
