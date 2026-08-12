import { describe, expect, it, readFile, resolve } from "../compiler/test/expect";
import { ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { openEntrypointInLspSession, type LspPositionProbe } from "./lspOpenSession";

function positionInside(source: string, text: string): LspPositionProbe {
  const offset = source.indexOf(text);
  if (offset < 0) throw new Error(`Expected sample source to contain '${text}'`);
  const before = source.slice(0, offset + Math.max(1, Math.floor(text.length / 2)));
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function positionAfter(source: string, text: string): LspPositionProbe {
  const offset = source.indexOf(text);
  if (offset < 0) throw new Error(`Expected sample source to contain '${text}'`);
  const before = source.slice(0, offset + text.length);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function hoverText(value: unknown): string {
  return ((value as { contents?: { value?: string } } | null)?.contents?.value ?? "");
}

describe("Vite Preact editor features", () => {
  it("resolves Preact, hooks, DOM events and local VexaScript modules", async () => {
    const sourcePath = resolve(process.cwd(), "samples/vite/src/main.vx");
    const source = await readFile(sourcePath, "utf8");
    const project = await resolveProjectForSource(sourcePath);
    await ensureRuntimeDependencies(sourcePath, project);

    const result = await openEntrypointInLspSession(
      sourcePath,
      process.cwd(),
      ["render", "useState", "greeting", "currentTarget"].map((text) => positionInside(source, text)),
      [positionAfter(source, "event.currentTarget.")]
    );

    expect(result.documentDiagnostics).toEqual([]);
    expect(result.workspaceDiagnostics).toEqual([]);
    expect(result.definitions.every((definition) => definition !== null)).toBe(true);
    expect(result.hovers.map(hoverText)[0]).toContain("render");
    expect(result.hovers.map(hoverText)[1]).toContain("useState");
    expect(result.hovers.map(hoverText)[2]).toContain("greeting");
    expect(result.hovers.map(hoverText)[3]).toContain("HTMLButtonElement");
    expect(result.completions[0]?.some((item) => item.label === "blur")).toBe(true);
  });
});
