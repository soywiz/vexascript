export interface TypeNameShape {
  baseName: string;
  typeArguments: string[];
  arrayDepth: number;
}

export function splitTypeArgumentText(argumentBody: string): string[] {
  if (argumentBody.length === 0) {
    return [];
  }

  const args: string[] = [];
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: string | null = null;
  let current = "";
  for (let index = 0; index < argumentBody.length; index += 1) {
    const ch = argumentBody[index]!;
    const previous = index > 0 ? argumentBody[index - 1] : "";

    if (quote) {
      current += ch;
      if (ch === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "<") {
      angleDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      current += ch;
      continue;
    }
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);

    if (ch === "," && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (current.trim().length > 0) {
        args.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    args.push(current.trim());
  }
  return args;
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
  const parts: string[] = [];
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  let current = "";

  for (let index = 0; index < typeName.length; index += 1) {
    const ch = typeName[index]!;
    const previous = index > 0 ? typeName[index - 1] : "";

    if (quote) {
      current += ch;
      if (ch === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "<") angleDepth += 1;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);

    if (ch === separator && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      if (current.trim().length > 0) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }

  return parts;
}

export function stripEnclosingTypeParens(typeName: string): string {
  const trimmed = typeName.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return trimmed;
  }

  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const ch = trimmed[index]!;
    const previous = index > 0 ? trimmed[index - 1] : "";
    if (quote) {
      if (ch === quote && previous !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && index < trimmed.length - 1) {
      return trimmed;
    }
  }

  return stripEnclosingTypeParens(trimmed.slice(1, -1));
}
