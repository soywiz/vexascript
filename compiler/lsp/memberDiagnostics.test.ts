import { describe, expect, it, join, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";

describe("cross-file member diagnostics", () => {
  it("reports unknown class members for imported classes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-diag-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = `class MyPoint(const x: number, const y: number) { }
`;
    const helloSource = `import { MyPoint } from "./world"
fun demo() {
  const point = new MyPoint()
  point.xx
  point.y
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileMemberDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.message === "Property 'xx' does not exist on type 'MyPoint'"
      )
    ).toBe(true);
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.message.includes("Property 'y' does not exist")
      )
    ).toBe(false);
  });

  it("reports unknown members in chained imported member access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-diag-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = `class MyPoint(const x: number, const y: string) {
  xx: MyOtherClass
}
class MyOtherClass {
  a: MyPoint
}
`;
    const helloSource = `import { MyPoint } from "./world"
fun demo() {
  const point = new MyPoint(1, "ok")
  point.xx.b
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileMemberDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.message === "Property 'b' does not exist on type 'MyOtherClass'"
      )
    ).toBe(true);
  });

  it("reports unknown members nested in arrow-function expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-diag-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = "class MyPoint(const x: number) { }\n";
    const helloSource =
      'import { MyPoint } from "./world"\n' +
      dedent`
      fun demo() {
        const point = new MyPoint(1)
        const inspect = () => point.missing
      }
      `;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const diagnostics = await collectCrossFileMemberDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "Property 'missing' does not exist on type 'MyPoint'"
    );
  });
});
