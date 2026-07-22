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

function appendNode(
  children: Node[],
  child: Node | undefined,
  key: string,
  keys: string[] | undefined
): void {
  if (child === undefined) return;
  children.push(child);
  if (keys) keys.push(key);
}

function appendNodes(
  children: Node[],
  nodes: Node[] | undefined,
  key: string,
  keys: string[] | undefined
): void {
  if (nodes === undefined) return;
  for (const child of nodes) {
    children.push(child);
    if (keys) keys.push(key);
  }
}

/**
 * Returns the direct structural AST children of a node. The explicit kind
 * dispatch keeps the compiler's own AST traversal statically typed in native
 * builds instead of enumerating object keys and performing dynamic gets.
 */
export function appendChildNodes(node: Node, children: Node[], keys?: string[]): void {
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
      appendNodes(children, (node as EmptyStatement).annotations, "annotations", keys);
      break;
    case NodeKind.DebuggerStatement:
      appendNodes(children, (node as DebuggerStatement).annotations, "annotations", keys);
      break;
    case NodeKind.TypeReference: {
      const current = node as TypeReference;
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.typeArguments, "typeArguments", keys);
      break;
    }
    case NodeKind.ArrayTypeAnnotation:
      appendNode(children, (node as ArrayTypeAnnotation).elementType, "elementType", keys);
      break;
    case NodeKind.TypeParameter: {
      const current = node as TypeParameter;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.constraint, "constraint", keys);
      appendNode(children, current.defaultType, "defaultType", keys);
      break;
    }
    case NodeKind.CommaExpression:
      appendNodes(children, (node as CommaExpression).expressions, "expressions", keys);
      break;
    case NodeKind.BinaryExpression: {
      const current = node as BinaryExpression;
      appendNode(children, current.left, "left", keys);
      appendNode(children, current.right, "right", keys);
      break;
    }
    case NodeKind.RangeExpression: {
      const current = node as RangeExpression;
      appendNode(children, current.start, "start", keys);
      appendNode(children, current.end, "end", keys);
      break;
    }
    case NodeKind.ChainExpression: {
      const current = node as ChainExpression;
      appendNode(children, current.receiver, "receiver", keys);
      appendNodes(children, current.operations, "operations", keys);
      break;
    }
    case NodeKind.AssignmentExpression: {
      const current = node as AssignmentExpression;
      appendNode(children, current.left, "left", keys);
      appendNode(children, current.right, "right", keys);
      break;
    }
    case NodeKind.ConditionalExpression: {
      const current = node as ConditionalExpression;
      appendNode(children, current.test, "test", keys);
      appendNode(children, current.consequent, "consequent", keys);
      appendNode(children, current.alternate, "alternate", keys);
      break;
    }
    case NodeKind.AsExpression: {
      const current = node as AsExpression;
      appendNode(children, current.expression, "expression", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      break;
    }
    case NodeKind.SatisfiesExpression: {
      const current = node as SatisfiesExpression;
      appendNode(children, current.expression, "expression", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      break;
    }
    case NodeKind.NonNullExpression:
      appendNode(children, (node as NonNullExpression).expression, "expression", keys);
      break;
    case NodeKind.MemberExpression: {
      const current = node as MemberExpression;
      appendNode(children, current.object, "object", keys);
      appendNode(children, current.property, "property", keys);
      break;
    }
    case NodeKind.PropertyReferenceExpression: {
      const current = node as PropertyReferenceExpression;
      appendNode(children, current.object, "object", keys);
      appendNode(children, current.property, "property", keys);
      break;
    }
    case NodeKind.CallExpression: {
      const current = node as CallExpression;
      appendNode(children, current.callee, "callee", keys);
      appendNodes(children, current.args, "args", keys);
      appendNodes(children, current.typeArguments, "typeArguments", keys);
      break;
    }
    case NodeKind.ArrowFunctionExpression: {
      const current = node as ArrowFunctionExpression;
      appendNodes(children, current.parameters, "parameters", keys);
      appendNode(children, current.returnType, "returnType", keys);
      appendNode(children, current.body, "body", keys);
      appendNode(children, current.contextualObjectLiteral, "contextualObjectLiteral", keys);
      break;
    }
    case NodeKind.FunctionExpression: {
      const current = node as FunctionExpression;
      appendNodes(children, current.parameters, "parameters", keys);
      appendNode(children, current.returnType, "returnType", keys);
      appendNode(children, current.body, "body", keys);
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      break;
    }
    case NodeKind.ClassExpression: {
      const current = node as ClassExpression;
      appendNodes(children, current.members, "members", keys);
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      appendNode(children, current.extendsType, "extendsType", keys);
      appendNodes(children, current.implementsTypes, "implementsTypes", keys);
      appendNodes(children, current.extraExtendsTypes, "extraExtendsTypes", keys);
      appendNodes(children, current.extraImplementsTypes, "extraImplementsTypes", keys);
      appendNodes(children, current.classDelegates, "classDelegates", keys);
      appendNodes(children, current.primaryConstructorParameters, "primaryConstructorParameters", keys);
      break;
    }
    case NodeKind.NewExpression: {
      const current = node as NewExpression;
      appendNode(children, current.callee, "callee", keys);
      appendNodes(children, current.args, "args", keys);
      appendNodes(children, current.typeArguments, "typeArguments", keys);
      break;
    }
    case NodeKind.SpreadExpression:
      appendNode(children, (node as SpreadExpression).argument, "argument", keys);
      break;
    case NodeKind.NamedArgument: {
      const current = node as NamedArgument;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.value, "value", keys);
      break;
    }
    case NodeKind.UnaryExpression:
      appendNode(children, (node as UnaryExpression).argument, "argument", keys);
      break;
    case NodeKind.UpdateExpression:
      appendNode(children, (node as UpdateExpression).argument, "argument", keys);
      break;
    case NodeKind.ArrayLiteral:
      appendNodes(children, (node as ArrayLiteral).elements, "elements", keys);
      break;
    case NodeKind.ObjectProperty: {
      const current = node as ObjectProperty;
      appendNode(children, current.key, "key", keys);
      appendNode(children, current.value, "value", keys);
      break;
    }
    case NodeKind.ObjectSpreadProperty:
      appendNode(children, (node as ObjectSpreadProperty).argument, "argument", keys);
      break;
    case NodeKind.ObjectLiteral:
      appendNodes(children, (node as ObjectLiteral).properties, "properties", keys);
      break;
    case NodeKind.ImportSpecifier: {
      const current = node as ImportSpecifier;
      appendNode(children, current.imported, "imported", keys);
      appendNode(children, current.local, "local", keys);
      break;
    }
    case NodeKind.ExportSpecifier: {
      const current = node as ExportSpecifier;
      appendNode(children, current.exported, "exported", keys);
      appendNode(children, current.local, "local", keys);
      break;
    }
    case NodeKind.ExportStatement: {
      const current = node as ExportStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.declaration, "declaration", keys);
      appendNode(children, current.namespaceExport, "namespaceExport", keys);
      appendNodes(children, current.specifiers, "specifiers", keys);
      appendNode(children, current.from, "from", keys);
      break;
    }
    case NodeKind.ImportStatement: {
      const current = node as ImportStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNodes(children, current.specifiers, "specifiers", keys);
      appendNode(children, current.from, "from", keys);
      appendNode(children, current.defaultImport, "defaultImport", keys);
      appendNode(children, current.namespaceImport, "namespaceImport", keys);
      break;
    }
    case NodeKind.FunctionParameter: {
      const current = node as FunctionParameter;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      appendNode(children, current.defaultValue, "defaultValue", keys);
      break;
    }
    case NodeKind.BindingElement: {
      const current = node as BindingElement;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.propertyName, "propertyName", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      appendNode(children, current.initializer, "initializer", keys);
      break;
    }
    case NodeKind.ObjectBindingPattern:
      appendNodes(children, (node as ObjectBindingPattern).elements, "elements", keys);
      break;
    case NodeKind.ArrayBindingPattern:
      appendNodes(children, (node as ArrayBindingPattern).elements, "elements", keys);
      break;
    case NodeKind.VarStatement: {
      const current = node as VarStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.delegate, "delegate", keys);
      appendNode(children, current.receiverType, "receiverType", keys);
      appendNodes(children, current.receiverTypeArguments, "receiverTypeArguments", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      appendNode(children, current.initializer, "initializer", keys);
      appendNodes(children, current.accessors, "accessors", keys);
      appendNodes(children, current.declarations, "declarations", keys);
      break;
    }
    case NodeKind.VarDeclarator: {
      const current = node as VarDeclarator;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      appendNode(children, current.initializer, "initializer", keys);
      appendNode(children, current.delegate, "delegate", keys);
      break;
    }
    case NodeKind.FunctionStatement: {
      const current = node as FunctionStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.parameters, "parameters", keys);
      appendNode(children, current.body, "body", keys);
      appendNode(children, current.receiverType, "receiverType", keys);
      appendNodes(children, current.receiverTypeArguments, "receiverTypeArguments", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      appendNode(children, current.returnType, "returnType", keys);
      break;
    }
    case NodeKind.AnnotationStatement: {
      const current = node as AnnotationStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.parameters, "parameters", keys);
      break;
    }
    case NodeKind.AnnotationApplication: {
      const current = node as AnnotationApplication;
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.args, "args", keys);
      break;
    }
    case NodeKind.ClassFieldMember: {
      const current = node as ClassFieldMember;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.computedKey, "computedKey", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      appendNode(children, current.initializer, "initializer", keys);
      appendNodes(children, current.annotations, "annotations", keys);
      break;
    }
    case NodeKind.ClassMethodMember: {
      const current = node as ClassMethodMember;
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.parameters, "parameters", keys);
      appendNode(children, current.returnType, "returnType", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      appendNode(children, current.body, "body", keys);
      appendNode(children, current.computedKey, "computedKey", keys);
      appendNodes(children, current.annotations, "annotations", keys);
      break;
    }
    case NodeKind.ClassPrimaryConstructorParameter: {
      const current = node as ClassPrimaryConstructorParameter;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      appendNode(children, current.defaultValue, "defaultValue", keys);
      break;
    }
    case NodeKind.ClassDelegate: {
      const current = node as ClassDelegate;
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      appendNode(children, current.expression, "expression", keys);
      break;
    }
    case NodeKind.ClassStatement: {
      const current = node as ClassStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.members, "members", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      appendNode(children, current.extendsType, "extendsType", keys);
      appendNodes(children, current.implementsTypes, "implementsTypes", keys);
      appendNodes(children, current.extraExtendsTypes, "extraExtendsTypes", keys);
      appendNodes(children, current.extraImplementsTypes, "extraImplementsTypes", keys);
      appendNodes(children, current.classDelegates, "classDelegates", keys);
      appendNodes(children, current.primaryConstructorParameters, "primaryConstructorParameters", keys);
      break;
    }
    case NodeKind.InterfacePropertyMember: {
      const current = node as InterfacePropertyMember;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.typeAnnotation, "typeAnnotation", keys);
      break;
    }
    case NodeKind.InterfaceMethodMember: {
      const current = node as InterfaceMethodMember;
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.parameters, "parameters", keys);
      appendNode(children, current.returnType, "returnType", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      appendNode(children, current.computedKey, "computedKey", keys);
      break;
    }
    case NodeKind.InterfaceStatement: {
      const current = node as InterfaceStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.members, "members", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      appendNodes(children, current.extendsTypes, "extendsTypes", keys);
      break;
    }
    case NodeKind.TypeAliasStatement: {
      const current = node as TypeAliasStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.targetType, "targetType", keys);
      appendNodes(children, current.typeParameters, "typeParameters", keys);
      break;
    }
    case NodeKind.NamespaceStatement: {
      const current = node as NamespaceStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.body, "body", keys);
      appendNodes(children, current.names, "names", keys);
      appendNode(children, current.externalModuleName, "externalModuleName", keys);
      break;
    }
    case NodeKind.EnumMember: {
      const current = node as EnumMember;
      appendNode(children, current.name, "name", keys);
      appendNode(children, current.initializer, "initializer", keys);
      break;
    }
    case NodeKind.EnumStatement: {
      const current = node as EnumStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.name, "name", keys);
      appendNodes(children, current.members, "members", keys);
      break;
    }
    case NodeKind.ExprStatement: {
      const current = node as ExprStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.expression, "expression", keys);
      break;
    }
    case NodeKind.BlockStatement: {
      const current = node as BlockStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNodes(children, current.body, "body", keys);
      break;
    }
    case NodeKind.WhileStatement: {
      const current = node as WhileStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.condition, "condition", keys);
      appendNode(children, current.body, "body", keys);
      break;
    }
    case NodeKind.WithStatement: {
      const current = node as WithStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.object, "object", keys);
      appendNode(children, current.body, "body", keys);
      break;
    }
    case NodeKind.LabeledStatement: {
      const current = node as LabeledStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.label, "label", keys);
      appendNode(children, current.body, "body", keys);
      break;
    }
    case NodeKind.DoWhileStatement: {
      const current = node as DoWhileStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.body, "body", keys);
      appendNode(children, current.condition, "condition", keys);
      break;
    }
    case NodeKind.ForStatement: {
      const current = node as ForStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.body, "body", keys);
      appendNode(children, current.iterator, "iterator", keys);
      appendNode(children, current.iterable, "iterable", keys);
      appendNode(children, current.initializer, "initializer", keys);
      appendNode(children, current.condition, "condition", keys);
      appendNode(children, current.update, "update", keys);
      break;
    }
    case NodeKind.IfStatement: {
      const current = node as IfStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.condition, "condition", keys);
      appendNode(children, current.thenBranch, "thenBranch", keys);
      appendNode(children, current.elseBranch, "elseBranch", keys);
      break;
    }
    case NodeKind.SwitchCase: {
      const current = node as SwitchCase;
      appendNodes(children, current.consequent, "consequent", keys);
      appendNode(children, current.test, "test", keys);
      break;
    }
    case NodeKind.SwitchStatement: {
      const current = node as SwitchStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.discriminant, "discriminant", keys);
      appendNodes(children, current.cases, "cases", keys);
      break;
    }
    case NodeKind.ReturnStatement: {
      const current = node as ReturnStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.expression, "expression", keys);
      break;
    }
    case NodeKind.ThrowStatement: {
      const current = node as ThrowStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.expression, "expression", keys);
      break;
    }
    case NodeKind.DeferStatement: {
      const current = node as DeferStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.expression, "expression", keys);
      break;
    }
    case NodeKind.ContinueStatement: {
      const current = node as ContinueStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.label, "label", keys);
      break;
    }
    case NodeKind.BreakStatement: {
      const current = node as BreakStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.label, "label", keys);
      break;
    }
    case NodeKind.CatchClause: {
      const current = node as CatchClause;
      appendNode(children, current.body, "body", keys);
      appendNode(children, current.parameter, "parameter", keys);
      break;
    }
    case NodeKind.TryStatement: {
      const current = node as TryStatement;
      appendNodes(children, current.annotations, "annotations", keys);
      appendNode(children, current.tryBlock, "tryBlock", keys);
      appendNode(children, current.catchClause, "catchClause", keys);
      appendNode(children, current.finallyBlock, "finallyBlock", keys);
      break;
    }
    case NodeKind.JsxElement: {
      const current = node as JsxElement;
      appendNodes(children, current.attributes, "attributes", keys);
      appendNodes(children, current.children, "children", keys);
      appendNode(children, current.reference, "reference", keys);
      break;
    }
    case NodeKind.JsxFragment:
      appendNodes(children, (node as JsxFragment).children, "children", keys);
      break;
    case NodeKind.JsxAttribute:
      appendNode(children, (node as JsxAttribute).value, "value", keys);
      break;
    case NodeKind.JsxSpreadAttribute:
      appendNode(children, (node as JsxSpreadAttribute).expression, "expression", keys);
      break;
    case NodeKind.JsxExpressionContainer:
      appendNode(children, (node as JsxExpressionContainer).expression, "expression", keys);
      break;
    case NodeKind.Program:
      appendNodes(children, (node as Program).body, "body", keys);
      break;
    default:
      throw new Error(`Unsupported AST node kind: ${node.kind}`);
  }

}

export function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  appendChildNodes(node, children);
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
