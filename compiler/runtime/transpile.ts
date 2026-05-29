export interface TranspileResult {
  code: string;
  warnings: string[];
}

function ensureTrailingSemicolon(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return /[;{}]$/.test(trimmed) ? trimmed : `${trimmed};`;
}

export function transpile(source: string): TranspileResult {
  return {
    code: ensureTrailingSemicolon(source),
    warnings: []
  };
}
