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
  return statement.kind === "ExportStatement"
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
    for (const statement of items) {
      const candidate = unwrapExportedDeclaration(statement);
      if (candidate?.kind !== "NamespaceStatement") {
        continue;
      }
      const namespaceStatement = candidate as NamespaceStatement;
      index.nestedNamespaceDeclarations.push(...namespaceStatement.body.body);
      collectNestedNamespaceDeclarations(namespaceStatement.body.body);
    }
  };

  const collect = (items: readonly Statement[]): void => {
    for (const statement of items) {
      const candidate = unwrapExportedDeclaration(statement);
      if (!candidate) {
        continue;
      }

      switch (candidate.kind) {
        case "AnnotationStatement":
          index.annotations.push(candidate as AnnotationStatement);
          index.globalDeclarations.push(candidate);
          break;
        case "ClassStatement":
          index.classes.push(candidate as ClassStatement);
          index.globalDeclarations.push(candidate);
          break;
        case "EnumStatement":
          index.enums.push(candidate as EnumStatement);
          index.globalDeclarations.push(candidate);
          break;
        case "FunctionStatement":
          index.functions.push(candidate as FunctionStatement);
          index.globalDeclarations.push(candidate);
          break;
        case "ImportStatement":
          index.globalDeclarations.push(candidate);
          break;
        case "InterfaceStatement":
          index.interfaces.push(candidate as InterfaceStatement);
          index.globalDeclarations.push(candidate);
          break;
        case "NamespaceStatement": {
          const namespaceStatement = candidate as NamespaceStatement;
          index.namespaces.push(namespaceStatement);
          index.globalDeclarations.push(namespaceStatement);
          break;
        }
        case "TypeAliasStatement":
          index.typeAliases.push(candidate as TypeAliasStatement);
          index.globalDeclarations.push(candidate);
          break;
        case "VarStatement":
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
