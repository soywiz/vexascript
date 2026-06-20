import dedent from "compiler/utils/dedent";
import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "compiler/test/expect";
import { createAnalysisSession } from "./analysisSession";
import { collectDeprecatedSemanticTokenModifiers } from "./deprecatedSemanticTokens";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { DEPRECATED_TOKEN_MODIFIER, semanticTokenRangeKey } from "./semanticTokens";

describe("deprecated semantic token modifiers", () => {
  it("marks member accesses whose resolved documentation has @deprecated", async () => {
    const source = dedent`
      declare class Graphics {
        /** @deprecated since 8.0.0 Use fill instead */
        beginFill(color: number): Graphics
        fill(color: number): Graphics
      }

      val badge = Graphics()
      badge.beginFill(0xffb635)
      badge.fill(0xffb635)
      `;
    const session = createAnalysisSession(source);
    const modifiers = await collectDeprecatedSemanticTokenModifiers({
      uri: "file:///sample.vx",
      sourceRoots: [],
      session
    });

    expect([...modifiers.values()]).toContain(DEPRECATED_TOKEN_MODIFIER);
    expect(modifiers.size).toBe(1);
  });

  it("marks deprecated members resolved from node_modules declaration files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-deprecated-tokens-"));
    const pkgDir = join(root, "node_modules", "pixi.js");
    const mainPath = join(root, "main.vx");
    const source = dedent`
      import { Graphics } from "pixi.js"

      val badge = Graphics()
      badge.beginFill(0xffb635)
      badge.fill(0xffb635)
      `;

    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pixi.js", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(pkgDir, "index.d.ts"),
      dedent`
        export class Graphics {
          /** @deprecated since 8.0.0 Use fill instead */
          beginFill(color: number): this;
          fill(color: number): this;
        }
      `,
      "utf8"
    );
    await writeFile(mainPath, source, "utf8");

    const baseSession = createAnalysisSession(source);
    const imported = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      getSessionForFilePath: () => null
    });
    const session = createAnalysisSession(
      source,
      imported.externalDeclarations,
      imported.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      imported.importedSymbolDisplayTypes,
      imported.invalidImportedBindings
    );
    const modifiers = await collectDeprecatedSemanticTokenModifiers({
      uri: pathToFileURL(mainPath).toString(),
      sourceRoots: [root],
      session,
      getSessionForFilePath: () => null
    });
    const beginFillOffset = source.lastIndexOf("beginFill");
    const beginFillKey = semanticTokenRangeKey({
      start: { offset: beginFillOffset, line: 3, column: 6 },
      end: { offset: beginFillOffset + "beginFill".length, line: 3, column: 15 }
    });

    expect(modifiers.get(beginFillKey)).toBe(DEPRECATED_TOKEN_MODIFIER);
    expect(modifiers.size).toBe(1);
  });

  it("marks deprecated chain-expression members", async () => {
    const source = dedent`
      declare class Graphics {
        /** @deprecated since 8.0.0 Use fill instead */
        beginFill(color: number): Graphics
        fill(color: number): Graphics
      }

      val badge = Graphics()
        ..beginFill(0xffb635)
        ..fill(0xffb635)
      `;
    const session = createAnalysisSession(source);
    const modifiers = await collectDeprecatedSemanticTokenModifiers({
      uri: "file:///sample.vx",
      sourceRoots: [],
      session
    });
    const beginFillOffset = source.lastIndexOf("beginFill");
    const beginFillKey = semanticTokenRangeKey({
      start: { offset: beginFillOffset, line: 7, column: 4 },
      end: { offset: beginFillOffset + "beginFill".length, line: 7, column: 13 }
    });

    expect(modifiers.get(beginFillKey)).toBe(DEPRECATED_TOKEN_MODIFIER);
    expect(modifiers.size).toBe(1);
  });

  it("marks every repeated deprecated member occurrence even when resolution is reused", async () => {
    const source = dedent`
      declare class Graphics {
        /** @deprecated since 8.0.0 Use fill instead */
        beginFill(color: number): Graphics
        fill(color: number): Graphics
      }

      val first = Graphics()
      first.beginFill(0xffb635)

      val second = Graphics()
      second.beginFill(0xffb635)
      `;
    const session = createAnalysisSession(source);
    const modifiers = await collectDeprecatedSemanticTokenModifiers({
      uri: "file:///sample.vx",
      sourceRoots: [],
      session
    });
    const beginFillOffsets = [...source.matchAll(/beginFill/g)]
      .map((match) => match.index)
      .filter((offset): offset is number => typeof offset === "number");

    expect(beginFillOffsets.length).toBe(3);
    const firstUseOffset = beginFillOffsets[1]!;
    const secondUseOffset = beginFillOffsets[2]!;
    const firstUseKey = semanticTokenRangeKey({
      start: { offset: firstUseOffset, line: 7, column: 6 },
      end: { offset: firstUseOffset + "beginFill".length, line: 7, column: 15 }
    });
    const secondUseKey = semanticTokenRangeKey({
      start: { offset: secondUseOffset, line: 10, column: 7 },
      end: { offset: secondUseOffset + "beginFill".length, line: 10, column: 16 }
    });

    expect(modifiers.get(firstUseKey)).toBe(DEPRECATED_TOKEN_MODIFIER);
    expect(modifiers.get(secondUseKey)).toBe(DEPRECATED_TOKEN_MODIFIER);
    expect(modifiers.size).toBe(2);
  });
});
