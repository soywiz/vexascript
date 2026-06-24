import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import type { MemberExpression } from "compiler/ast/ast";
import { typeToString } from "compiler/analysis/types";
import { createAnalysisSession } from "./analysisSession";
import { collectAllImportedDeclarations } from "./importedDeclarations";
import { resolveDefinitionWithLocalFallback, resolveHoverWithLocalFallback, resolveReferencesAcrossFiles } from "./crossFileNavigation";
import { findMemberExpressionAtPosition } from "./crossFileTypeResolution";
import { createSignatureHelp } from "./signatureHelp";

// Mirrors samples/pixi: a class member (Container.position from node_modules) is
// shadowed by an imported extension property (var Container.position: Vec2 in
// utils.vx). The type checker resolves the imported extension; hover/definition
// must agree instead of pointing at the node_modules class member.
async function resolvePositionMember(mainSource: string, cursorNeedle: string) {
  const root = await mkdtemp(join(tmpdir(), "vexa-ext-precedence-"));
  const pkgDir = join(root, "node_modules", "shapes-pkg");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "shapes-pkg", types: "./index.d.ts" }),
    "utf8"
  );
  await writeFile(join(pkgDir, "index.d.ts"), `export declare class Box {\n  position: number;\n}\n`, "utf8");

  const extPath = join(root, "ext.vx");
  const mainPath = join(root, "main.vx");
  const extSource = dedent`
    import { Box } from "shapes-pkg"
    fun Box.touch() { }
    var Box.position: string {
      get => "hi"
      set { }
    }
  `;
  await writeFile(extPath, extSource, "utf8");
  await writeFile(mainPath, mainSource, "utf8");

  const uri = pathToFileURL(mainPath).toString();
  const extSession = createAnalysisSession(extSource);
  const baseSession = createAnalysisSession(mainSource);
  const getSessionForFilePath = (filePath: string) => {
    if (filePath === extPath) return extSession;
    if (filePath === mainPath) return baseSession;
    return null;
  };
  const collected = await collectAllImportedDeclarations(baseSession.ast!, {
    uri,
    sourceRoots: [root],
    getSessionForFilePath
  });
  const session = createAnalysisSession(mainSource, {
    externalDeclarations: collected.externalDeclarations,
    importedSymbols: collected.importedSymbols,
    invalidImportedBindings: collected.invalidImportedBindings
  });

  const lines = mainSource.split("\n");
  const line = lines.findIndex((l) => l.includes(cursorNeedle));
  const character = lines[line]!.indexOf(cursorNeedle) + cursorNeedle.length;
  const context = { uri, session, sourceRoots: [root], getSessionForFilePath };

  const memberExpr = findMemberExpressionAtPosition(session.ast!, line, character) as MemberExpression | null;
  const memberType = memberExpr ? session.analysis!.getExpressionTypes().get(memberExpr) : undefined;
  const definition = await resolveDefinitionWithLocalFallback({ ...context, line, character });
  const hover = await resolveHoverWithLocalFallback({ ...context, line, character });
  const hoverValue =
    hover && typeof hover.contents === "object" && "value" in hover.contents
      ? String((hover.contents as { value: string }).value)
      : "";
  const references = await resolveReferencesAcrossFiles({ ...context, line, character }, true);

  return { extUri: pathToFileURL(extPath).toString(), memberType, definition, hoverValue, references };
}

describe("imported extension member precedence (class vs extension)", () => {
  it("definition, hover, and inferred type agree on the imported extension member", async () => {
    const mainSource = dedent`
      import { Box } from "shapes-pkg"
      import { position } from "./ext.vx"
      val b = Box()
      val p = b.position
    `;
    const { extUri, memberType, definition, hoverValue, references } = await resolvePositionMember(mainSource, "b.position");

    // Type checker resolves the imported extension property (string).
    expect(memberType && typeToString(memberType)).toBe("string");
    // Definition and hover must agree: the extension in ext.vx, not the class member.
    expect(definition?.uri).toBe(extUri);
    expect(hoverValue).toContain("string");
    expect(hoverValue).not.toContain("number");
    // References/rename anchor on the extension declaration too.
    expect(references.some((reference) => reference.uri === extUri)).toBe(true);
  });

  it("keeps definition/hover consistent with the type when position is not imported", async () => {
    // samples/pixi removed `position` from the import but still imports a sibling
    // (addTo/Vec2) from the same file. Selective collection means the extension is
    // NOT brought in, so the type checker resolves the class member. Definition and
    // hover must agree with that — they must not diverge to the extension.
    const mainSource = dedent`
      import { Box } from "shapes-pkg"
      import { touch } from "./ext.vx"
      val b = Box()
      val p = b.position
    `;
    const { extUri, memberType, definition, hoverValue, references } = await resolvePositionMember(mainSource, "b.position");

    expect(memberType && typeToString(memberType)).toBe("number");
    // No divergence: definition/hover/references follow the class member the type checker used.
    expect(definition?.uri).not.toBe(extUri);
    expect(hoverValue).toContain("number");
    expect(hoverValue).not.toContain("string");
    expect(references.some((reference) => reference.uri === extUri)).toBe(false);
  });

  it("agrees on the extension member through a cascade assignment (..position)", async () => {
    const mainSource = dedent`
      import { Box } from "shapes-pkg"
      import { position } from "./ext.vx"
      val b = Box()
        ..position = "set me"
    `;
    const { extUri, definition } = await resolvePositionMember(mainSource, "..position");

    expect(definition?.uri).toBe(extUri);
  });

  it("shows the imported extension method's signature, not the shadowed class method", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-ext-sig-"));
    const boxPath = join(root, "box.vx");
    const extPath = join(root, "ext.vx");
    const mainPath = join(root, "main.vx");
    const boxSource = dedent`
      export class Box {
        fun describe(n: number): number => n
      }
    `;
    const extSource = dedent`
      import { Box } from "./box.vx"
      fun Box.describe(label: string): string => label
    `;
    const mainSource = dedent`
      import { Box } from "./box.vx"
      import { describe } from "./ext.vx"
      val b = Box()
      b.describe()
    `;
    await writeFile(boxPath, boxSource, "utf8");
    await writeFile(extPath, extSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const uri = pathToFileURL(mainPath).toString();
    const boxSession = createAnalysisSession(boxSource);
    const extSession = createAnalysisSession(extSource);
    const baseSession = createAnalysisSession(mainSource);
    const getSessionForFilePath = (filePath: string) => {
      if (filePath === boxPath) return boxSession;
      if (filePath === extPath) return extSession;
      if (filePath === mainPath) return baseSession;
      return null;
    };
    const collected = await collectAllImportedDeclarations(baseSession.ast!, { uri, sourceRoots: [root], getSessionForFilePath });
    const session = createAnalysisSession(mainSource, {
      externalDeclarations: collected.externalDeclarations,
      importedSymbols: collected.importedSymbols,
      invalidImportedBindings: collected.invalidImportedBindings
    });

    const lines = mainSource.split("\n");
    const line = lines.findIndex((l) => l.includes("b.describe()"));
    const character = lines[line]!.indexOf("b.describe(") + "b.describe(".length;
    const help = await createSignatureHelp(session.ast!, session.analysis!, line, character, {
      uri,
      sourceRoots: [root],
      getSessionForFilePath,
      externalDeclarations: collected.externalDeclarations
    });
    const labels = help?.signatures.map((signature) => signature.label) ?? [];

    // The extension shadows the class method, so signature help shows the
    // extension's signature (string param), not the class method's (number).
    expect(labels.some((label) => label.includes("label: string"))).toBe(true);
    expect(labels.some((label) => label.includes("n: number"))).toBe(false);
  });
});
