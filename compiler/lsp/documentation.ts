import type {
  ClassStatement,
  ExportStatement,
  FunctionStatement,
  FunctionParameter,
  Identifier,
  InterfaceStatement,
  NamespaceStatement,
  Program,
  Statement
} from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import type { TokenComment, SourcePosition, SourceRange } from "compiler/parser/tokenizer";

export interface DocumentationParameterReference {
  parameter: FunctionParameter;
  referenceName: string;
  referenceRange: SourceRange;
}

interface ParameterDocumentationContext {
  parameter: FunctionParameter;
  referenceName: string;
  comments: TokenComment[] | undefined;
}

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

function parameterIdentifierMatches(parameter: FunctionParameter, identifier: Identifier): Identifier | null {
  return bindingIdentifiers(parameter.name).find((candidate) => identifiersMatch(candidate, identifier)) ?? null;
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
      const declarationDocumentation = readDocumentationFromStatement(exported.declaration, identifier);
      if (declarationDocumentation) {
        return declarationDocumentation;
      }

      if (exported.declaration.kind === "FunctionStatement") {
        const functionStatement = exported.declaration as FunctionStatement;
        if (identifiersMatch(functionStatement.name, identifier)) {
          return readDocumentationFromNodeFirstToken(exported);
        }
      }

      if (exported.declaration.kind === "ClassStatement") {
        const classStatement = exported.declaration as ClassStatement;
        if (identifiersMatch(classStatement.name, identifier)) {
          return readDocumentationFromNodeFirstToken(exported);
        }
      }

      if (exported.declaration.kind === "InterfaceStatement") {
        const interfaceStatement = exported.declaration as InterfaceStatement;
        if (identifiersMatch(interfaceStatement.name, identifier)) {
          return readDocumentationFromNodeFirstToken(exported);
        }
      }
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

function positionWithinRange(range: SourceRange, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.column) {
    return false;
  }
  if (line === range.end.line && character > range.end.column) {
    return false;
  }
  return true;
}

function advancePosition(position: SourcePosition, text: string): SourcePosition {
  let line = position.line;
  let column = position.column;
  let offset = position.offset;
  for (const character of text) {
    offset += character.length;
    if (character === "\n") {
      line += 1;
      column = 0;
      continue;
    }
    column += character.length;
  }
  return { offset, line, column };
}

function documentationReferenceMatches(comment: TokenComment): Iterable<DocumentationParameterReferenceMatch> {
  return findDocumentationReferenceMatches(comment.value, comment.range.start);
}

interface DocumentationParameterReferenceMatch {
  referenceName: string;
  referenceRange: SourceRange;
}

function* findDocumentationReferenceMatches(
  text: string,
  start: SourcePosition
): Iterable<DocumentationParameterReferenceMatch> {
  const pattern = /\[([A-Za-z_][A-Za-z0-9_]*)\]/g;
  for (const match of text.matchAll(pattern)) {
    const fullMatch = match[0];
    const referenceName = match[1];
    const matchIndex = match.index;
    if (!fullMatch || referenceName === undefined || matchIndex === undefined) {
      continue;
    }
    const before = text.slice(0, matchIndex);
    const bracketStart = advancePosition(start, before);
    const matchStart = advancePosition(bracketStart, "[");
    const matchEnd = advancePosition(matchStart, referenceName);
    yield {
      referenceName,
      referenceRange: {
        start: matchStart,
        end: matchEnd
      }
    };
  }
}

function findParameterByName(parameters: FunctionParameter[], referenceName: string): FunctionParameter | null {
  for (const parameter of parameters) {
    if (bindingIdentifiers(parameter.name).some((identifier) => identifier.name === referenceName)) {
      return parameter;
    }
  }
  return null;
}

function collectDocumentationReferenceRanges(
  comments: TokenComment[] | undefined,
  referenceName: string
): SourceRange[] {
  if (!comments || comments.length === 0) {
    return [];
  }

  const ranges: SourceRange[] = [];
  for (const comment of comments) {
    if (
      (comment.kind !== "line" || !comment.value.startsWith("///")) &&
      (comment.kind !== "block" || !comment.value.startsWith("/**"))
    ) {
      continue;
    }

    for (const match of documentationReferenceMatches(comment)) {
      if (match.referenceName === referenceName) {
        ranges.push(match.referenceRange);
      }
    }
  }

  return ranges;
}

function findParameterReferenceInComments(
  comments: TokenComment[] | undefined,
  parameters: FunctionParameter[],
  line: number,
  character: number
): DocumentationParameterReference | null {
  if (!comments || comments.length === 0 || parameters.length === 0) {
    return null;
  }

  for (const comment of comments) {
    if (
      (comment.kind !== "line" || !comment.value.startsWith("///")) &&
      (comment.kind !== "block" || !comment.value.startsWith("/**"))
    ) {
      continue;
    }
    if (!positionWithinRange(comment.range, line, character)) {
      continue;
    }

    for (const match of documentationReferenceMatches(comment)) {
      if (!positionWithinRange(match.referenceRange, line, character)) {
        continue;
      }
      const parameter = findParameterByName(parameters, match.referenceName);
      if (!parameter) {
        return null;
      }
      return {
        parameter,
        referenceName: match.referenceName,
        referenceRange: match.referenceRange
      };
    }
  }

  return null;
}

function findParameterReferenceInStatement(
  statement: Statement,
  line: number,
  character: number
): DocumentationParameterReference | null {
  if (statement.kind === "FunctionStatement") {
    return findParameterReferenceInComments(statement.firstToken?.leadingComments, (statement as FunctionStatement).parameters, line, character);
  }

  if (statement.kind === "ClassStatement") {
    const classStatement = statement as ClassStatement;
    for (const member of classStatement.members) {
      if (member.kind !== "ClassMethodMember") {
        continue;
      }
      const reference = findParameterReferenceInComments(member.firstToken?.leadingComments, member.parameters, line, character);
      if (reference) {
        return reference;
      }
    }
  }

  if (statement.kind === "InterfaceStatement") {
    const interfaceStatement = statement as InterfaceStatement;
    for (const member of interfaceStatement.members) {
      if (member.kind !== "InterfaceMethodMember") {
        continue;
      }
      const reference = findParameterReferenceInComments(member.firstToken?.leadingComments, member.parameters, line, character);
      if (reference) {
        return reference;
      }
    }
  }

  if (statement.kind === "NamespaceStatement") {
    const namespaceStatement = statement as NamespaceStatement;
    if (namespaceStatement.body.kind === "BlockStatement") {
      for (const child of namespaceStatement.body.body) {
        const reference = findParameterReferenceInStatement(child, line, character);
        if (reference) {
          return reference;
        }
      }
      return null;
    }
    return findParameterReferenceInStatement(namespaceStatement.body, line, character);
  }

  if (statement.kind === "ExportStatement") {
    const exported = statement as ExportStatement;
    if (exported.declaration) {
      return findParameterReferenceInStatement(exported.declaration, line, character);
    }
  }

  return null;
}

function findParameterDocumentationContextInStatement(
  statement: Statement,
  identifier: Identifier
): ParameterDocumentationContext | null {
  if (statement.kind === "FunctionStatement") {
    for (const parameter of (statement as FunctionStatement).parameters) {
      const matchingIdentifier = parameterIdentifierMatches(parameter, identifier);
      if (matchingIdentifier) {
        return {
          parameter,
          referenceName: matchingIdentifier.name,
          comments: statement.firstToken?.leadingComments
        };
      }
    }
    return null;
  }

  if (statement.kind === "ClassStatement") {
    const classStatement = statement as ClassStatement;
    for (const member of classStatement.members) {
      if (member.kind !== "ClassMethodMember") {
        continue;
      }
      for (const parameter of member.parameters) {
        const matchingIdentifier = parameterIdentifierMatches(parameter, identifier);
        if (matchingIdentifier) {
          return {
            parameter,
            referenceName: matchingIdentifier.name,
            comments: member.firstToken?.leadingComments
          };
        }
      }
    }
    return null;
  }

  if (statement.kind === "InterfaceStatement") {
    const interfaceStatement = statement as InterfaceStatement;
    for (const member of interfaceStatement.members) {
      if (member.kind !== "InterfaceMethodMember") {
        continue;
      }
      for (const parameter of member.parameters) {
        const matchingIdentifier = parameterIdentifierMatches(parameter, identifier);
        if (matchingIdentifier) {
          return {
            parameter,
            referenceName: matchingIdentifier.name,
            comments: member.firstToken?.leadingComments
          };
        }
      }
    }
    return null;
  }

  if (statement.kind === "NamespaceStatement") {
    const namespaceStatement = statement as NamespaceStatement;
    if (namespaceStatement.body.kind === "BlockStatement") {
      for (const child of namespaceStatement.body.body) {
        const context = findParameterDocumentationContextInStatement(child, identifier);
        if (context) {
          return context;
        }
      }
      return null;
    }
    return findParameterDocumentationContextInStatement(namespaceStatement.body, identifier);
  }

  if (statement.kind === "ExportStatement") {
    const exported = statement as ExportStatement;
    if (exported.declaration) {
      return findParameterDocumentationContextInStatement(exported.declaration, identifier);
    }
  }

  return null;
}

export function findDocumentationParameterReference(
  program: Program,
  line: number,
  character: number
): DocumentationParameterReference | null {
  for (const statement of program.body) {
    const reference = findParameterReferenceInStatement(statement, line, character);
    if (reference) {
      return reference;
    }
  }
  return null;
}

export function findDocumentationReferenceRangesForIdentifier(
  program: Program,
  identifier: Identifier
): SourceRange[] {
  for (const statement of program.body) {
    const context = findParameterDocumentationContextInStatement(statement, identifier);
    if (!context) {
      continue;
    }
    return collectDocumentationReferenceRanges(
      context.comments,
      context.referenceName
    );
  }
  return [];
}
