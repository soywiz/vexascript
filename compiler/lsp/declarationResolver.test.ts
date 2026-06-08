import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { ClassStatement } from "compiler/ast/ast";
import { compileSource } from "compiler/pipeline/compile";
import { expect } from "compiler/test/expect";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";

function isClassStatement(statement: unknown): statement is ClassStatement {
  return (statement as { kind?: unknown }).kind === "ClassStatement";
}

describe("resolveTopLevelDeclarationAcrossFiles", () => {
  it("uses open document sessions when an imported file is not yet visible through the VFS", async () => {
    const currentFilePath = resolve("/workspace/app/main.my");
    const importedFilePath = resolve("/workspace/app/Point.my");
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
});
