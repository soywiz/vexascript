import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { expect } from "../test/expect";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import { createCreateMemberCodeActions } from "./memberFixes";
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";

function missingMemberDiagnostic(message: string): Diagnostic {
  return {
    severity: 1,
    source: "mylang-sema",
    message,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

describe("member quick fixes", () => {
  it("creates missing member in imported class file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-member-fix-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = `class MyPoint(const x: number, const y: number) { }
`;
    const helloSource = `import { MyPoint } from "./world"
fun demo() {
  const point = new MyPoint()
  point.xx
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const actions = createCreateMemberCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: session.ast,
      diagnostics: [
        missingMemberDiagnostic("Property 'xx' does not exist on type 'MyPoint'")
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Create member 'xx' in class 'MyPoint'");
    const worldUri = pathToFileURL(worldFile).toString();
    expect(actions[0]?.edit?.changes?.[worldUri]?.[0]?.newText).toContain("xx: unknown");
  });

  it("creates missing member in local class declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-member-fix-"));
    const file = join(root, "demo.my");
    const source = `class MyPoint { }
fun demo() {
  const point = new MyPoint()
  point.zz
}
`;
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const actions = createCreateMemberCodeActions({
      uri: pathToFileURL(file).toString(),
      ast: session.ast,
      diagnostics: [
        missingMemberDiagnostic("Property 'zz' does not exist on type 'MyPoint'")
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const uri = pathToFileURL(file).toString();
    expect(actions[0]?.edit?.changes?.[uri]?.[0]?.newText).toContain("zz: unknown");
  });

  it("infers missing member type from assignment usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-member-fix-"));
    const file = join(root, "demo.my");
    const source = `class MyPoint { }
fun demo() {
  const point = new MyPoint()
  point.zz = 42
}
`;
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const diagnostics = collectCrossFileMemberDiagnostics({
      uri: pathToFileURL(file).toString(),
      session,
      sourceRoots: [root]
    });
    const actions = createCreateMemberCodeActions({
      uri: pathToFileURL(file).toString(),
      ast: session.ast,
      analysis: session.analysis,
      diagnostics,
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const uri = pathToFileURL(file).toString();
    expect(actions[0]?.edit?.changes?.[uri]?.[0]?.newText).toContain("zz: int");
  });

  it("resolves class target from generic missing-member diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-member-fix-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = `class Map<K, V> {
}
`;
    const helloSource = `import { Map } from "./world"
fun demo() {
  const map = new Map<string, int>()
  map.extra = 1
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const actions = createCreateMemberCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: session.ast,
      analysis: session.analysis,
      diagnostics: [
        missingMemberDiagnostic("Property 'extra' does not exist on type 'Map<string, int>'")
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const worldUri = pathToFileURL(worldFile).toString();
    expect(actions[0]?.edit?.changes?.[worldUri]?.[0]?.newText).toContain("extra: unknown");
  });
});
