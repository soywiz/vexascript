/**
 * Pure helpers for normalizing and matching property names used in type
 * assignability checks. Index-signature names like `[K: string]` are
 * normalized to a canonical `[type]` form so they can be compared
 * regardless of spacing or the bound variable name.
 */

export function normalizeIndexSignaturePropertyName(name: string): string | null {
  const match = /^(?:readonly\s+)?\[\s*[^:]+\s*:\s*(.+)\]$/.exec(name);
  if (!match) {
    return null;
  }
  const indexType = match[1]?.trim().replace(/\s+/g, " ");
  if (!indexType) {
    return null;
  }
  return `[${indexType}]`;
}

export function normalizePropertyName(name: string): string {
  const trimmed = name.trim();
  const normalizedIndexSignature = normalizeIndexSignaturePropertyName(trimmed);
  if (normalizedIndexSignature) {
    return normalizedIndexSignature;
  }
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function isDynamicPropertyName(propertyName: string): boolean {
  const trimmed = propertyName.trim();
  return trimmed.startsWith("[") || trimmed.startsWith("readonly [");
}

export function propertyNamesMatch(expectedPropertyName: string, actualPropertyName: string): boolean {
  return normalizePropertyName(expectedPropertyName) === normalizePropertyName(actualPropertyName);
}
