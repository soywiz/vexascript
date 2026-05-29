export interface TranspileResult {
  code: string;
  warnings: string[];
}

/**
 * Transpilador base para un lenguaje parecido a TypeScript.
 * Ahora mismo hace una transformación mínima como placeholder.
 */
export function transpile(source: string): TranspileResult {
  const warnings: string[] = [];

  if (source.includes("any")) {
    warnings.push("Evita 'any' en MyLang cuando sea posible.");
  }

  const code = source
    .replace(/\blet\b/g, "let")
    .replace(/\bconst\b/g, "const")
    .trim();

  return { code, warnings };
}
