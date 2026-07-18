export interface TypeNameShape {
  baseName: string;
  typeArguments: string[];
  arrayDepth: number;
}

export interface OptionalTypeNameSuffix {
  typeName: string;
  optional: boolean;
}

export interface ArraySuffixTypeName {
  elementTypeName: string;
  arrayDepth: number;
}

export interface TemplateLiteralTypeSegment {
  kind: "text" | "type";
  value: string;
}

export interface ConditionalTypeText {
  checkTypeText: string;
  extendsTypeText: string;
  trueTypeText: string;
  falseTypeText: string;
}

export interface ReadonlyContainerTypeText {
  kind: "array" | "tuple";
  elementTypeText?: string;
  tupleElementTypeTexts?: string[];
}

export interface MappedTypeMemberText {
  readonlyModifier?: "readonly" | "+readonly" | "-readonly";
  keyParameterName: string;
  keySourceText: string;
  keyRemapText?: string;
  optionalModifier?: "?" | "+?" | "-?";
  valueTypeText: string;
}

export interface AssertionTypePredicateText {
  targetText: string;
  assertedTypeText?: string;
}

interface TypeTextDepths {
  angle: number;
  paren: number;
  bracket: number;
  brace: number;
}

interface FunctionTypeParameterText {
  name: string;
  constraintTypeName?: string;
  defaultTypeName?: string;
}

const TYPE_TEXT_CACHE_LIMIT = 8192;
const topLevelTypePartsCache = new Map<string, any>();
const typeNameShapeCache = new Map<string, any>();
const conditionalTypeTextCache = new Map<string, any>();

function cacheTypeTextResult(cache: Map<string, any>, key: string, value: any): any {
  if (cache.size >= TYPE_TEXT_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

function scanTypeText(
  text: string,
  visit: (character: string, index: number, isTopLevel: boolean) => boolean | void
): void {
  const depths: TypeTextDepths = { angle: 0, paren: 0, bracket: 0, brace: 0 };
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    const previous = index > 0 ? text.charAt(index - 1) : "";

    if (quote) {
      if (character === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    const isTopLevel = Object.values(depths).every((depth) => depth === 0);
    if (visit(character, index, isTopLevel) === false) {
      return;
    }

    if (character === "<") depths.angle += 1;
    else if (character === ">") depths.angle = Math.max(0, depths.angle - 1);
    else if (character === "(") depths.paren += 1;
    else if (character === ")") depths.paren = Math.max(0, depths.paren - 1);
    else if (character === "[") depths.bracket += 1;
    else if (character === "]") depths.bracket = Math.max(0, depths.bracket - 1);
    else if (character === "{") depths.brace += 1;
    else if (character === "}") depths.brace = Math.max(0, depths.brace - 1);
  }
}

/** Splits type text at delimiters that are outside all nested type structures. */
export function splitTopLevelDelimitedTypeText(
  text: string,
  delimiters: ReadonlySet<string> = new Set([","])
): string[] {
  const parts: string[] = [];
  let partStart = 0;

  scanTypeText(text, (character, index, isTopLevel) => {
    if (isTopLevel && delimiters.has(character)) {
      const part = text.slice(partStart, index).trim();
      if (part.length > 0) {
        parts.push(part);
      }
      partStart = index + 1;
    }
  });

  const finalPart = text.slice(partStart).trim();
  if (finalPart.length > 0) {
    parts.push(finalPart);
  }
  return parts;
}

/** Finds a character that is outside all nested type structures. */
export function findTopLevelTypeCharacter(text: string, target: string): number {
  let foundIndex = -1;
  scanTypeText(text, (character, index, isTopLevel) => {
    if (isTopLevel && character === target) {
      foundIndex = index;
      return false;
    }
    return true;
  });
  return foundIndex;
}

/** Finds the delimiter matching an opening delimiter, ignoring delimiters in quoted text. */
export function findMatchingTypeDelimiter(
  text: string,
  openIndex: number,
  open: string,
  close: string
): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text.charAt(index);
    const previous = index > 0 ? text.charAt(index - 1) : "";
    if (quote) {
      if (character === quote && previous !== "\\") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function splitTypeArgumentText(argumentBody: string): string[] {
  return splitTopLevelDelimitedTypeText(argumentBody);
}

export function parseAssertionTypePredicateText(typeName: string): AssertionTypePredicateText | null {
  const normalized = stripEnclosingTypeParens(typeName.trim());
  const match = /^asserts\s+([A-Za-z_$][\w$]*|this)(?:\s+is\s+(.+))?$/.exec(normalized);
  if (!match?.[1]) {
    return null;
  }
  return {
    targetText: match[1],
    ...(match[2]?.trim() ? { assertedTypeText: match[2].trim() } : {})
  };
}

export function splitOptionalTypeSuffix(typeName: string): OptionalTypeNameSuffix {
  const trimmed = typeName.trim();
  if (!trimmed.endsWith("?")) {
    return { typeName: trimmed, optional: false };
  }

  let trailingQuestionAtTopLevel = false;
  scanTypeText(trimmed, (character, index, isTopLevel) => {
    if (isTopLevel && index === trimmed.length - 1 && character === "?") {
      trailingQuestionAtTopLevel = true;
      return false;
    }
    return true;
  });

  if (!trailingQuestionAtTopLevel) {
    return { typeName: trimmed, optional: false };
  }
  return {
    typeName: trimmed.slice(0, -1).trimEnd(),
    optional: true
  };
}

export function parseTypeNameShape(typeName: string): TypeNameShape {
  const cached = typeNameShapeCache.get(typeName);
  if (cached) return { ...cached, typeArguments: [...cached.typeArguments] };
  let remaining = typeName.trim();
  let arrayDepth = 0;
  while (remaining.endsWith("[]")) {
    arrayDepth += 1;
    remaining = remaining.slice(0, -2).trim();
  }

  const genericStart = remaining.indexOf("<");
  if (genericStart < 0 || !remaining.endsWith(">")) {
    const result = { baseName: remaining, typeArguments: [], arrayDepth };
    cacheTypeTextResult(typeNameShapeCache, typeName, result);
    return { ...result, typeArguments: [] };
  }

  const baseName = remaining.slice(0, genericStart).trim();
  const argumentBody = remaining.slice(genericStart + 1, -1).trim();
  const result = {
    baseName,
    typeArguments: splitTypeArgumentText(argumentBody),
    arrayDepth
  };
  cacheTypeTextResult(typeNameShapeCache, typeName, result);
  return { ...result, typeArguments: [...result.typeArguments] };
}

export function baseTypeName(typeName: string): string {
  return parseTypeNameShape(typeName).baseName;
}

/** Maps VexaScript primitive type names to their JavaScript boxed equivalents. */
export function boxedPrimitiveTypeName(typeName: string): string {
  if (typeName === "int" || typeName === "number" || typeName === "numeric") {
    return "Number";
  }
  if (typeName === "string") {
    return "String";
  }
  if (typeName === "boolean") {
    return "Boolean";
  }
  if (typeName === "bigint" || typeName === "long") {
    return "BigInt";
  }
  return typeName;
}

export function substituteTypeNameText(typeName: string, substitutions: ReadonlyMap<string, string>): string {
  const substituteIdentifierTokens = (text: string): string => {
    let result = "";
    let index = 0;
    let quote: string | null = null;

    const previousNonWhitespaceCharacter = (start: number): string | null => {
      for (let cursor = start - 1; cursor >= 0; cursor -= 1) {
        const character = text.charAt(cursor);
        if (!/\s/.test(character)) {
          return character;
        }
      }
      return null;
    };
    const nextNonWhitespaceCharacter = (start: number): string | null => {
      for (let cursor = start; cursor < text.length; cursor += 1) {
        const character = text.charAt(cursor);
        if (!/\s/.test(character)) {
          return character;
        }
      }
      return null;
    };

    while (index < text.length) {
      const character = text.charAt(index);
      const previous = index > 0 ? text.charAt(index - 1) : "";

      if (quote) {
        result += character;
        if (character === quote && previous !== "\\") {
          quote = null;
        }
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        result += character;
        index += 1;
        continue;
      }

      if (/[A-Za-z_$]/.test(character)) {
        let end = index + 1;
        while (end < text.length && /[\w$]/.test(text.charAt(end))) {
          end += 1;
        }
        const identifier = text.slice(index, end);
        const replacement = substitutions.get(identifier);
        const previousSignificant = previousNonWhitespaceCharacter(index);
        const nextSignificant = nextNonWhitespaceCharacter(end);
        const canReplace = replacement
          && previousSignificant !== "."
          && nextSignificant !== ":";
        result += canReplace ? replacement : identifier;
        index = end;
        continue;
      }

      result += character;
      index += 1;
    }

    return result;
  };

  const trimmed = typeName.trim();
  if (trimmed.endsWith("?")) {
    return `${substituteTypeNameText(stripEnclosingTypeParens(trimmed.slice(0, -1).trim()), substitutions)}?`;
  }

  const parsed = parseTypeNameShape(trimmed);
  const substitutedBase = substitutions.get(parsed.baseName) ?? parsed.baseName;
  const substitutedArgs = parsed.typeArguments.map((argument) =>
    substituteTypeNameText(argument, substitutions)
  );

  let substituted =
    substitutedArgs.length > 0
      ? `${substitutedBase}<${substitutedArgs.join(", ")}>`
      : substitutedBase;
  for (let i = 0; i < parsed.arrayDepth; i += 1) {
    substituted += "[]";
  }
  return substituteIdentifierTokens(substituted);
}

export function splitTopLevelTypeText(typeName: string, separator: "|" | "&" | ","): string[] {
  const key = `${separator}:${typeName}`;
  const cached = topLevelTypePartsCache.get(key);
  if (cached) return [...cached];
  const result = splitTopLevelDelimitedTypeText(typeName, new Set([separator]));
  cacheTypeTextResult(topLevelTypePartsCache, key, result);
  return [...result];
}

export function stripEnclosingTypeParens(typeName: string): string {
  const trimmed = typeName.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return trimmed;
  }
  if (findMatchingTypeDelimiter(trimmed, 0, "(", ")") !== trimmed.length - 1) {
    return trimmed;
  }
  return stripEnclosingTypeParens(trimmed.slice(1, -1));
}

/**
 * Strips an optional rest marker (`...`) and a labeled-element prefix
 * (`name:` or `name?:`) from a raw tuple element type string, returning just
 * the element's type text.
 */
export function tupleElementTypeText(elementText: string): string {
  let trimmed = elementText.trim();
  if (trimmed.startsWith("...")) {
    trimmed = trimmed.slice(3).trim();
  }
  const colonIndex = findTopLevelTypeCharacter(trimmed, ":");
  if (colonIndex >= 0) {
    const label = trimmed.slice(0, colonIndex).trim();
    if (/^[A-Za-z_$][\w$]*\??$/.test(label)) {
      return trimmed.slice(colonIndex + 1).trim();
    }
  }
  return trimmed;
}

export function parseTemplateLiteralTypeText(typeName: string): TemplateLiteralTypeSegment[] | null {
  const trimmed = typeName.trim();
  if (!trimmed.startsWith("`") || !trimmed.endsWith("`")) {
    return null;
  }

  const body = trimmed.slice(1, -1);
  const segments: TemplateLiteralTypeSegment[] = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < body.length) {
    if (body[cursor] === "$" && body[cursor + 1] === "{") {
      if (textStart < cursor) {
        segments.push({ kind: "text", value: body.slice(textStart, cursor) });
      }
      const typeStart = cursor + 2;
      let depth = 1;
      cursor = typeStart;
      while (cursor < body.length && depth > 0) {
        const character = body[cursor]!;
        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
        }
        cursor += 1;
      }
      if (depth !== 0) {
        return null;
      }
      segments.push({
        kind: "type",
        value: body.slice(typeStart, cursor - 1).trim()
      });
      textStart = cursor;
      continue;
    }
    cursor += 1;
  }

  if (textStart < body.length) {
    segments.push({ kind: "text", value: body.slice(textStart) });
  }

  return segments.length > 0 ? segments : [{ kind: "text", value: "" }];
}

export function parseConditionalTypeText(typeName: string): ConditionalTypeText | null {
  if (conditionalTypeTextCache.has(typeName)) {
    const cached = conditionalTypeTextCache.get(typeName);
    return cached ? { ...cached } : null;
  }
  const trimmed = typeName.trim();
  const questionIndex = findTopLevelTypeCharacter(trimmed, "?");
  if (questionIndex < 0) {
    cacheTypeTextResult(conditionalTypeTextCache, typeName, null);
    return null;
  }
  const falseBranchSeparator = findTopLevelTypeCharacter(trimmed.slice(questionIndex + 1), ":");
  if (falseBranchSeparator < 0) {
    cacheTypeTextResult(conditionalTypeTextCache, typeName, null);
    return null;
  }

  const conditionText = trimmed.slice(0, questionIndex).trim();
  const trueTypeText = trimmed.slice(questionIndex + 1, questionIndex + 1 + falseBranchSeparator).trim();
  const falseTypeText = trimmed.slice(questionIndex + 1 + falseBranchSeparator + 1).trim();
  const extendsIndex = findTopLevelExtendsKeyword(conditionText);
  if (extendsIndex < 0) {
    cacheTypeTextResult(conditionalTypeTextCache, typeName, null);
    return null;
  }

  const checkTypeText = conditionText.slice(0, extendsIndex).trim();
  const extendsTypeText = conditionText.slice(extendsIndex + "extends".length).trim();
  if (!checkTypeText || !extendsTypeText || !trueTypeText || !falseTypeText) {
    cacheTypeTextResult(conditionalTypeTextCache, typeName, null);
    return null;
  }

  const result = {
    checkTypeText,
    extendsTypeText,
    trueTypeText,
    falseTypeText
  };
  cacheTypeTextResult(conditionalTypeTextCache, typeName, result);
  return { ...result };
}

export function parseReadonlyContainerTypeText(typeName: string): ReadonlyContainerTypeText | null {
  const trimmed = stripEnclosingTypeParens(typeName.trim());
  if (!/^readonly(?:\s+|\[)/.test(trimmed)) {
    return null;
  }

  const inner = trimmed.slice("readonly".length).trim();
  if (inner.startsWith("[") && inner.endsWith("]")) {
    const tupleBody = inner.slice(1, -1).trim();
    return {
      kind: "tuple",
      tupleElementTypeTexts: tupleBody.length === 0 ? [] : splitTopLevelTypeText(tupleBody, ",").map(tupleElementTypeText)
    };
  }

  const arraySuffix = splitArraySuffixTypeName(inner) as ArraySuffixTypeName | null;
  if (arraySuffix) {
    return {
      kind: "array",
      elementTypeText: arraySuffix.elementTypeName
    };
  }

  return null;
}

export function parseMappedTypeMemberText(typeName: string): MappedTypeMemberText | null {
  const trimmed = typeName.trim().replace(/;$/, "").trim();
  let rest = trimmed;
  let readonlyModifier: MappedTypeMemberText["readonlyModifier"];

  const readonlyMatch = /^([+-]?readonly)\s+/.exec(rest);
  if (readonlyMatch?.[1]) {
    readonlyModifier = readonlyMatch[1] as MappedTypeMemberText["readonlyModifier"];
    rest = rest.slice(readonlyMatch[0].length).trimStart();
  }

  if (!rest.startsWith("[")) {
    return null;
  }
  const closeBracketIndex = findMatchingTypeDelimiter(rest, 0, "[", "]");
  if (closeBracketIndex < 0) {
    return null;
  }

  const bracketBody = rest.slice(1, closeBracketIndex).trim();
  rest = rest.slice(closeBracketIndex + 1).trimStart();

  const optionalMatch = /^([+-]?\?)/.exec(rest);
  const optionalModifier = optionalMatch?.[1] as MappedTypeMemberText["optionalModifier"] | undefined;
  if (optionalMatch) {
    rest = rest.slice(optionalMatch[0].length).trimStart();
  }

  if (!rest.startsWith(":")) {
    return null;
  }
  const valueTypeText = rest.slice(1).trim();
  if (!valueTypeText) {
    return null;
  }

  const inIndex = findTopLevelTypeKeyword(bracketBody, "in");
  if (inIndex < 0) {
    return null;
  }
  const keyParameterName = bracketBody.slice(0, inIndex).trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(keyParameterName)) {
    return null;
  }

  const sourceAndRemap = bracketBody.slice(inIndex + "in".length).trim();
  const asIndex = findTopLevelTypeKeyword(sourceAndRemap, "as");
  const keySourceText = (asIndex >= 0 ? sourceAndRemap.slice(0, asIndex) : sourceAndRemap).trim();
  let keyRemapText: string | undefined;
  if (asIndex >= 0) {
    keyRemapText = sourceAndRemap.slice(asIndex + "as".length).trim();
  }
  if (!keySourceText) {
    return null;
  }

  return {
    keyParameterName,
    keySourceText,
    ...(readonlyModifier ? { readonlyModifier } : {}),
    ...(keyRemapText ? { keyRemapText } : {}),
    ...(optionalModifier ? { optionalModifier } : {}),
    valueTypeText
  };
}

function findTopLevelExtendsKeyword(text: string): number {
  return findTopLevelTypeKeyword(text, "extends");
}

function findTopLevelTypeKeyword(text: string, keyword: string): number {
  let foundIndex = -1;
  scanTypeText(text, (_character, index, isTopLevel) => {
    if (!isTopLevel) {
      return;
    }
    if (text.slice(index, index + keyword.length) !== keyword) {
      return;
    }
    const before = index === 0 ? " " : text.charAt(index - 1);
    const after = index + keyword.length >= text.length ? " " : text.charAt(index + keyword.length);
    if (/\w/.test(before) || /\w/.test(after)) {
      return;
    }
    foundIndex = index;
    return false;
  });
  return foundIndex;
}

export interface FunctionTypeAnnotationParameter {
  name: string;
  typeName: string;
  optional?: boolean;
  rest?: boolean;
}

export interface FunctionTypeAnnotationShape {
  parameters: FunctionTypeAnnotationParameter[];
  returnTypeName: string;
  typeParameters?: string[];
  typeParameterConstraints?: Record<string, string>;
  typeParameterDefaults?: Record<string, string>;
  constructor?: boolean;
}

function parseFunctionTypeParameterText(typeParameterText: string): FunctionTypeParameterText | null {
  const trimmed = typeParameterText.trim();
  if (!trimmed) {
    return null;
  }

  const defaultIndex = findTopLevelTypeCharacter(trimmed, "=");
  const beforeDefault = defaultIndex >= 0 ? trimmed.slice(0, defaultIndex).trim() : trimmed;
  const defaultTypeName = defaultIndex >= 0 ? trimmed.slice(defaultIndex + 1).trim() : "";
  let extendsIndex = findTopLevelExtendsKeyword(beforeDefault);
  if (extendsIndex < 0) {
    const compactExtendsIndex = beforeDefault.indexOf("extends");
    if (
      compactExtendsIndex > 0 &&
      /^[A-Za-z_$][\w$]*$/.test(beforeDefault.slice(0, compactExtendsIndex))
    ) {
      extendsIndex = compactExtendsIndex;
    }
  }
  const name = (extendsIndex >= 0 ? beforeDefault.slice(0, extendsIndex) : beforeDefault).trim();
  const constraintTypeName: string = extendsIndex >= 0
    ? beforeDefault.slice(extendsIndex + "extends".length).trim()
    : "";

  if (!name) {
    return null;
  }

  return {
    name,
    ...(constraintTypeName ? { constraintTypeName } : {}),
    ...(defaultTypeName ? { defaultTypeName } : {})
  };
}

export interface ObjectTypeAnnotationMember {
  name: string;
  typeName: string;
  optional?: boolean;
  readonly?: boolean;
}

/**
 * Parses a function type annotation text of the form `(param: Type, ...) => ReturnType`
 * into its structural parts. Returns null if the text does not look like a function type.
 */
export function parseFunctionTypeAnnotation(typeName: string): FunctionTypeAnnotationShape | null {
  const trimmed = typeName.trim();
  let working: string = trimmed;
  let constructor = false;

  if (working.startsWith("abstract ")) {
    working = working.slice("abstract ".length).trimStart();
  }
  if (working.startsWith("new")) {
    constructor = true;
    working = working.slice("new".length).trimStart();
  }

  const typeParameters: string[] = [];
  const typeParameterConstraints: Record<string, string> = {};
  const typeParameterDefaults: Record<string, string> = {};
  if (working.startsWith("<")) {
    const closeTypeParameterIndex = findMatchingTypeDelimiter(working, 0, "<", ">");
    if (closeTypeParameterIndex < 0) {
      return null;
    }
    const typeParameterBody = working.slice(1, closeTypeParameterIndex).trim();
    for (const part of splitTypeArgumentText(typeParameterBody)) {
      const parsedTypeParameter: FunctionTypeParameterText | null = parseFunctionTypeParameterText(part);
      if (!parsedTypeParameter) {
        continue;
      }
      typeParameters.push(parsedTypeParameter.name);
      if (parsedTypeParameter.constraintTypeName) {
        typeParameterConstraints[parsedTypeParameter.name] = parsedTypeParameter.constraintTypeName;
      }
      if (parsedTypeParameter.defaultTypeName) {
        typeParameterDefaults[parsedTypeParameter.name] = parsedTypeParameter.defaultTypeName;
      }
    }
    working = working.slice(closeTypeParameterIndex + 1).trimStart();
  }

  if (!working.startsWith("(")) {
    return null;
  }

  const closeParenIndex = findMatchingTypeDelimiter(working, 0, "(", ")");
  if (closeParenIndex < 0) {
    return null;
  }
  const afterParameters = working.slice(closeParenIndex + 1).trimStart();
  if (!afterParameters.startsWith("=>")) {
    return null;
  }

  const parameterBody = working.slice(1, closeParenIndex).trim();
  const parameters: FunctionTypeAnnotationParameter[] = [];
  if (parameterBody.length > 0) {
    const parameterParts = splitTopLevelDelimitedTypeText(parameterBody);
    for (let index = 0; index < parameterParts.length; index += 1) {
          const part = parameterParts[index]!;
          let text = part.trim();
          let rest = false;
          if (text.startsWith("...")) {
            rest = true;
            text = text.slice(3).trim();
          }

          const colonIndex = findTopLevelTypeCharacter(text, ":");
          if (colonIndex < 0) {
            parameters.push({
              name: `arg${index + 1}`,
              typeName: text.length > 0 ? text : "unknown",
              ...(rest ? { rest: true as const } : {})
            });
            continue;
          }

          let name = text.slice(0, colonIndex).trim();
          const paramTypeName = text.slice(colonIndex + 1).trim();
          let optional = false;
          if (name.endsWith("?")) {
            optional = true;
            name = name.slice(0, -1).trim();
          }
          parameters.push({
            name: name.length > 0 ? name : `arg${index + 1}`,
            typeName: paramTypeName.length > 0 ? paramTypeName : "unknown",
            ...(optional ? { optional: true as const } : {}),
            ...(rest ? { rest: true as const } : {})
          });
    }
  }

  return {
    parameters,
    returnTypeName: afterParameters.slice(2).trim(),
    ...(typeParameters.length > 0 ? { typeParameters } : {}),
    ...(Object.keys(typeParameterConstraints).length > 0 ? { typeParameterConstraints } : {}),
    ...(Object.keys(typeParameterDefaults).length > 0 ? { typeParameterDefaults } : {}),
    ...(constructor ? { constructor: true } : {})
  };
}

/**
 * Parses an object type annotation text of the form `{ name: Type; ... }` into
 * a list of member descriptors. Returns null if the text does not look like an
 * object type literal.
 */
export function parseObjectTypeAnnotation(typeName: string): ObjectTypeAnnotationMember[] | null {
  const trimmed = typeName.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }

  const members: ObjectTypeAnnotationMember[] = [];
  for (const part of splitTopLevelDelimitedTypeText(body, new Set([",", ";"]))) {
    members.push(parseObjectTypeAnnotationMember(part));
  }
  return members;
}

function parseObjectTypeAnnotationMember(part: string): ObjectTypeAnnotationMember {
  const trimmedPart = part.trim();
  const colonIndex = findTopLevelTypeCharacter(trimmedPart, ":");
    if (trimmedPart.startsWith("new(")) {
      const closeParenIndex = findMatchingTypeDelimiter(trimmedPart, 3, "(", ")");
      if (closeParenIndex >= 0) {
        const returnTypeSeparator = trimmedPart.slice(closeParenIndex + 1).trimStart();
        if (returnTypeSeparator.startsWith(":")) {
          const parameterText = trimmedPart.slice(3, closeParenIndex + 1);
          const returnTypeName = returnTypeSeparator.slice(1).trim();
          return {
            name: "constructor",
            typeName: `${parameterText} => ${returnTypeName}`
          };
        }
      }
    }

    const signatureParenIndex = trimmedPart.indexOf("(");
    if (signatureParenIndex > 0 && (colonIndex < 0 || signatureParenIndex < colonIndex)) {
      const closeParenIndex = findMatchingTypeDelimiter(trimmedPart, signatureParenIndex, "(", ")");
      if (closeParenIndex >= 0) {
        const returnTypeSeparator = trimmedPart.slice(closeParenIndex + 1).trimStart();
        if (returnTypeSeparator.startsWith(":")) {
          let name = trimmedPart.slice(0, signatureParenIndex).trim();
          let optional = false;
          if (name.endsWith("?")) {
            optional = true;
            name = name.slice(0, -1).trim();
          }
          if (name.startsWith("readonly ")) {
            name = name.slice("readonly ".length).trim();
          }
          const parameterText = trimmedPart.slice(signatureParenIndex, closeParenIndex + 1);
          const returnTypeName = returnTypeSeparator.slice(1).trim();
          return {
            name,
            typeName: `${parameterText} => ${returnTypeName}`,
            ...(trimmedPart.slice(0, signatureParenIndex).trim().startsWith("readonly ") ? { readonly: true as const } : {}),
            ...(optional ? { optional: true as const } : {})
          };
        }
      }
    }
    if (colonIndex < 0) {
      return { name: part.trim(), typeName: "unknown" };
    }
    let name = part.slice(0, colonIndex).trim();
    const memberTypeName = part.slice(colonIndex + 1).trim();
    let optional = false;
    let readonly = false;
    if (name.endsWith("?")) {
      optional = true;
      name = name.slice(0, -1).trim();
    }
    if (name.startsWith("readonly ")) {
      readonly = true;
      name = name.slice("readonly ".length).trim();
    }
    if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1);
    }
    return {
      name,
      typeName: memberTypeName.length > 0 ? memberTypeName : "unknown",
      ...(readonly ? { readonly: true as const } : {}),
      ...(optional ? { optional: true as const } : {})
    };
}

/** Returns true if the type text contains `=>`, suggesting a function type annotation. */
export function looksLikeFunctionTypeAnnotation(typeName: string): boolean {
  return typeName.includes("=>");
}

/**
 * Strips trailing `[]` suffixes from a type name text, returning the inner
 * element type name and the array nesting depth. Returns null when the text
 * does not end with `[]`.
 */
export function splitArraySuffixTypeName(typeName: string): ArraySuffixTypeName | null {
  let remaining = typeName.trim();
  let arrayDepth = 0;
  while (remaining.endsWith("[]")) {
    remaining = remaining.slice(0, -2).trim();
    arrayDepth += 1;
  }
  if (arrayDepth === 0 || remaining.length === 0) {
    return null;
  }
  return { elementTypeName: remaining, arrayDepth };
}

/**
 * Parses a `T[K]` indexed-access type name, returning the object and index
 * type name texts. Ignores inner brackets at deeper nesting. Returns null when
 * the text does not look like an indexed-access type.
 */
export function splitIndexedAccessTypeName(typeName: string): { objectTypeName: string; indexTypeName: string } | null {
  const trimmed = typeName.trim();
  if (!trimmed.endsWith("]")) {
    return null;
  }

  let quote: string | null = null;
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const ch = trimmed.charAt(index);
    const previous = index > 0 ? trimmed.charAt(index - 1) : "";
    if (quote) {
      if (ch === quote && previous !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") angleDepth += 1;
    else if (ch === "<") angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === ")") parenDepth += 1;
    else if (ch === "(") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "}") braceDepth += 1;
    else if (ch === "{") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "]") bracketDepth += 1;
    else if (ch === "[") {
      bracketDepth -= 1;
      if (bracketDepth === 0 && angleDepth === 0 && parenDepth === 0 && braceDepth === 0) {
        const objectTypeName = trimmed.slice(0, index).trim();
        const indexTypeName = trimmed.slice(index + 1, -1).trim();
        if (objectTypeName.length === 0 || indexTypeName.length === 0) {
          return null;
        }
        return { objectTypeName, indexTypeName };
      }
    }
  }
  return null;
}
