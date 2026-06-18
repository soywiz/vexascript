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
