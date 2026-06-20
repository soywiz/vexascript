import type { ClassStatement } from "compiler/ast/ast";
import { compileSource } from "compiler/pipeline/compile";
import { describe, expect, it, join, mkdir, mkdtemp, resolve, tmpdir, writeFile } from "compiler/test/expect";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";

function isClassStatement(statement: unknown): statement is ClassStatement {
  return (statement as { kind?: unknown }).kind === "ClassStatement";
}

describe("resolveTopLevelDeclarationAcrossFiles", () => {
  it("uses open document sessions when an imported file is not yet visible through the VFS", async () => {
    const currentFilePath = resolve("/workspace/app/main.vx");
    const importedFilePath = resolve("/workspace/app/Point.vx");
    const current = compileSource('import { Point } from "./Point";\nlet point: Point;');
    const imported = compileSource("class Point");

    const resolved = await resolveTopLevelDeclarationAcrossFiles({
      ast: current.ast!,
      name: "Point",
      currentFilePath,
      predicate: isClassStatement,
      getSessionForFilePath: (filePath) => filePath === importedFilePath
        ? { ast: imported.ast, analysis: imported.analysis }
        : null
    });

    expect(resolved?.filePath).toBe(importedFilePath);
    expect(resolved?.declaration.kind).toBe("ClassStatement");
    expect(resolved?.declaration.name.name).toBe("Point");
  });

  it("resolves imported declarations from node_modules typings for bare specifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-declaration-resolver-"));
    const currentFilePath = join(root, "main.vx");
    const packageDir = join(root, "node_modules", "pixi.js");
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "pixi.js", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(packageDir, "index.d.ts"),
      "export declare class Graphics {}\n",
      "utf8"
    );

    const currentSource = 'import { Graphics } from "pixi.js"\nlet shape: Graphics\n';
    await writeFile(currentFilePath, currentSource, "utf8");
    const current = compileSource(currentSource);

    const resolved = await resolveTopLevelDeclarationAcrossFiles({
      ast: current.ast!,
      name: "Graphics",
      currentFilePath,
      predicate: isClassStatement,
      sourceRoots: [root]
    });

    expect(resolved?.filePath.endsWith("/node_modules/pixi.js/index.d.ts")).toBe(true);
    expect(resolved?.declaration.kind).toBe("ClassStatement");
    expect(resolved?.declaration.name.name).toBe("Graphics");
  });
});
