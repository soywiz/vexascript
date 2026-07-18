import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { parseSource } from "compiler/pipeline/parse";
import type { Statement } from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import {
  resolveAmbientImportedSymbolDefinition,
  resolveAmbientModuleObjectMemberDefinition
} from "./crossFileAmbientNavigation";
import { findMemberExpressionAtPosition } from "./crossFileTypeResolution";
import type { ResolveContext } from "./crossFileContext";

function parseAmbientModule(src: string, moduleName: string): Statement[] {
  const result = parseSource(src, { language: "typescript" });
  const namespace = result.ast?.body.find(
    (statement) =>
      statement.kind === NodeKind.NamespaceStatement &&
      (statement as { externalModuleName?: { value: string } }).externalModuleName?.value === moduleName
  ) as { body?: { body?: Statement[] } } | undefined;
  return namespace?.body?.body ?? [];
}

function contextFor(
  session: ReturnType<typeof createAnalysisSession>,
  line: number,
  character: number
): ResolveContext {
  return {
    uri: "file:///virtual/main.vx",
    line,
    character,
    session,
    sourceRoots: []
  };
}

describe("crossFileAmbientNavigation", () => {
  it("resolves directly imported ambient module symbols to their declaration", async () => {
    const source = dedent`
      import { readFile } from "node:fs/promises"
      await readFile("hello")
    `;
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:fs/promises", parseAmbientModule(
        `declare module "node:fs/promises" {
          export function readFile(path: string): Promise<string>;
        }`,
        "node:fs/promises"
      )]
    ]);
    const ambientModuleLocations = new Map([
      ["node:fs/promises", { filePath: "/virtual/@types/node/fs/promises.d.ts", line: 0, character: 0 }]
    ]);
    const baseSession = createAnalysisSession(source, { ambientModuleDeclarations: ambientModuleDeclarations, ambientModuleLocations: ambientModuleLocations });
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, ambientModuleDeclarations, ambientModuleLocations, importedSymbols: collected.importedSymbols });

    const location = await resolveAmbientImportedSymbolDefinition(
      contextFor(session, 1, source.split("\n")[1]!.indexOf("readFile") + 2)
    );

    expect(location?.uri).toBe("file:///virtual/%40types/node/fs/promises.d.ts");
    expect(location?.range.start.line).toBe(1);
  });

  it("resolves namespace-imported ambient module object members to their declaration", async () => {
    const source = dedent`
      import * as util from "node:util"
      util.format("value")
    `;
    const ambientModuleDeclarations = new Map<string, Statement[]>([
      ["node:util", parseAmbientModule(
        `declare module "node:util" {
          export function format(value: string): string;
        }`,
        "node:util"
      )]
    ]);
    const ambientModuleLocations = new Map([
      ["node:util", { filePath: "/virtual/@types/node/util.d.ts", line: 0, character: 0 }]
    ]);
    const baseSession = createAnalysisSession(source, { ambientModuleDeclarations: ambientModuleDeclarations, ambientModuleLocations: ambientModuleLocations });
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: "file:///virtual/main.vx",
      sourceRoots: [],
      ambientModuleDeclarations
    });
    const session = createAnalysisSession(source, { externalDeclarations: collected.externalDeclarations, ambientModuleDeclarations, ambientModuleLocations, importedSymbols: collected.importedSymbols });
    const line = 1;
    const character = source.split("\n")[1]!.indexOf("format") + 2;
    const memberExpression = findMemberExpressionAtPosition(session.ast!, line, character);

    const location = await resolveAmbientModuleObjectMemberDefinition(
      contextFor(session, line, character),
      memberExpression!,
      "format"
    );

    expect(location?.uri).toBe("file:///virtual/%40types/node/util.d.ts");
    expect(location?.range.start.line).toBe(1);
  });
});
