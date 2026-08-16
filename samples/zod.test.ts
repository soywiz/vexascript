import { describe, expect, it, resolve } from "../compiler/test/expect";
import { ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { vfs } from "../compiler/vfs";
import { openEntrypointInLspSession, type LspPositionProbe } from "./lspOpenSession";

function positionAfter(source: string, text: string): LspPositionProbe {
  const offset = source.lastIndexOf(text);
  if (offset < 0) {
    throw new Error(`Missing probe text: ${text}`);
  }
  const before = source.slice(0, offset + text.length);
  const lines = before.split("\n");
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0
  };
}

describe("zod sample editor features", () => {
  it("preserves inferred alias types and completes their members promptly", async () => {
    const sourcePath = resolve(process.cwd(), "samples/zod/models.vx");
    const project = await resolveProjectForSource(sourcePath);
    await ensureRuntimeDependencies(sourcePath, project);

    const source = `${await vfs().readFile(sourcePath)}\nval role: Role = "admin"\nrole.`;
    const schemaProbe = positionAfter(source, "RoleSchema,");
    const roleProbe = positionAfter(source, "role: Role");
    const completionProbe = positionAfter(source, "role.");
    const result = await openEntrypointInLspSession(
      sourcePath,
      process.cwd(),
      [schemaProbe, roleProbe],
      [completionProbe],
      source,
      true
    );

    const schemaHoverText = JSON.stringify(result.hovers[0]?.contents ?? "");
    const hoverText = JSON.stringify(result.hovers[1]?.contents ?? "");
    const completionLabels = result.completions[0]?.map((item) => item.label) ?? [];
    expect(schemaHoverText).toContain("ZodEnum");
    expect(hoverText).toContain("string");
    expect(schemaHoverText).not.toContain("unknown");
    expect(completionLabels).toContain("toUpperCase");
    expect(completionLabels).not.toContain("console");
    expect(hoverText).not.toContain("unknown");
    expect(hoverText).not.toContain("object & unknown");
    expect(result.completionDurationsMs[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(1_000);
  });
});
