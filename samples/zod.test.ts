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
  it("preserves inferred alias types with bounded reusable analysis work", async () => {
    const sourcePath = resolve(process.cwd(), "samples/zod/models.vx");
    const project = await resolveProjectForSource(sourcePath);
    await ensureRuntimeDependencies(sourcePath, project);

    const source = `${await vfs().readFile(sourcePath)}\nval role: Role = "admin"\nrole.`;
    const aliasExpectations = [
      ["User", "name", "User"],
      ["UserInput", "name", "User"],
      ["PublicUser", "role", "PublicUser"],
      ["UserPatch", "id", "UserPatch"],
      ["Coordinates", "number", "Coordinates"],
      ["Setting", "boolean", "Setting"],
      ["UserEvent", "created", "Event"],
      ["UserEventInput", "created", "Event"],
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
    const roleSchemaUsageProbe = positionAfter(source, "typeof RoleSchema");
    const zImportProbe = positionAfter(source, "import { z", -1);
    const completionProbe = positionAfter(source, "role.");
    const hoverProbes = [
      schemaProbe,
      roleProbe,
      ...aliasProbes,
      ...schemaProbes,
      roleSchemaUsageProbe,
      zImportProbe
    ];
    const result = await openEntrypointInLspSession(
      sourcePath,
      process.cwd(),
      hoverProbes,
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
    const roleSchemaDefinition = result.definitions.at(-2);
    expect(Array.isArray(roleSchemaDefinition)).toBe(false);
    if (!roleSchemaDefinition || Array.isArray(roleSchemaDefinition)) {
      throw new Error("Expected a single RoleSchema definition");
    }
    const schemasPath = resolve(process.cwd(), "samples/zod/schemas.vx");
    const schemasSource = await vfs().readFile(schemasPath);
    expect(roleSchemaDefinition.uri.endsWith("/samples/zod/schemas.vx")).toBe(true);
    expect(roleSchemaDefinition.range.start.line).toBe(
      schemasSource.split("\n").findIndex((line) => line.includes("export const RoleSchema"))
    );
    const zDefinition = result.definitions.at(-1);
    expect(Array.isArray(zDefinition)).toBe(false);
    if (!zDefinition || Array.isArray(zDefinition)) {
      throw new Error("Expected a single z definition");
    }
    if (!zDefinition.uri.endsWith("/zod/index.d.cts")) {
      throw new Error(`Expected z to resolve to its namespace declaration, got ${zDefinition.uri}`);
    }
    expect(zDefinition.range.start.line).toBe(0);
    expect(zDefinition.range.start.character).toBe("import * as ".length);
    const aliasHoverTexts = aliasExpectations.map((_, index) =>
      JSON.stringify(result.hovers[index + 2]?.contents ?? "")
    );
    aliasExpectations.forEach(([, expectedText], index) => {
      const aliasHoverText = aliasHoverTexts[index]!;
      expect(aliasHoverText).toContain(expectedText);
      expect(aliasHoverText).not.toContain("unknown");
      expect(aliasHoverText).not.toContain("object & unknown");
    });
    expect(result.workMetrics).toMatchObject({
      externalResolverRuns: 1,
      importedDeclarationCollections: 1
    });
    expect(result.workMetrics.baseSessionBuilds).toBeLessThan(6);
    expect(result.workMetrics.resolvedSessionBuilds).toBeLessThan(3);
    expect(result.workMetrics.sessionRequests).toBeLessThanOrEqual(hoverProbes.length * 65);
    expect(result.workMetrics.diskSessionCacheMisses).toBeLessThan(100);
    expect(result.workMetrics.diskSessionBuilds).toBeLessThan(100);
    expect(result.warmWorkMetrics).toMatchObject({
      sessionCacheMisses: 0,
      externalResolverRuns: 0,
      baseSessionBuilds: 0,
      resolvedSessionBuilds: 0,
      importedDeclarationCollections: 0,
      diskSessionCacheMisses: 0,
      diskStatCalls: 0,
      diskReadCalls: 0,
      diskSessionBuilds: 0
    });
    expect(result.warmWorkMetrics.sessionRequests).toBeLessThanOrEqual((hoverProbes.length + 1) * 5);

    const parsingSourcePath = resolve(process.cwd(), "samples/zod/parsing.vx");
    const parsingSource = await vfs().readFile(parsingSourcePath);
    expect(/\b(?:any|unknown)\b/.test(parsingSource)).toBe(false);
    const inferredParsingSource = parsingSource.replace("const event: UserEvent =", "const event =");
    expect(inferredParsingSource === parsingSource).toBe(false);
    const importedAliasResult = await openEntrypointInLspSession(
      parsingSourcePath,
      process.cwd(),
      [
        positionAfter(inferredParsingSource, "const event =", -2),
        positionAfter(inferredParsingSource, "EventSchema.parse", -8),
        positionAfter(inferredParsingSource, "EventSchema.parse", -2),
        positionAfter(inferredParsingSource, '== "created"', -3),
        positionAfter(inferredParsingSource, "event.kind", -2),
        positionAfter(inferredParsingSource, "event.name", -2),
        positionAfter(inferredParsingSource, "z.core.$ZodIssue", -2),
        positionAfter(inferredParsingSource, "issue.message", -2)
      ],
      [],
      inferredParsingSource,
      true,
      true
    );
    const importedAliasHover = importedAliasResult.hovers[0]?.contents as { kind?: string; value?: string } | undefined;
    expect(importedAliasHover?.kind).toBe("markdown");
    expect(importedAliasHover?.value).toContain("```typescript\nconst event: {\n");
    expect(importedAliasHover?.value).toContain('  kind: "created";\n');
    expect(importedAliasHover?.value).toContain("} | {\n");
    const importedSchemaHover = importedAliasResult.hovers[1]?.contents as { kind?: string; value?: string } | undefined;
    expect(importedSchemaHover?.kind).toBe("markdown");
    expect(importedSchemaHover?.value).toContain("```typescript\nconst EventSchema: ZodDiscriminatedUnion<");
    expect(importedSchemaHover?.value).toContain('ZodLiteral<"created">');
    const parseHover = importedAliasResult.hovers[2]?.contents as { kind?: string; value?: string } | undefined;
    expect(parseHover?.kind).toBe("markdown");
    expect(parseHover?.value).toContain("```typescript\nparse: (data: unknown");
    expect(parseHover?.value).toContain('=> {\n  kind: "created";\n');
    expect(parseHover?.value).not.toContain("=> unknown");
    const literalHover = importedAliasResult.hovers[3]?.contents as { kind?: string; value?: string } | undefined;
    expect(literalHover).toEqual({
      kind: "markdown",
      value: "```typescript\nexpression: string\n```"
    });
    const kindHover = importedAliasResult.hovers[4]?.contents as { kind?: string; value?: string } | undefined;
    expect(kindHover).toEqual({
      kind: "markdown",
      value: '```typescript\nkind: "created"\n```'
    });
    const nameHover = importedAliasResult.hovers[5]?.contents as { kind?: string; value?: string } | undefined;
    expect(nameHover).toEqual({
      kind: "markdown",
      value: "```typescript\nname: string\n```"
    });
    const issueTypeHover = importedAliasResult.hovers[6]?.contents as { kind?: string; value?: string } | undefined;
    expect(issueTypeHover?.kind).toBe("markdown");
    expect(issueTypeHover?.value).toContain("```typescript\ntype z.core.$ZodIssue");
    const issueMessageHover = importedAliasResult.hovers[7]?.contents as { kind?: string; value?: string } | undefined;
    expect(issueMessageHover).toEqual({
      kind: "markdown",
      value: "```typescript\nmessage: string\n```"
    });

    const issueTypeDefinition = importedAliasResult.definitions[6];
    if (!issueTypeDefinition || Array.isArray(issueTypeDefinition)) {
      throw new Error("Expected a single z.core.$ZodIssue definition");
    }
    const issueMessageDefinition = importedAliasResult.definitions[7];
    if (!issueMessageDefinition || Array.isArray(issueMessageDefinition)) {
      throw new Error("Expected a single issue.message definition");
    }
    const zodErrorsPath = resolve(process.cwd(), "samples/zod/node_modules/zod/v4/core/errors.d.cts");
    const zodErrorsLines = (await vfs().readFile(zodErrorsPath)).split("\n");
    const issueTypeDeclarationLine = zodErrorsLines.findIndex((line) => line.startsWith("export type $ZodIssue ="));
    const issueMessageDeclarationLine = zodErrorsLines.findIndex((line) => line.includes("readonly message: string"));
    expect(issueTypeDefinition.uri.endsWith("/zod/v4/core/errors.d.cts")).toBe(true);
    expect(issueTypeDefinition.range.start.line).toBe(issueTypeDeclarationLine);
    expect(issueTypeDefinition.range.start.character).toBe(zodErrorsLines[issueTypeDeclarationLine]!.indexOf("$ZodIssue"));
    expect(issueMessageDefinition.uri.endsWith("/zod/v4/core/errors.d.cts")).toBe(true);
    expect(issueMessageDefinition.range.start.line).toBe(issueMessageDeclarationLine);
    expect(issueMessageDefinition.range.start.character).toBe(zodErrorsLines[issueMessageDeclarationLine]!.indexOf("message"));

    const mainSourcePath = resolve(process.cwd(), "samples/zod/main.vx");
    const mainSource = await vfs().readFile(mainSourcePath);
    const parseDefinitionResult = await openEntrypointInLspSession(
      mainSourcePath,
      process.cwd(),
      [
        positionAfter(mainSource, "PublicUserSchema.parse", -2),
        positionAfter(mainSource, "EvenSchema.parse", -8),
        positionAfter(mainSource, "EvenSchema.parse", -2),
        positionAfter(mainSource, "const json =", -2),
        positionAfter(mainSource, "const even =", -2),
        positionAfter(mainSource, "const fallback =", -2)
      ],
      [],
      mainSource,
      true
    );
    const parseDefinition = parseDefinitionResult.definitions[0];
    if (!parseDefinition || Array.isArray(parseDefinition)) {
      throw new Error("Expected a single PublicUserSchema.parse definition");
    }
    if (!parseDefinition.uri.endsWith("/zod/v4/classic/schemas.d.cts")) {
      throw new Error(
        `Expected the ZodType.parse declaration, got ${parseDefinition.uri}:${parseDefinition.range.start.line + 1}`
      );
    }
    const zodSchemasPath = resolve(process.cwd(), "samples/zod/node_modules/zod/v4/classic/schemas.d.cts");
    const zodSchemasSource = await vfs().readFile(zodSchemasPath);
    const parseDeclarationLine = zodSchemasSource
      .split("\n")
      .findIndex((line) => line.includes("parse(data: unknown"));
    expect(parseDefinition.range.start.line).toBe(parseDeclarationLine);
    expect(parseDefinition.range.start.character).toBe(
      zodSchemasSource.split("\n")[parseDeclarationLine]!.indexOf("parse")
    );
    const evenSchemaHoverText = JSON.stringify(parseDefinitionResult.hovers[1]?.contents ?? "");
    const evenParseHoverText = JSON.stringify(parseDefinitionResult.hovers[2]?.contents ?? "");
    const jsonHoverText = JSON.stringify(parseDefinitionResult.hovers[3]?.contents ?? "");
    const evenHoverText = JSON.stringify(parseDefinitionResult.hovers[4]?.contents ?? "");
    const fallbackHoverText = JSON.stringify(parseDefinitionResult.hovers[5]?.contents ?? "");
    expect(evenSchemaHoverText).toContain("ZodNumber");
    expect(evenSchemaHoverText).not.toContain("unknown");
    expect(evenParseHoverText).toContain("parse:");
    expect(evenParseHoverText).toContain("=> number");
    expect(jsonHoverText).toContain("const json: string | number | boolean | null");
    expect(evenHoverText).toContain("const even: number");
    expect(fallbackHoverText).toContain("const fallback: number");
  });
});
