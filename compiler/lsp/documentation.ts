import {
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
import { nodeBuiltinSpecifierCandidates } from "compiler/moduleResolution";

export interface DocumentationInfo {
  text: string;
  deprecated: boolean;
}

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

export function documentationContainsDeprecatedTag(text: string): boolean {
  return /(^|\n)\s*@deprecated\b/.test(text);
}

function documentationInfoFromText(text: string | undefined): DocumentationInfo | undefined {
  if (!text) {
    return undefined;
  }
  return {
    text,
    deprecated: documentationContainsDeprecatedTag(text)
  };
}

export function readDocumentationFromIdentifier(identifier: Identifier): string | undefined {
  return readDocumentationInfoFromIdentifier(identifier)?.text;
}

export function readDocumentationInfoFromIdentifier(identifier: Identifier): DocumentationInfo | undefined {
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
    return documentationInfoFromText(normalizedLineDocumentation);
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
      return documentationInfoFromText(normalized);
    }
  }

  return undefined;
}

type NamedDocumentationNode = {
  firstToken?: Identifier["firstToken"];
  name?: Identifier;
};

export function readDocumentationFromNamedNode(node: NamedDocumentationNode): string | undefined {
  return readDocumentationInfoFromNamedNode(node)?.text;
}

export function readDocumentationInfoFromNamedNode(node: NamedDocumentationNode): DocumentationInfo | undefined {
  return readDocumentationInfoFromNodeFirstToken(node) ?? (node.name ? readDocumentationInfoFromIdentifier(node.name) : undefined);
}

export function readDocumentationFromFunctionParameter(parameter: FunctionParameter): string | undefined {
  return readDocumentationInfoFromFunctionParameter(parameter)?.text;
}

export function readDocumentationInfoFromFunctionParameter(parameter: FunctionParameter): DocumentationInfo | undefined {
  if (parameter.name.kind === "Identifier") {
    return readDocumentationInfoFromNamedNode({
      firstToken: parameter.firstToken,
      name: parameter.name
    });
  }
  return readDocumentationInfoFromNodeFirstToken(parameter);
}

export function readDocumentationFromParameterLike(parameter: {
  firstToken?: Identifier["firstToken"];
  name: FunctionParameter["name"] | Identifier;
}): string | undefined {
  return readDocumentationInfoFromParameterLike(parameter)?.text;
}

export function readDocumentationInfoFromParameterLike(parameter: {
  firstToken?: Identifier["firstToken"];
  name: FunctionParameter["name"] | Identifier;
}): DocumentationInfo | undefined {
  if (parameter.name.kind === "Identifier") {
    return readDocumentationInfoFromNamedNode({
      firstToken: parameter.firstToken,
      name: parameter.name
    });
  }
  return readDocumentationInfoFromNodeFirstToken(parameter);
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

function readDocumentationInfoFromNodeFirstToken(node: { firstToken?: Identifier["firstToken"] }): DocumentationInfo | undefined {
  const firstToken = node.firstToken;
  if (!firstToken) {
    return undefined;
  }
  return readDocumentationInfoFromIdentifier(new Identifier({
    kind: "Identifier",
    name: "",
    firstToken,
    lastToken: node.firstToken
  }) as Identifier);
}

function readDocumentationInfoFromStatement(
  statement: Statement,
  identifier: Identifier
): DocumentationInfo | undefined {
  if (statement.kind === "FunctionStatement" && identifiersMatch((statement as FunctionStatement).name, identifier)) {
    return readDocumentationInfoFromNodeFirstToken(statement) ?? readDocumentationInfoFromIdentifier((statement as FunctionStatement).name);
  }

  if (statement.kind === "ClassStatement") {
    const classStatement = statement as ClassStatement;
    if (identifiersMatch(classStatement.name, identifier)) {
      return readDocumentationInfoFromNodeFirstToken(classStatement) ?? readDocumentationInfoFromIdentifier(classStatement.name);
    }
    for (const member of classStatement.members) {
      if (identifiersMatch(member.name, identifier)) {
        return readDocumentationInfoFromNodeFirstToken(member) ?? readDocumentationInfoFromIdentifier(member.name);
      }
    }
  }

  if (statement.kind === "InterfaceStatement") {
    const interfaceStatement = statement as InterfaceStatement;
    if (identifiersMatch(interfaceStatement.name, identifier)) {
      return readDocumentationInfoFromNodeFirstToken(interfaceStatement) ?? readDocumentationInfoFromIdentifier(interfaceStatement.name);
    }
    for (const member of interfaceStatement.members) {
      if (identifiersMatch(member.name, identifier)) {
        return readDocumentationInfoFromNodeFirstToken(member) ?? readDocumentationInfoFromIdentifier(member.name);
      }
    }
  }

  if (statement.kind === "NamespaceStatement") {
    const namespaceStatement = statement as NamespaceStatement;
    if (namespaceStatement.body.kind === "BlockStatement") {
      for (const child of namespaceStatement.body.body) {
        const documentation = readDocumentationInfoFromStatement(child, identifier);
        if (documentation) {
          return documentation;
        }
      }
      return undefined;
    }
    return readDocumentationInfoFromStatement(namespaceStatement.body, identifier);
  }

  if (statement.kind === "ExportStatement") {
    const exported = statement as ExportStatement;
    if (exported.declaration) {
      const declarationDocumentation = readDocumentationInfoFromStatement(exported.declaration, identifier);
      if (declarationDocumentation) {
        return declarationDocumentation;
      }

      if (exported.declaration.kind === "FunctionStatement") {
        const functionStatement = exported.declaration as FunctionStatement;
        if (identifiersMatch(functionStatement.name, identifier)) {
          return readDocumentationInfoFromNodeFirstToken(exported);
        }
      }

      if (exported.declaration.kind === "ClassStatement") {
        const classStatement = exported.declaration as ClassStatement;
        if (identifiersMatch(classStatement.name, identifier)) {
          return readDocumentationInfoFromNodeFirstToken(exported);
        }
      }

      if (exported.declaration.kind === "InterfaceStatement") {
        const interfaceStatement = exported.declaration as InterfaceStatement;
        if (identifiersMatch(interfaceStatement.name, identifier)) {
          return readDocumentationInfoFromNodeFirstToken(exported);
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
  return readDocumentationInfoFromProgramDeclaration(program, identifier)?.text;
}

export function readDocumentationInfoFromProgramDeclaration(
  program: Program,
  identifier: Identifier
): DocumentationInfo | undefined {
  for (const statement of program.body) {
    const documentation = readDocumentationInfoFromStatement(statement, identifier);
    if (documentation) {
      return documentation;
    }
  }
  return readDocumentationInfoFromIdentifier(identifier);
}

function importedDocumentationCandidates(
  program: Program,
  identifier: Identifier
): { importPath: string; importedName: string }[] {
  const matches: { importPath: string; importedName: string }[] = [];
  for (const statement of program.body) {
    if (statement.kind !== "ImportStatement") {
      continue;
    }
    const importStatement = statement as Statement & {
      from: { value: string };
      specifiers: Array<{ imported: Identifier; local?: Identifier }>;
    };
    for (const specifier of importStatement.specifiers) {
      if (specifier.imported === identifier || specifier.local === identifier) {
        matches.push({
          importPath: importStatement.from.value,
          importedName: specifier.imported.name
        });
      }
    }
  }
  return matches;
}

function readDocumentationInfoFromStatementsByName(
  statements: readonly Statement[],
  name: string
): DocumentationInfo | undefined {
  return readDocumentationInfoFromProgramDeclaration(
    new Program({ kind: "Program", body: [...statements] }),
    new Identifier({
      kind: "Identifier",
      name
    }) as Identifier
  );
}

export function readDocumentationForSymbol(
  program: Program,
  identifier: Identifier,
  options: {
    externalDeclarations?: readonly Statement[] | undefined;
    ambientModuleDeclarations?: ReadonlyMap<string, Statement[]> | undefined;
  } = {}
): string | undefined {
  return readDocumentationInfoForSymbol(program, identifier, options)?.text;
}

export function readDocumentationInfoForSymbol(
  program: Program,
  identifier: Identifier,
  options: {
    externalDeclarations?: readonly Statement[] | undefined;
    ambientModuleDeclarations?: ReadonlyMap<string, Statement[]> | undefined;
  } = {}
): DocumentationInfo | undefined {
  const localDocumentation = readDocumentationInfoFromProgramDeclaration(program, identifier);
  if (localDocumentation) {
    return localDocumentation;
  }

  for (const candidate of importedDocumentationCandidates(program, identifier)) {
    const externalDocumentation = options.externalDeclarations
      ? readDocumentationInfoFromStatementsByName(options.externalDeclarations, candidate.importedName)
      : undefined;
    if (externalDocumentation) {
      return externalDocumentation;
    }

    for (const moduleName of nodeBuiltinSpecifierCandidates(candidate.importPath)) {
      const ambientDeclarations = options.ambientModuleDeclarations?.get(moduleName);
      if (!ambientDeclarations) {
        continue;
      }
      const ambientDocumentation = readDocumentationInfoFromStatementsByName(
        ambientDeclarations,
        candidate.importedName
      );
      if (ambientDocumentation) {
        return ambientDocumentation;
      }
    }
  }

  return readDocumentationInfoFromIdentifier(identifier);
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
