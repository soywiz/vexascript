import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { collectCrossFileMemberDiagnostics } from "./memberDiagnostics";
import { collectAllImportedDeclarations } from "./importedDeclarations";

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

  it("resolves array members even when the element type is imported from another file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-diag-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = `class Token(val text: string) { }
`;
    const helloSource = `import { Token } from "./world"
fun demo(items: Token[]) {
  items.length
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

    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Property 'length' does not exist on type 'Token[]'"
    );
    expect(diagnostics).toEqual([]);
  });

  it("does not report imported extension methods declared on a base class for subclass receivers from d.ts files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-diag-"));
    const runtimeFile = join(root, "pixi.d.ts");
    const utilsFile = join(root, "utils.vx");
    const helloFile = join(root, "hello.vx");

    const runtimeSource = dedent`
      export declare class Container {
        addChild(child: unknown): void;
      }
      export declare class ViewContainer extends Container {}
      export declare class Graphics extends ViewContainer {}
      export declare class AbstractText extends ViewContainer {}
      export declare class Text extends AbstractText {}
    `;
    const utilsSource = dedent`
      import { Container } from "./pixi"
      fun Container.addTo(other: Container) {
        other.addChild(this)
      }
    `;
    const helloSource = dedent`
      import { Graphics, Text, Container } from "./pixi"
      import { addTo } from "./utils"
      fun demo() {
        val stage = Container()
        Graphics()
          ..addTo(stage)
        Text()
          ..addTo(stage)
      }
    `;

    await writeFile(runtimeFile, runtimeSource, "utf8");
    await writeFile(utilsFile, utilsSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const baseSession = createAnalysisSession(helloSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(helloFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(
      helloSource,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    const diagnostics = await collectCrossFileMemberDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Property 'addTo' does not exist on type 'Graphics'"
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Property 'addTo' does not exist on type 'Text'"
    );
  });

  it("does not report imported extension methods declared on a transitive base from a local TypeScript module", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-diag-"));
    const runtimeFile = join(root, "pixi.ts");
    const utilsFile = join(root, "utils.vx");
    const helloFile = join(root, "hello.vx");

    const runtimeSource = dedent`
      export class Container {
        addChild(child: unknown): void {}
      }
      export class ViewContainer extends Container {}
      export class Graphics extends ViewContainer {}
      export class AbstractText extends ViewContainer {}
      export class Text extends AbstractText {}
    `;
    const utilsSource = dedent`
      import { Container } from "./pixi"
      fun Container.addTo(other: Container) {
        other.addChild(this)
      }
    `;
    const helloSource = dedent`
      import { Graphics, Text } from "./pixi"
      import { addTo } from "./utils"
      fun demo() {
        val stage = Graphics()
        Graphics()
          ..addTo(stage)
        Text()
          ..addTo(stage)
      }
    `;

    await writeFile(runtimeFile, runtimeSource, "utf8");
    await writeFile(utilsFile, utilsSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const baseSession = createAnalysisSession(helloSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(helloFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(
      helloSource,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    const diagnostics = await collectCrossFileMemberDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Property 'addTo' does not exist on type 'Graphics'"
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Property 'addTo' does not exist on type 'Text'"
    );
  });

  it("does not report imported extension methods declared on a base class for subclass receivers from node_modules typings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-diag-"));
    const packageDir = join(root, "node_modules", "pixi.js");
    const utilsFile = join(root, "utils.vx");
    const helloFile = join(root, "hello.vx");

    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "pixi.js", types: "index.d.ts" }),
      "utf8"
    );
    await writeFile(
      join(packageDir, "index.d.ts"),
      dedent`
        export declare class Container {
          addChild(child: unknown): void;
        }
        export declare class ViewContainer extends Container {}
        export declare class Graphics extends ViewContainer {}
        export declare class AbstractText extends ViewContainer {}
        export declare class Text extends AbstractText {}
      `,
      "utf8"
    );
    await writeFile(
      utilsFile,
      dedent`
        import { Container } from "pixi.js"
        fun Container.addTo(other: Container) {
          other.addChild(this)
        }
      `,
      "utf8"
    );
    const helloSource = dedent`
      import { Graphics, Text, Container } from "pixi.js"
      import { addTo } from "./utils"
      fun demo() {
        val stage = Container()
        Graphics()
          ..addTo(stage)
        Text()
          ..addTo(stage)
      }
    `;
    await writeFile(helloFile, helloSource, "utf8");

    const baseSession = createAnalysisSession(helloSource);
    const collected = await collectAllImportedDeclarations(baseSession.ast!, {
      uri: pathToFileURL(helloFile).toString(),
      sourceRoots: [root]
    });
    const session = createAnalysisSession(
      helloSource,
      collected.externalDeclarations,
      collected.importedSymbolTypes,
      [],
      new Map(),
      new Map(),
      collected.importedSymbolDisplayTypes,
      collected.invalidImportedBindings
    );

    const diagnostics = await collectCrossFileMemberDiagnostics({
      uri: pathToFileURL(helloFile).toString(),
      session,
      sourceRoots: [root]
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Property 'addTo' does not exist on type 'Graphics'"
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContain(
      "Property 'addTo' does not exist on type 'Text'"
    );
  });
});
