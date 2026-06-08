export interface CodeLensPosition {
  line: number;
  character: number;
}

export interface CodeLensRange {
  start: CodeLensPosition;
  end: CodeLensPosition;
}

export interface CodeLensReferenceLocation {
  uri: string;
  range: CodeLensRange;
}

export interface CodeLensCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface ShowReferencesPayload {
  uri: string;
  position: CodeLensPosition;
  locations: CodeLensReferenceLocation[];
}

function isPosition(value: unknown): value is CodeLensPosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodeLensPosition>;
  return typeof candidate.line === "number" && typeof candidate.character === "number";
}

function isRange(value: unknown): value is CodeLensRange {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodeLensRange>;
  return isPosition(candidate.start) && isPosition(candidate.end);
}

function isReferenceLocation(value: unknown): value is CodeLensReferenceLocation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodeLensReferenceLocation>;
  return typeof candidate.uri === "string" && isRange(candidate.range);
}

export function extractShowReferencesPayload(command?: CodeLensCommand): ShowReferencesPayload | null {
  if (!command || command.command !== "mylang.showReferences") return null;
  const args = command.arguments;
  if (!Array.isArray(args) || args.length !== 3) return null;
  const [uri, position, locations] = args;
  if (typeof uri !== "string" || !isPosition(position) || !Array.isArray(locations)) return null;
  if (!locations.every(isReferenceLocation)) return null;
  return { uri, position, locations };
}
