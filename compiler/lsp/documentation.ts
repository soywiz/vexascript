import type {
  ClassStatement,
  ExportStatement,
  FunctionStatement,
  Identifier,
  InterfaceStatement,
  NamespaceStatement,
  Program,
  Statement
} from "compiler/ast/ast";

export function readDocumentationFromIdentifier(identifier: Identifier): string | undefined {
  const comments = identifier.firstToken?.leadingComments;
  if (!comments || comments.length === 0) {
    return undefined;
  }

  const lineDocumentation: string[] = [];
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (!comment || comment.kind !== "line" || !comment.value.startsWith("///")) {
      if (lineDocumentation.length > 0) {
        break;
      }
      continue;
    }

    lineDocumentation.unshift(comment.value.replace(/^\/\/\/\s?/, "").trimEnd());
  }

  const normalizedLineDocumentation = lineDocumentation.join("\n").trim();
  if (normalizedLineDocumentation.length > 0) {
    return normalizedLineDocumentation;
  }

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (!comment || comment.kind !== "block" || !comment.value.startsWith("/**")) {
      continue;
    }

    const withoutMarkers = comment.value
      .replace(/^\/\*\*/, "")
      .replace(/\*\/$/, "");
    const lines = withoutMarkers
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd());
    const normalized = lines.join("\n").trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return undefined;
}

function identifiersMatch(left: Identifier, right: Identifier): boolean {
  if (left === right) {
    return true;
  }
  if (left.name !== right.name) {
    return false;
  }

  const leftStart = left.firstToken?.range.start;
  const rightStart = right.firstToken?.range.start;
  const leftEnd = left.lastToken?.range.end;
  const rightEnd = right.lastToken?.range.end;
  if (leftStart && rightStart && leftEnd && rightEnd) {
    return (
      leftStart.line === rightStart.line &&
      leftStart.column === rightStart.column &&
      leftEnd.line === rightEnd.line &&
      leftEnd.column === rightEnd.column
    );
  }

  return true;
}

function readDocumentationFromNodeFirstToken(node: { firstToken?: Identifier["firstToken"] }): string | undefined {
  const firstToken = node.firstToken;
  if (!firstToken) {
    return undefined;
  }
  return readDocumentationFromIdentifier({
    kind: "Identifier",
    name: "",
    firstToken,
    lastToken: node.firstToken
  } as Identifier);
}

function readDocumentationFromStatement(
  statement: Statement,
  identifier: Identifier
): string | undefined {
  if (statement.kind === "FunctionStatement" && identifiersMatch((statement as FunctionStatement).name, identifier)) {
    return readDocumentationFromNodeFirstToken(statement) ?? readDocumentationFromIdentifier((statement as FunctionStatement).name);
  }

  if (statement.kind === "ClassStatement") {
    const classStatement = statement as ClassStatement;
    if (identifiersMatch(classStatement.name, identifier)) {
      return readDocumentationFromNodeFirstToken(classStatement) ?? readDocumentationFromIdentifier(classStatement.name);
    }
    for (const member of classStatement.members) {
      if (identifiersMatch(member.name, identifier)) {
        return readDocumentationFromNodeFirstToken(member) ?? readDocumentationFromIdentifier(member.name);
      }
    }
  }

  if (statement.kind === "InterfaceStatement") {
    const interfaceStatement = statement as InterfaceStatement;
    if (identifiersMatch(interfaceStatement.name, identifier)) {
      return readDocumentationFromNodeFirstToken(interfaceStatement) ?? readDocumentationFromIdentifier(interfaceStatement.name);
    }
    for (const member of interfaceStatement.members) {
      if (identifiersMatch(member.name, identifier)) {
        return readDocumentationFromNodeFirstToken(member) ?? readDocumentationFromIdentifier(member.name);
      }
    }
  }

  if (statement.kind === "NamespaceStatement") {
    const namespaceStatement = statement as NamespaceStatement;
    if (namespaceStatement.body.kind === "BlockStatement") {
      for (const child of namespaceStatement.body.body) {
        const documentation = readDocumentationFromStatement(child, identifier);
        if (documentation) {
          return documentation;
        }
      }
      return undefined;
    }
    return readDocumentationFromStatement(namespaceStatement.body, identifier);
  }

  if (statement.kind === "ExportStatement") {
    const exported = statement as ExportStatement;
    if (exported.declaration) {
      return readDocumentationFromStatement(exported.declaration, identifier);
    }
  }

  return undefined;
}

export function readDocumentationFromProgramDeclaration(
  program: Program,
  identifier: Identifier
): string | undefined {
  for (const statement of program.body) {
    const documentation = readDocumentationFromStatement(statement, identifier);
    if (documentation) {
      return documentation;
    }
  }
  return readDocumentationFromIdentifier(identifier);
}
