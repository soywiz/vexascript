export interface TypeNameShape {
  baseName: string;
  typeArguments: string[];
  arrayDepth: number;
}

export interface OptionalTypeNameSuffix {
  typeName: string;
  optional: boolean;
}

interface TypeTextDepths {
  angle: number;
  paren: number;
  bracket: number;
  brace: number;
}

function scanTypeText(
  text: string,
  visit: (character: string, index: number, isTopLevel: boolean) => boolean | void
): void {
  const depths: TypeTextDepths = { angle: 0, paren: 0, bracket: 0, brace: 0 };
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const previous = index > 0 ? text[index - 1] : "";

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
    const character = text[index]!;
    const previous = index > 0 ? text[index - 1] : "";
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
  let remaining = typeName.trim();
  let arrayDepth = 0;
  while (remaining.endsWith("[]")) {
    arrayDepth += 1;
    remaining = remaining.slice(0, -2).trim();
  }

  const genericStart = remaining.indexOf("<");
  if (genericStart < 0 || !remaining.endsWith(">")) {
    return { baseName: remaining, typeArguments: [], arrayDepth };
  }

  const baseName = remaining.slice(0, genericStart).trim();
  const argumentBody = remaining.slice(genericStart + 1, -1).trim();
  return {
    baseName,
    typeArguments: splitTypeArgumentText(argumentBody),
    arrayDepth
  };
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

export function substituteTypeNameText(typeName: string, substitutions: Map<string, string>): string {
  const parsed = parseTypeNameShape(typeName);
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
  return substituted;
}

export function splitTopLevelTypeText(typeName: string, separator: "|" | "&" | ","): string[] {
  return splitTopLevelDelimitedTypeText(typeName, new Set([separator]));
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

export interface FunctionTypeAnnotationParameter {
  name: string;
  typeName: string;
  optional?: boolean;
  rest?: boolean;
}

export interface FunctionTypeAnnotationShape {
  parameters: FunctionTypeAnnotationParameter[];
  returnTypeName: string;
}

export interface ObjectTypeAnnotationMember {
  name: string;
  typeName: string;
  optional?: boolean;
}

/**
 * Parses a function type annotation text of the form `(param: Type, ...) => ReturnType`
 * into its structural parts. Returns null if the text does not look like a function type.
 */
export function parseFunctionTypeAnnotation(typeName: string): FunctionTypeAnnotationShape | null {
  const trimmed = typeName.trim();
  if (!trimmed.startsWith("(")) {
    return null;
  }

  const closeParenIndex = findMatchingTypeDelimiter(trimmed, 0, "(", ")");
  if (closeParenIndex < 0) {
    return null;
  }
  const afterParameters = trimmed.slice(closeParenIndex + 1).trimStart();
  if (!afterParameters.startsWith("=>")) {
    return null;
  }

  const parameterBody = trimmed.slice(1, closeParenIndex).trim();
  const parameters =
    parameterBody.length === 0
      ? []
      : splitTopLevelDelimitedTypeText(parameterBody).map((part, index) => {
          let text = part.trim();
          let rest = false;
          if (text.startsWith("...")) {
            rest = true;
            text = text.slice(3).trim();
          }

          const colonIndex = findTopLevelTypeCharacter(text, ":");
          if (colonIndex < 0) {
            return {
              name: `arg${index + 1}`,
              typeName: text.length > 0 ? text : "unknown",
              ...(rest ? { rest: true as const } : {})
            };
          }

          let name = text.slice(0, colonIndex).trim();
          const paramTypeName = text.slice(colonIndex + 1).trim();
          let optional = false;
          if (name.endsWith("?")) {
            optional = true;
            name = name.slice(0, -1).trim();
          }
          return {
            name: name.length > 0 ? name : `arg${index + 1}`,
            typeName: paramTypeName.length > 0 ? paramTypeName : "unknown",
            ...(optional ? { optional: true as const } : {}),
            ...(rest ? { rest: true as const } : {})
          };
        });

  return {
    parameters,
    returnTypeName: afterParameters.slice(2).trim()
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

  return splitTopLevelDelimitedTypeText(body, new Set([",", ";"])).map((part) => {
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
    if (name.endsWith("?")) {
      optional = true;
      name = name.slice(0, -1).trim();
    }
    if (name.startsWith("readonly ")) {
      name = name.slice("readonly ".length).trim();
    }
    if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1);
    }
    return {
      name,
      typeName: memberTypeName.length > 0 ? memberTypeName : "unknown",
      ...(optional ? { optional: true as const } : {})
    };
  });
}

/** Returns true if the type text contains `=>`, suggesting a function type annotation. */
export function looksLikeFunctionTypeAnnotation(typeName: string): boolean {
  return typeName.includes("=>");
}
