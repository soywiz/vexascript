/**
 * Pure helpers for normalizing and matching property names, and for looking
 * up property types within object/map shapes. Index-signature names like
 * `[K: string]` are normalized to a canonical `[type]` form so they can be
 * compared regardless of spacing or the bound variable name.
 */
import type { AnalysisType } from "./types";
import { unionType } from "./types";

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

export function propertyEntries(
  properties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>
): Array<[string, AnalysisType]> {
  return properties instanceof Map
    ? Array.from(properties.entries())
    : Object.entries(properties);
}

export function propertyTypeFrom(
  properties: Record<string, AnalysisType> | ReadonlyMap<string, AnalysisType>,
  propertyName: string
): AnalysisType | undefined {
  const normalizedPropertyName = normalizePropertyName(propertyName);
  if (typeof (properties as ReadonlyMap<string, AnalysisType>).get === "function") {
    const propertyMap = properties as ReadonlyMap<string, AnalysisType>;
    const direct = propertyMap.get(propertyName);
    if (direct !== undefined) {
      return direct;
    }
    const normalized = propertyMap.get(normalizedPropertyName);
    if (normalized !== undefined) {
      return normalized;
    }
    for (const [candidateName, candidateType] of propertyMap.entries()) {
      if (normalizePropertyName(candidateName) === normalizedPropertyName) {
        return candidateType;
      }
    }
    return undefined;
  }
  const propertyRecord = properties as Record<string, AnalysisType>;
  const direct = propertyRecord[propertyName];
  if (direct !== undefined) {
    return direct;
  }
  const normalized = propertyRecord[normalizedPropertyName];
  if (normalized !== undefined) {
    return normalized;
  }
  for (const [candidateName, candidateType] of Object.entries(propertyRecord)) {
    if (normalizePropertyName(candidateName) === normalizedPropertyName) {
      return candidateType;
    }
  }
  return undefined;
}

export function propertyTypeAllowsUndefined(type: AnalysisType): boolean {
  if (type.kind === "builtin") {
    return type.name === "undefined" || type.name === "any" || type.name === "unknown";
  }
  if (type.kind === "union") {
    return type.types.some((member) => propertyTypeAllowsUndefined(member));
  }
  return false;
}

export function propertyTypeWithoutUndefined(type: AnalysisType): AnalysisType | null {
  if (type.kind !== "union") {
    return null;
  }
  const definedMembers = type.types.filter(
    (member) => !(member.kind === "builtin" && member.name === "undefined")
  );
  if (definedMembers.length === 0 || definedMembers.length === type.types.length) {
    return null;
  }
  return definedMembers.length === 1 ? definedMembers[0]! : unionType(definedMembers);
}
