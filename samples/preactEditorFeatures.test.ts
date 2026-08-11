import { describe, expect, it, readFile, resolve } from "../compiler/test/expect";
import { ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { openEntrypointInLspSession, type LspPositionProbe } from "./lspOpenSession";

function positionInside(source: string, text: string): LspPositionProbe {
  const offset = source.indexOf(text);
  if (offset < 0) {
    throw new Error(`Expected sample source to contain '${text}'`);
  }
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return {
    line: lines.length - 1,
    character: (lines.at(-1)?.length ?? 0) + Math.floor(text.length / 2)
  };
}

describe("preact JSX editor features", () => {
  it("keeps intrinsic and contextual event navigation aligned in the real LSP session", async () => {
    const sourcePath = resolve(process.cwd(), "samples/preact/html.vx");
    const source = await readFile(sourcePath, "utf8");
    const project = await resolveProjectForSource(sourcePath);
    await ensureRuntimeDependencies(sourcePath, project);

    const result = await openEntrypointInLspSession(sourcePath, process.cwd(), [
      positionInside(source, "button"),
      positionInside(source, "onClick"),
      positionInside(source, "currentTarget"),
      positionInside(source, "display: \"flex\"")
    ], [
      positionInside(source, "\"flex\""),
      positionInside(source, "display: \"flex\"")
    ]);
    const hoverValues = result.hovers.map((hover) =>
      (hover?.contents as { value?: string } | undefined)?.value ?? ""
    );

    expect(hoverValues[0]).toContain("HTMLButtonElement");
    expect(hoverValues[1]).toContain("HTMLButtonElement");
    expect(hoverValues[2]).toContain("HTMLButtonElement");
    expect(hoverValues[3]).toContain("display: string | number");
    expect(result.definitions[0]).not.toBeNull();
    expect(result.definitions[1]).not.toBeNull();
    expect(result.definitions[2]).not.toBeNull();
    expect((result.definitions[3] as { uri?: string } | null)?.uri).toContain("compiler/runtime/dom.d.ts");
    expect(result.completions[0]).toEqual([]);
    const displayProperty = result.completions[1]?.find((item) => item.label === "display");
    expect(displayProperty?.detail).toBe("Object property: string | number | null | undefined");
  });
});
