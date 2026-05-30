export interface TranspileResult {
  code: string;
  warnings: string[];
}

function countOccurrences(text: string, ch: string): number {
  let count = 0;
  for (const current of text) {
    if (current === ch) {
      count += 1;
    }
  }
  return count;
}

function stripDeclareStatements(source: string): string {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed.startsWith("declare ")) {
      kept.push(line);
      continue;
    }

    if (trimmed.startsWith("declare class ")) {
      let braceDepth = countOccurrences(line, "{") - countOccurrences(line, "}");
      while (braceDepth > 0 && i + 1 < lines.length) {
        i += 1;
        const nextLine = lines[i] ?? "";
        braceDepth += countOccurrences(nextLine, "{") - countOccurrences(nextLine, "}");
      }
      continue;
    }
  }

  return kept.join("\n");
}

function ensureTrailingSemicolon(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return /[;{}]$/.test(trimmed) ? trimmed : `${trimmed};`;
}

export function transpile(source: string): TranspileResult {
  const withoutDeclarations = stripDeclareStatements(source);
  return {
    code: ensureTrailingSemicolon(withoutDeclarations),
    warnings: []
  };
}
