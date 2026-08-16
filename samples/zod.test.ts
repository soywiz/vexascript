import { describe, expect, it, resolve } from "../compiler/test/expect";
import { ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { vfs } from "../compiler/vfs";
import { openEntrypointInLspSession, type LspPositionProbe } from "./lspOpenSession";

function positionAfter(source: string, text: string, offsetAdjustment = 0): LspPositionProbe {
  const offset = source.lastIndexOf(text);
  if (offset < 0) {
    throw new Error(`Missing probe text: ${text}`);
  }
  const before = source.slice(0, offset + text.length + offsetAdjustment);
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
    const aliasExpectations = [
      ["User", "name", "User"],
      ["PublicUser", "role", "PublicUser"],
      ["UserPatch", "id", "UserPatch"],
      ["Coordinates", "number", "Coordinates"],
      ["Setting", "boolean", "Setting"],
      ["UserEvent", "created", "Event"],
      ["Permissions", "boolean", "Permissions"],
      ["StringNumberMap", "Map", "StringNumberMap"],
      ["StringSet", "Set", "StringSet"],
      ["Audited", "updatedAt", "Audited"]
    ] as const;
    const schemaProbe = positionAfter(source, "RoleSchema,");
    const roleProbe = positionAfter(source, "role: Role");
    const aliasProbes = aliasExpectations.map(([name]) =>
      positionAfter(source, `export type ${name} =`, -2)
    );
    const schemaProbes = aliasExpectations.map(([, , schemaName]) =>
      positionAfter(source, `typeof ${schemaName}Schema`)
    );
    const completionProbe = positionAfter(source, "role.");
    const result = await openEntrypointInLspSession(
      sourcePath,
      process.cwd(),
      [schemaProbe, roleProbe, ...aliasProbes, ...schemaProbes],
      [completionProbe],
      source,
      true,
      true
    );

    const schemaHoverText = JSON.stringify(result.hovers[0]?.contents ?? "");
    const hoverText = JSON.stringify(result.hovers[1]?.contents ?? "");
    const userTypeHover = result.hovers[2]?.contents as { kind?: string; value?: string } | undefined;
    const completionLabels = result.completions[0]?.map((item) => item.label) ?? [];
    expect(schemaHoverText).toContain("ZodEnum");
    expect(hoverText).toContain("admin");
    expect(hoverText).toContain("editor");
    expect(hoverText).toContain("user");
    expect(schemaHoverText).not.toContain("unknown");
    expect(completionLabels).toContain("toUpperCase");
    expect(completionLabels).not.toContain("console");
    expect(hoverText).not.toContain("unknown");
    expect(hoverText).not.toContain("object & unknown");
    expect(userTypeHover?.kind).toBe("markdown");
    expect(userTypeHover?.value).toContain("```typescript\ntype User = {\n");
    expect(userTypeHover?.value).toContain("  id: string;\n");
    expect(userTypeHover?.value).toContain("  contact: {\n");
    expect(userTypeHover?.value).toContain("    phone?: string;\n");
    expect(userTypeHover?.value).not.toContain("    phone: string | undefined;\n");
    const aliasHoverTexts = aliasExpectations.map((_, index) =>
      JSON.stringify(result.hovers[index + 2]?.contents ?? "")
    );
    aliasExpectations.forEach(([, expectedText], index) => {
      const aliasHoverText = aliasHoverTexts[index]!;
      expect(aliasHoverText).toContain(expectedText);
      expect(aliasHoverText).not.toContain("unknown");
      expect(aliasHoverText).not.toContain("object & unknown");
    });
    expect(Math.max(...result.hoverDurationsMs)).toBeLessThan(4_000);
    expect(result.completionDurationsMs[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(4_000);
    expect(Math.max(...result.warmHoverDurationsMs)).toBeLessThan(500);
    expect(result.warmCompletionDurationsMs[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(500);

    const parsingSourcePath = resolve(process.cwd(), "samples/zod/parsing.vx");
    const parsingSource = await vfs().readFile(parsingSourcePath);
    const importedAliasResult = await openEntrypointInLspSession(
      parsingSourcePath,
      process.cwd(),
      [positionAfter(parsingSource, "event: UserEvent", -2)],
      [],
      parsingSource,
      true,
      true
    );
    const importedAliasHover = importedAliasResult.hovers[0]?.contents as { kind?: string; value?: string } | undefined;
    expect(importedAliasHover?.kind).toBe("markdown");
    expect(importedAliasHover?.value).toContain("```typescript\ntype UserEvent = {\n");
    expect(importedAliasHover?.value).toContain('  kind: "created";\n');
    expect(importedAliasHover?.value).toContain("} | {\n");
  });
});
