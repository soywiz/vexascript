import type { MemberAccessTarget } from "./completionModel";

export function parseMemberAccessTarget(
  text: string | undefined,
  line: number,
  character: number
): MemberAccessTarget | null {
  if (!text) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (!lineText) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);
  const match = /((?:[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)(?:(?:\s*\?\.\s*|\s*!\.\s*|\s*\.\s*)[A-Za-z_][A-Za-z0-9_]*)*)(\?\.|!\.|\.)(?:\s*([A-Za-z_][A-Za-z0-9_]*))?$/.exec(uptoCursor);
  if (!match || !match[1]) {
    return null;
  }
  const objectPath = match[1];
  const typedPrefix = match[3] ?? "";
  const objectStartCharacter = match.index;
  const operator = match[2] ?? ".";
  const memberAccessStartCharacter = match.index + objectPath.length + operator.length - 1;
  return {
    objectPath: objectPath.replace(/\?\./g, ".").replace(/!\./g, ".").replace(/\s+/g, ""),
    objectStartCharacter,
    memberAccessStartCharacter,
    prefix: typedPrefix
  };
}

/**
 * Lenient member-access detection that, unlike {@link parseMemberAccessTarget},
 * does not require the receiver to be a plain identifier-dot chain. It only
 * locates the member-access dot and the partially typed member name, so the
 * receiver type can be resolved from the analyzed expression types instead of
 * from textual symbol lookups. This is what enables member completion after
 * complex receivers such as calls (e.g. `fetch(...).arrayBuffer`).
 */
export function findMemberAccessDot(
  text: string | undefined,
  line: number,
  character: number
): { dotCharacter: number; receiverEndCharacter: number | null; prefix: string } | null {
  if (!text) {
    return null;
  }
  const lines = text.split("\n");
  const lineText = lines[line];
  if (lineText === undefined) {
    return null;
  }
  const clampedCharacter = Math.max(0, Math.min(character, lineText.length));
  const uptoCursor = lineText.slice(0, clampedCharacter);
  const match = /(\?\.|!\.|\.\.|\.)(?:\s*([A-Za-z_][A-Za-z0-9_]*))?$/.exec(uptoCursor);
  if (!match) {
    return null;
  }
  const operator = match[1] ?? ".";
  const dotCharacter = match.index + operator.length - 1;
  // The receiver must end with a value-producing token so that we are looking at
  // a member access rather than, for example, a decimal point in a number.
  // A trailing-lambda call receiver ends at its closing brace (`xs.map { it }.`),
  // so `}` must be accepted here too.
  const beforeDot = uptoCursor.slice(0, match.index).replace(/\s+$/, "");
  if (beforeDot.length === 0) {
    if (!/^\s*$/.test(uptoCursor.slice(0, match.index))) {
      return null;
    }
    return { dotCharacter, receiverEndCharacter: null, prefix: match[2] ?? "" };
  }
  const lastChar = beforeDot[beforeDot.length - 1];
  if (!lastChar || !/[A-Za-z0-9_)\]"'`}!]/.test(lastChar)) {
    return null;
  }
  return { dotCharacter, receiverEndCharacter: beforeDot.length, prefix: match[2] ?? "" };
}
