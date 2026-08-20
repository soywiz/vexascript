import { describe, expect, it, readFile, resolve } from "../compiler/test/expect";
import { ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { sourceWithCursor } from "../compiler/test/sourceWithCursor";
import { openEntrypointInLspSession } from "./lspOpenSession";
import type { CompletionItem } from "vscode-languageserver/node.js";

const sampleRoot = resolve(process.cwd(), "samples/d3");
const entrypoint = resolve(sampleRoot, "html.vx");

async function completionItemsFor(sourceWithMarker: string): Promise<CompletionItem[]> {
  const { source, line, character } = sourceWithCursor(sourceWithMarker);
  const result = await openEntrypointInLspSession(
    entrypoint,
    sampleRoot,
    [],
    [{ line, character }],
    source
  );
  return result.completions[0] ?? [];
}

describe("d3 sample completion", async () => {
  const project = await resolveProjectForSource(entrypoint);
  await ensureRuntimeDependencies(entrypoint, project);
  const source = await readFile(entrypoint, "utf8");

  it("offers DOM globals while typing an identifier", async () => {
    const items = await completionItemsFor(`${source}\ndocu^^^`);
    const document = items.find((item) => item.label === "document");
    const fuzzyRuntimeMatch = items.find((item) => item.label === "decodeURI");

    expect(document).toBeDefined();
    expect(fuzzyRuntimeMatch).toBeDefined();
    expect(document!.sortText! < fuzzyRuntimeMatch!.sortText!).toBe(true);
  });

  it("offers D3 selection members on a continued chain", async () => {
    const items = await completionItemsFor(source.replace(
      '  .attr("rx", 5)',
      '  .attr("rx", 5)\n  .attr^^^'
    ));

    expect(items.map((item) => item.label)).toContain("attr");
  });
});
