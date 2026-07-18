import { NodeKind } from "compiler/ast/ast";
import type {
  AnnotationStatement,
  ClassStatement,
  EnumStatement,
  ExportStatement,
  FunctionStatement,
  InterfaceStatement,
  NamespaceStatement,
  Statement,
  TypeAliasStatement,
  VarStatement
} from "compiler/ast/ast";

export interface DeclarationIndex {
  annotations: AnnotationStatement[];
  classes: ClassStatement[];
  enums: EnumStatement[];
  functions: FunctionStatement[];
  globalDeclarations: Statement[];
  interfaces: InterfaceStatement[];
  namespaces: NamespaceStatement[];
  nestedNamespaceDeclarations: Statement[];
  typeAliases: TypeAliasStatement[];
  vars: VarStatement[];
}

const declarationIndexCache = new WeakMap<object, DeclarationIndex>();

function unwrapExportedDeclaration(statement: Statement): Statement | undefined {
  return statement.kind === NodeKind.ExportStatement
    ? (statement as ExportStatement).declaration
    : statement;
}

export function declarationIndexForStatements(statements: readonly Statement[]): DeclarationIndex {
  const cached = declarationIndexCache.get(statements);
  if (cached) {
    return cached;
  }

  const index: DeclarationIndex = {
    annotations: [],
    classes: [],
    enums: [],
    functions: [],
    globalDeclarations: [],
    interfaces: [],
    namespaces: [],
    nestedNamespaceDeclarations: [],
    typeAliases: [],
    vars: []
  };

  const collectNestedNamespaceDeclarations = (items: readonly Statement[]): void => {
    const pendingItems: Statement[] = [...items];
    while (pendingItems.length > 0) {
      const statement = pendingItems.pop()!;
      const candidate: Statement | undefined = unwrapExportedDeclaration(statement);
      if (candidate?.kind !== NodeKind.NamespaceStatement) {
        continue;
      }
      const namespaceStatement = candidate as NamespaceStatement;
      index.nestedNamespaceDeclarations.push(...namespaceStatement.body.body);
      pendingItems.push(...namespaceStatement.body.body);
    }
  };

  const collect = (items: readonly Statement[]): void => {
    for (const statement of items) {
      const candidate: Statement | undefined = unwrapExportedDeclaration(statement);
      if (!candidate) {
        continue;
      }

      switch (candidate.kind) {
        case NodeKind.AnnotationStatement:
          index.annotations.push(candidate as AnnotationStatement);
          index.globalDeclarations.push(candidate);
          break;
        case NodeKind.ClassStatement:
          index.classes.push(candidate as ClassStatement);
          index.globalDeclarations.push(candidate);
          break;
        case NodeKind.EnumStatement:
          index.enums.push(candidate as EnumStatement);
          index.globalDeclarations.push(candidate);
          break;
        case NodeKind.FunctionStatement:
          index.functions.push(candidate as FunctionStatement);
          index.globalDeclarations.push(candidate);
          break;
        case NodeKind.ImportStatement:
          index.globalDeclarations.push(candidate);
          break;
        case NodeKind.InterfaceStatement:
          index.interfaces.push(candidate as InterfaceStatement);
          index.globalDeclarations.push(candidate);
          break;
        case NodeKind.NamespaceStatement: {
          const namespaceStatement = candidate as NamespaceStatement;
          index.namespaces.push(namespaceStatement);
          index.globalDeclarations.push(namespaceStatement);
          break;
        }
        case NodeKind.TypeAliasStatement:
          index.typeAliases.push(candidate as TypeAliasStatement);
          index.globalDeclarations.push(candidate);
          break;
        case NodeKind.VarStatement:
          index.vars.push(candidate as VarStatement);
          index.globalDeclarations.push(candidate);
          break;
        default:
          break;
      }
    }
  };

  collect(statements);
  collectNestedNamespaceDeclarations(statements);
  declarationIndexCache.set(statements, index);
  return index;
}
