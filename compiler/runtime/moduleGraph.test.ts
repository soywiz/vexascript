import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { bundleModuleGraph } from "./moduleGraph";
import { ensureEcmaScriptRuntimeProgram } from "./ecmascriptDeclarations";

async function withTempProject(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mylang-module-graph-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  return run(dir).finally(async () => {
    await rm(dir, { recursive: true, force: true });
  });
}

describe("bundleModuleGraph", () => {
  it("inlines local imports and drops their import statements", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "other.my": "class Point(val x: number, val y: number)\n",
        "main.my": 'import { Point } from "./other"\n\nconst p = Point(1, 2)\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("class Point {");
        expect(result.code).not.toContain('from "./other"');
        expect(result.code).toContain("const p = new Point(1, 2);");
      }
    );
  });

  it("auto-awaits a Promise-returning function imported from another file", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "dep.my":
          "class TimeSpan(val ms: number) {}\n" +
          "val number.seconds => TimeSpan(this * 1000.0)\n" +
          "fun delay(time: TimeSpan) => new Promise((resolve, reject) => { setTimeout(resolve, time.ms) })\n",
        "main.my":
          'import { delay, seconds } from "./dep"\n' +
          "sync fun demo() {\n" +
          "  delay(1.seconds)\n" +
          "  delay(2.seconds)\n" +
          "}\n" +
          "demo()\n"
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.my"), "optimized");

        expect(result.errors).toEqual([]);
        // The imported `delay` returns a Promise (inferred cross-file), so each
        // call inside the async function is implicitly awaited.
        expect(result.code).toContain("await delay(number$$seconds(1));");
        expect(result.code).toContain("await delay(number$$seconds(2));");
      }
    );
  });

  it("lowers cross-file operator overloads using the imported declaration", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "other.my":
          dedent`
          class Point(val x: number, val y: number)
          fun Point.operator+(other: Point) => Point(x + other.x, y + other.y)
          `,
        "main.my":
          'import { Point, operator+ } from "./other"\n\n' +
          "const sum = Point(1, 2) + Point(3, 4)\n"
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("function Point$$operator$plus$$Point($this, other)");
        expect(result.code).toContain(
          "const sum = Point$$operator$plus$$Point(new Point(1, 2), new Point(3, 4));"
        );
      }
    );
  });

  it("emits each module once for diamond-shaped dependencies", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "base.my": "class Base(val value: number)\n",
        "left.my": 'import { Base } from "./base"\nfun makeLeft() => Base(1)\n',
        "right.my": 'import { Base } from "./base"\nfun makeRight() => Base(2)\n',
        "main.my":
          'import { makeLeft } from "./left"\nimport { makeRight } from "./right"\nmakeLeft()\nmakeRight()\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        const baseDefinitions = result.code.split("class Base {").length - 1;
        expect(baseDefinitions).toBe(1);
      }
    );
  });

  it("transpiles and inlines local TypeScript modules imported from MyLang", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "helpers.ts":
          "export enum Color { Red, Green = 2, Blue = \"blue\" }\n" +
          "export class Person {\n" +
          "  constructor(public readonly name: string, private age: number = 0) {}\n" +
          "  describe(): string { return this.name + \":\" + this.age }\n" +
          "}\n" +
          "export function makePerson(name: string): Person { return new Person(name, 7) }\n",
        "main.my":
          'import { Color, Person, makePerson } from "./helpers"\n' +
          'const direct = Person("Ada", 36)\n' +
          'const made = makePerson("Grace")\n' +
          'console.log(direct.describe())\n' +
          'console.log(made.describe())\n' +
          'console.log(Color.Red, Color.Green, Color.Blue)\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("var Color;");
        expect(result.code).toContain("class Person {");
        expect(result.code).toContain("function makePerson(name)");
        expect(result.code).not.toContain('from "./helpers"');
        expect(result.code).toContain('const direct = new Person("Ada", 36);');
      }
    );
  });

  it("keeps non-local (bare) imports in the bundled output", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "main.my": 'import { readFile } from "node:fs"\nreadFile("x")\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain('import { readFile } from "node:fs";');
      }
    );
  });

  it("preserves semantic diagnostics emitted by transpile", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "main.my": dedent`
          interface MaybeRunner {
            run(): MaybeRunner
          }
          let maybe: MaybeRunner | undefined
          let bad = maybe.run()
        `
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("MYL2019");
      }
    );
  });

  it("keeps namespace-shaped node_modules default imports navigable for member calls", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "node_modules/moment/package.json": JSON.stringify({ types: "index.d.ts" }),
        "node_modules/moment/index.d.ts": dedent`
          declare function moment(value?: string): moment.Moment;
          declare namespace moment {
            interface Moment {
              format(mask: string): string;
            }
            function parseZone(value: string): Moment;
          }
          export = moment;
        `,
        "main.my": 'import moment from "moment"\nconsole.log(moment.parseZone("2026-06-07T00:00:00+02:00").format("YYYY-MM-DD"))\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
      }
    );
  });
});
