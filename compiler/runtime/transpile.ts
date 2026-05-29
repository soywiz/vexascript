export interface TranspileResult {
  code: string;
  warnings: string[];
}

/**
 * Base transpiler for a TypeScript-like language.
 * For now, it performs only a minimal placeholder transformation.
 */
export function transpile(source: string): TranspileResult {
  const warnings: string[] = [];

  if (source.includes("any")) {
    warnings.push("Avoid 'any' in MyLang when possible.");
  }

  const code = source
    .replace(/\blet\b/g, "let")
    .replace(/\bconst\b/g, "const")
    .trim();

  return { code, warnings };
}
