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
  let depth = 0;
  let current = "";
  for (const ch of argumentBody) {
    if (ch === "<") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ">") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
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
