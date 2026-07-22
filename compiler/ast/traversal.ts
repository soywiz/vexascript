import { ExportStatement, NodeKind } from "compiler/ast/ast";
import type {
  AnnotationApplication,
  AnnotationStatement,
  ArrayBindingPattern,
  ArrayLiteral,
  ArrayTypeAnnotation,
  ArrowFunctionExpression,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  BindingElement,
  BlockStatement,
  BreakStatement,
  CallExpression,
  CatchClause,
  ChainExpression,
  ClassDelegate,
  ClassExpression,
  ClassFieldMember,
  ClassMethodMember,
  ClassPrimaryConstructorParameter,
  ClassStatement,
  CommaExpression,
  ConditionalExpression,
  ContinueStatement,
  DebuggerStatement,
  DeferStatement,
  DoWhileStatement,
  EnumMember,
  EnumStatement,
  EmptyStatement,
  ExportSpecifier,
  ExprStatement,
  ForStatement,
  FunctionExpression,
  FunctionParameter,
  FunctionStatement,
  IfStatement,
  ImportSpecifier,
  ImportStatement,
  InterfaceMethodMember,
  InterfacePropertyMember,
  InterfaceStatement,
  JsxAttribute,
  JsxElement,
  JsxExpressionContainer,
  JsxFragment,
  JsxSpreadAttribute,
  LabeledStatement,
  MemberExpression,
  NamedArgument,
  NamespaceStatement,
  NewExpression,
  Node,
  NonNullExpression,
  ObjectBindingPattern,
  ObjectLiteral,
  ObjectProperty,
  ObjectSpreadProperty,
  Program,
  PropertyReferenceExpression,
  RangeExpression,
  ReturnStatement,
  SatisfiesExpression,
  SpreadExpression,
  Statement,
  SwitchCase,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  TypeAliasStatement,
  TypeParameter,
  TypeReference,
  UnaryExpression,
  UpdateExpression,
  VarDeclarator,
  VarStatement,
  WhileStatement,
  WithStatement,
} from "./ast";

/**
 * Returns the underlying declaration carried by an `export` statement, or the
 * statement itself when it is not an export. Useful when collecting top-level
 * declarations regardless of whether they are exported. Returns `undefined`
 * for re-export forms (`export { x }`, `export * from ...`) that carry no
 * inline declaration.
 */
export function unwrapExportedDeclaration(statement: Statement): Statement | undefined {
  return statement instanceof ExportStatement
    ? (statement as ExportStatement).declaration
    : statement;
}

function appendNode(children: Node[], child: Node | undefined): void {
  if (child !== undefined) children.push(child);
}

function appendNodes(children: Node[], nodes: Node[] | undefined): void {
  if (nodes === undefined) return;
  for (const child of nodes) children.push(child);
}

/**
 * Returns the direct structural AST children of a node. The explicit kind
 * dispatch keeps the compiler's own AST traversal statically typed in native
 * builds instead of enumerating object keys and performing dynamic gets.
 */
export function childNodes(node: Node): Node[] {
  const children: Node[] = [];

  switch (node.kind) {
    case NodeKind.IntLiteral:
    case NodeKind.FloatLiteral:
    case NodeKind.BigIntLiteral:
    case NodeKind.LongLiteral:
    case NodeKind.BooleanLiteral:
    case NodeKind.NullLiteral:
    case NodeKind.UndefinedLiteral:
    case NodeKind.MissingExpression:
    case NodeKind.Identifier:
    case NodeKind.StringLiteral:
    case NodeKind.RegExpLiteral:
    case NodeKind.ArrayHole:
    case NodeKind.BindingHole:
    case NodeKind.JsxText:
      break;
    case NodeKind.EmptyStatement:
      appendNodes(children, (node as EmptyStatement).annotations);
      break;
    case NodeKind.DebuggerStatement:
      appendNodes(children, (node as DebuggerStatement).annotations);
      break;
    case NodeKind.TypeReference: {
      const current = node as TypeReference;
      appendNode(children, current.name);
      appendNodes(children, current.typeArguments);
      break;
    }
    case NodeKind.ArrayTypeAnnotation:
      appendNode(children, (node as ArrayTypeAnnotation).elementType);
      break;
    case NodeKind.TypeParameter: {
      const current = node as TypeParameter;
      appendNode(children, current.name);
      appendNode(children, current.constraint);
      appendNode(children, current.defaultType);
      break;
    }
    case NodeKind.CommaExpression:
      appendNodes(children, (node as CommaExpression).expressions);
      break;
    case NodeKind.BinaryExpression: {
      const current = node as BinaryExpression;
      appendNode(children, current.left);
      appendNode(children, current.right);
      break;
    }
    case NodeKind.RangeExpression: {
      const current = node as RangeExpression;
      appendNode(children, current.start);
      appendNode(children, current.end);
      break;
    }
    case NodeKind.ChainExpression: {
      const current = node as ChainExpression;
      appendNode(children, current.receiver);
      appendNodes(children, current.operations);
      break;
    }
    case NodeKind.AssignmentExpression: {
      const current = node as AssignmentExpression;
      appendNode(children, current.left);
      appendNode(children, current.right);
      break;
    }
    case NodeKind.ConditionalExpression: {
      const current = node as ConditionalExpression;
      appendNode(children, current.test);
      appendNode(children, current.consequent);
      appendNode(children, current.alternate);
      break;
    }
    case NodeKind.AsExpression: {
      const current = node as AsExpression;
      appendNode(children, current.expression);
      appendNode(children, current.typeAnnotation);
      break;
    }
    case NodeKind.SatisfiesExpression: {
      const current = node as SatisfiesExpression;
      appendNode(children, current.expression);
      appendNode(children, current.typeAnnotation);
      break;
    }
    case NodeKind.NonNullExpression:
      appendNode(children, (node as NonNullExpression).expression);
      break;
    case NodeKind.MemberExpression: {
      const current = node as MemberExpression;
      appendNode(children, current.object);
      appendNode(children, current.property);
      break;
    }
    case NodeKind.PropertyReferenceExpression: {
      const current = node as PropertyReferenceExpression;
      appendNode(children, current.object);
      appendNode(children, current.property);
      break;
    }
    case NodeKind.CallExpression: {
      const current = node as CallExpression;
      appendNode(children, current.callee);
      appendNodes(children, current.args);
      appendNodes(children, current.typeArguments);
      break;
    }
    case NodeKind.ArrowFunctionExpression: {
      const current = node as ArrowFunctionExpression;
      appendNodes(children, current.parameters);
      appendNode(children, current.returnType);
      appendNode(children, current.body);
      appendNode(children, current.contextualObjectLiteral);
      break;
    }
    case NodeKind.FunctionExpression: {
      const current = node as FunctionExpression;
      appendNodes(children, current.parameters);
      appendNode(children, current.returnType);
      appendNode(children, current.body);
      appendNode(children, current.name);
      appendNodes(children, current.typeParameters);
      break;
    }
    case NodeKind.ClassExpression: {
      const current = node as ClassExpression;
      appendNodes(children, current.members);
      appendNode(children, current.name);
      appendNodes(children, current.typeParameters);
      appendNode(children, current.extendsType);
      appendNodes(children, current.implementsTypes);
      appendNodes(children, current.extraExtendsTypes);
      appendNodes(children, current.extraImplementsTypes);
      appendNodes(children, current.classDelegates);
      appendNodes(children, current.primaryConstructorParameters);
      break;
    }
    case NodeKind.NewExpression: {
      const current = node as NewExpression;
      appendNode(children, current.callee);
      appendNodes(children, current.args);
      appendNodes(children, current.typeArguments);
      break;
    }
    case NodeKind.SpreadExpression:
      appendNode(children, (node as SpreadExpression).argument);
      break;
    case NodeKind.NamedArgument: {
      const current = node as NamedArgument;
      appendNode(children, current.name);
      appendNode(children, current.value);
      break;
    }
    case NodeKind.UnaryExpression:
      appendNode(children, (node as UnaryExpression).argument);
      break;
    case NodeKind.UpdateExpression:
      appendNode(children, (node as UpdateExpression).argument);
      break;
    case NodeKind.ArrayLiteral:
      appendNodes(children, (node as ArrayLiteral).elements);
      break;
    case NodeKind.ObjectProperty: {
      const current = node as ObjectProperty;
      appendNode(children, current.key);
      appendNode(children, current.value);
      break;
    }
    case NodeKind.ObjectSpreadProperty:
      appendNode(children, (node as ObjectSpreadProperty).argument);
      break;
    case NodeKind.ObjectLiteral:
      appendNodes(children, (node as ObjectLiteral).properties);
      break;
    case NodeKind.ImportSpecifier: {
      const current = node as ImportSpecifier;
      appendNode(children, current.imported);
      appendNode(children, current.local);
      break;
    }
    case NodeKind.ExportSpecifier: {
      const current = node as ExportSpecifier;
      appendNode(children, current.exported);
      appendNode(children, current.local);
      break;
    }
    case NodeKind.ExportStatement: {
      const current = node as ExportStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.declaration);
      appendNode(children, current.namespaceExport);
      appendNodes(children, current.specifiers);
      appendNode(children, current.from);
      break;
    }
    case NodeKind.ImportStatement: {
      const current = node as ImportStatement;
      appendNodes(children, current.annotations);
      appendNodes(children, current.specifiers);
      appendNode(children, current.from);
      appendNode(children, current.defaultImport);
      appendNode(children, current.namespaceImport);
      break;
    }
    case NodeKind.FunctionParameter: {
      const current = node as FunctionParameter;
      appendNode(children, current.name);
      appendNode(children, current.typeAnnotation);
      appendNode(children, current.defaultValue);
      break;
    }
    case NodeKind.BindingElement: {
      const current = node as BindingElement;
      appendNode(children, current.name);
      appendNode(children, current.propertyName);
      appendNode(children, current.typeAnnotation);
      appendNode(children, current.initializer);
      break;
    }
    case NodeKind.ObjectBindingPattern:
      appendNodes(children, (node as ObjectBindingPattern).elements);
      break;
    case NodeKind.ArrayBindingPattern:
      appendNodes(children, (node as ArrayBindingPattern).elements);
      break;
    case NodeKind.VarStatement: {
      const current = node as VarStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.name);
      appendNode(children, current.delegate);
      appendNode(children, current.receiverType);
      appendNodes(children, current.receiverTypeArguments);
      appendNodes(children, current.typeParameters);
      appendNode(children, current.typeAnnotation);
      appendNode(children, current.initializer);
      appendNodes(children, current.accessors);
      appendNodes(children, current.declarations);
      break;
    }
    case NodeKind.VarDeclarator: {
      const current = node as VarDeclarator;
      appendNode(children, current.name);
      appendNode(children, current.typeAnnotation);
      appendNode(children, current.initializer);
      appendNode(children, current.delegate);
      break;
    }
    case NodeKind.FunctionStatement: {
      const current = node as FunctionStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.name);
      appendNodes(children, current.parameters);
      appendNode(children, current.body);
      appendNode(children, current.receiverType);
      appendNodes(children, current.receiverTypeArguments);
      appendNodes(children, current.typeParameters);
      appendNode(children, current.returnType);
      break;
    }
    case NodeKind.AnnotationStatement: {
      const current = node as AnnotationStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.name);
      appendNodes(children, current.parameters);
      break;
    }
    case NodeKind.AnnotationApplication: {
      const current = node as AnnotationApplication;
      appendNode(children, current.name);
      appendNodes(children, current.args);
      break;
    }
    case NodeKind.ClassFieldMember: {
      const current = node as ClassFieldMember;
      appendNode(children, current.name);
      appendNode(children, current.computedKey);
      appendNode(children, current.typeAnnotation);
      appendNode(children, current.initializer);
      appendNodes(children, current.annotations);
      break;
    }
    case NodeKind.ClassMethodMember: {
      const current = node as ClassMethodMember;
      appendNode(children, current.name);
      appendNodes(children, current.parameters);
      appendNode(children, current.returnType);
      appendNodes(children, current.typeParameters);
      appendNode(children, current.body);
      appendNode(children, current.computedKey);
      appendNodes(children, current.annotations);
      break;
    }
    case NodeKind.ClassPrimaryConstructorParameter: {
      const current = node as ClassPrimaryConstructorParameter;
      appendNode(children, current.name);
      appendNode(children, current.typeAnnotation);
      appendNode(children, current.defaultValue);
      break;
    }
    case NodeKind.ClassDelegate: {
      const current = node as ClassDelegate;
      appendNode(children, current.typeAnnotation);
      appendNode(children, current.expression);
      break;
    }
    case NodeKind.ClassStatement: {
      const current = node as ClassStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.name);
      appendNodes(children, current.members);
      appendNodes(children, current.typeParameters);
      appendNode(children, current.extendsType);
      appendNodes(children, current.implementsTypes);
      appendNodes(children, current.extraExtendsTypes);
      appendNodes(children, current.extraImplementsTypes);
      appendNodes(children, current.classDelegates);
      appendNodes(children, current.primaryConstructorParameters);
      break;
    }
    case NodeKind.InterfacePropertyMember: {
      const current = node as InterfacePropertyMember;
      appendNode(children, current.name);
      appendNode(children, current.typeAnnotation);
      break;
    }
    case NodeKind.InterfaceMethodMember: {
      const current = node as InterfaceMethodMember;
      appendNode(children, current.name);
      appendNodes(children, current.parameters);
      appendNode(children, current.returnType);
      appendNodes(children, current.typeParameters);
      appendNode(children, current.computedKey);
      break;
    }
    case NodeKind.InterfaceStatement: {
      const current = node as InterfaceStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.name);
      appendNodes(children, current.members);
      appendNodes(children, current.typeParameters);
      appendNodes(children, current.extendsTypes);
      break;
    }
    case NodeKind.TypeAliasStatement: {
      const current = node as TypeAliasStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.name);
      appendNode(children, current.targetType);
      appendNodes(children, current.typeParameters);
      break;
    }
    case NodeKind.NamespaceStatement: {
      const current = node as NamespaceStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.body);
      appendNodes(children, current.names);
      appendNode(children, current.externalModuleName);
      break;
    }
    case NodeKind.EnumMember: {
      const current = node as EnumMember;
      appendNode(children, current.name);
      appendNode(children, current.initializer);
      break;
    }
    case NodeKind.EnumStatement: {
      const current = node as EnumStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.name);
      appendNodes(children, current.members);
      break;
    }
    case NodeKind.ExprStatement: {
      const current = node as ExprStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.expression);
      break;
    }
    case NodeKind.BlockStatement: {
      const current = node as BlockStatement;
      appendNodes(children, current.annotations);
      appendNodes(children, current.body);
      break;
    }
    case NodeKind.WhileStatement: {
      const current = node as WhileStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.condition);
      appendNode(children, current.body);
      break;
    }
    case NodeKind.WithStatement: {
      const current = node as WithStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.object);
      appendNode(children, current.body);
      break;
    }
    case NodeKind.LabeledStatement: {
      const current = node as LabeledStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.label);
      appendNode(children, current.body);
      break;
    }
    case NodeKind.DoWhileStatement: {
      const current = node as DoWhileStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.body);
      appendNode(children, current.condition);
      break;
    }
    case NodeKind.ForStatement: {
      const current = node as ForStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.body);
      appendNode(children, current.iterator);
      appendNode(children, current.iterable);
      appendNode(children, current.initializer);
      appendNode(children, current.condition);
      appendNode(children, current.update);
      break;
    }
    case NodeKind.IfStatement: {
      const current = node as IfStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.condition);
      appendNode(children, current.thenBranch);
      appendNode(children, current.elseBranch);
      break;
    }
    case NodeKind.SwitchCase: {
      const current = node as SwitchCase;
      appendNodes(children, current.consequent);
      appendNode(children, current.test);
      break;
    }
    case NodeKind.SwitchStatement: {
      const current = node as SwitchStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.discriminant);
      appendNodes(children, current.cases);
      break;
    }
    case NodeKind.ReturnStatement: {
      const current = node as ReturnStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.expression);
      break;
    }
    case NodeKind.ThrowStatement: {
      const current = node as ThrowStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.expression);
      break;
    }
    case NodeKind.DeferStatement: {
      const current = node as DeferStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.expression);
      break;
    }
    case NodeKind.ContinueStatement: {
      const current = node as ContinueStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.label);
      break;
    }
    case NodeKind.BreakStatement: {
      const current = node as BreakStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.label);
      break;
    }
    case NodeKind.CatchClause: {
      const current = node as CatchClause;
      appendNode(children, current.body);
      appendNode(children, current.parameter);
      break;
    }
    case NodeKind.TryStatement: {
      const current = node as TryStatement;
      appendNodes(children, current.annotations);
      appendNode(children, current.tryBlock);
      appendNode(children, current.catchClause);
      appendNode(children, current.finallyBlock);
      break;
    }
    case NodeKind.JsxElement: {
      const current = node as JsxElement;
      appendNodes(children, current.attributes);
      appendNodes(children, current.children);
      appendNode(children, current.reference);
      break;
    }
    case NodeKind.JsxFragment:
      appendNodes(children, (node as JsxFragment).children);
      break;
    case NodeKind.JsxAttribute:
      appendNode(children, (node as JsxAttribute).value);
      break;
    case NodeKind.JsxSpreadAttribute:
      appendNode(children, (node as JsxSpreadAttribute).expression);
      break;
    case NodeKind.JsxExpressionContainer:
      appendNode(children, (node as JsxExpressionContainer).expression);
      break;
    case NodeKind.Program:
      appendNodes(children, (node as Program).body);
      break;
    default:
      throw new Error(`Unsupported AST node kind: ${node.kind}`);
  }

  return children;
}

function walkAstNodes(root: Node, visit: (node: Node) => boolean): void {
  const visited = new WeakSet<object>();
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (!visit(node)) return;

    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }
}

/**
 * Walks an AST in pre-order. Shared or cyclic nodes are visited only once.
 * The visitor may return `false` to stop the whole traversal early.
 */
export function walkAst(root: Node, visit: (node: Node) => unknown): void {
  walkAstNodes(root, (node) => {
    return visit(node) !== false;
  });
}

/** Walks an AST until the visitor returns false. */
export function walkAstUntil(root: Node, visit: (node: Node) => boolean): void {
  walkAstNodes(root, visit);
}

/** Returns the first node (in pre-order) accepted by the predicate, or null. */
export function findNode<T extends Node>(
  root: Node,
  predicate: (node: Node) => node is T
): T | null {
  let found: T | null = null;
  walkAstUntil(root, (node) => {
    if (predicate(node)) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}
