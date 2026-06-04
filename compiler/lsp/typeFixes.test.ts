import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAnalysisSession } from "./analysisSession";
import { collectDiagnosticsFromSession } from "./diagnostics";
import { collectCrossFileTypeDiagnostics } from "./crossFileTypeDiagnostics";
import { createTypeFixCodeActions } from "./typeFixes";

describe("type quick fixes", () => {
  it("changes member type in imported class from assignment mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-type-fix-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = `class Point(val y: int)
`;
    const helloSource = `import { Point } from "./world"
fun demo() {
  const point = new Point(1)
  point.y = "test"
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = [
      ...collectDiagnosticsFromSession(
        session,
        helloSource,
        (offset) => {
          const lines = helloSource.slice(0, offset).split("\n");
          const line = Math.max(0, lines.length - 1);
          const character = (lines[line] ?? "").length;
          return { line, character };
        }
      ),
      ...collectCrossFileTypeDiagnostics({
        uri: pathToFileURL(helloFile).toString(),
        session,
        sourceRoots: [root]
      })
    ];

    const actions = createTypeFixCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: session.ast,
      analysis: session.analysis,
      diagnostics,
      sourceRoots: [root],
      commandName: "mylang.refreshDiagnostics"
    });

    expect(actions.length).toBeGreaterThan(0);
    const worldUri = pathToFileURL(worldFile).toString();
    const editText = actions[0]?.edit?.changes?.[worldUri]?.[0]?.newText;
    expect(editText).toBe("string");
    expect(actions[0]?.title).toBe("Change type of 'Point.y: int' to 'string'");
    expect(actions[0]?.command?.command).toBe("mylang.refreshDiagnostics");
  });

  it("changes inherited generic member declaration type using specialized mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "mylang-type-fix-"));
    const worldFile = join(root, "world.my");
    const helloFile = join(root, "hello.my");

    const worldSource = `class Base<T> {
  value: T
}
class Child extends Base<int> {
}
`;
    const helloSource = `import { Child } from "./world"
fun demo() {
  const child = new Child()
  child.value = "test"
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = [
      ...collectDiagnosticsFromSession(
        session,
        helloSource,
        (offset) => {
          const lines = helloSource.slice(0, offset).split("\n");
          const line = Math.max(0, lines.length - 1);
          const character = (lines[line] ?? "").length;
          return { line, character };
        }
      ),
      ...collectCrossFileTypeDiagnostics({
        uri: pathToFileURL(helloFile).toString(),
        session,
        sourceRoots: [root]
      })
    ];

    const actions = createTypeFixCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: session.ast,
      analysis: session.analysis,
      diagnostics,
      sourceRoots: [root]
    });

    expect(actions.length).toBeGreaterThan(0);
    const worldUri = pathToFileURL(worldFile).toString();
    const editText = actions[0]?.edit?.changes?.[worldUri]?.[0]?.newText;
    expect(editText).toBe("string");
    expect(actions[0]?.title).toBe("Change type of 'Base.value: int' to 'string'");
  });
});
