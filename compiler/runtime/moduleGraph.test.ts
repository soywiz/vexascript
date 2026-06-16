import { Script, createContext, describe, expect, it, join, mkdir, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { bundleModuleGraph } from "./moduleGraph";
import { ensureEcmaScriptRuntimeProgram } from "./ecmascriptDeclarations";

async function withTempProject(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vexa-module-graph-"));
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
        "other.vx": "class Point(val x: number, val y: number)\n",
        "main.vx": 'import { Point } from "./other"\n\nconst p = Point(1, 2)\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

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
        "dep.vx":
          "class TimeSpan(val ms: number) {}\n" +
          "val number.seconds => TimeSpan(this * 1000.0)\n" +
          "fun delay(time: TimeSpan) => new Promise((resolve, reject) => { setTimeout(resolve, time.ms) })\n",
        "main.vx":
          'import { delay, seconds } from "./dep"\n' +
          "sync fun demo() {\n" +
          "  delay(1.seconds)\n" +
          "  delay(2.seconds)\n" +
          "}\n" +
          "demo()\n"
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "optimized");

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
        "other.vx":
          dedent`
          class Point(val x: number, val y: number)
          fun Point.operator+(other: Point) => Point(x + other.x, y + other.y)
          `,
        "main.vx":
          'import { Point, operator+ } from "./other"\n\n' +
          "const sum = Point(1, 2) + Point(3, 4)\n"
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

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
        "base.vx": "class Base(val value: number)\n",
        "left.vx": 'import { Base } from "./base"\nfun makeLeft() => Base(1)\n',
        "right.vx": 'import { Base } from "./base"\nfun makeRight() => Base(2)\n',
        "main.vx":
          'import { makeLeft } from "./left"\nimport { makeRight } from "./right"\nmakeLeft()\nmakeRight()\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

        expect(result.errors).toEqual([]);
        const baseDefinitions = result.code.split("class Base {").length - 1;
        expect(baseDefinitions).toBe(1);
      }
    );
  });

  it("transpiles and inlines local TypeScript modules imported from VexaScript", async () => {
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
        "main.vx":
          'import { Color, Person, makePerson } from "./helpers"\n' +
          'const direct = Person("Ada", 36)\n' +
          'const made = makePerson("Grace")\n' +
          'console.log(direct.describe())\n' +
          'console.log(made.describe())\n' +
          'console.log(Color.Red, Color.Green, Color.Blue)\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("var Color;");
        expect(result.code).toContain("class Person {");
        expect(result.code).toContain("function makePerson(name)");
        expect(result.code).not.toContain('from "./helpers"');
        expect(result.code).not.toContain("export class Person");
        expect(result.code).not.toContain("export function makePerson");
        expect(result.code).not.toContain("export var Color");
        expect(result.code).toContain('const direct = new Person("Ada", 36);');
      }
    );
  });


  it("inlines local JSON and text imports as runtime constants", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "metadata.json": JSON.stringify({ title: "Asset imports", count: 2 }),
        "message.txt": "hello from text",
        "main.vx":
          'import metadata from "./metadata.json"\n' +
          'import message from "./message.txt"\n' +
          'console.log(metadata.title + ":" + metadata.count)\n' +
          'console.log(message.toUpperCase())\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain('const metadata = {"title":"Asset imports","count":2};');
        expect(result.code).toContain('const message = "hello from text";');
        expect(result.code).not.toContain('from "./metadata.json"');
        expect(result.code).not.toContain('from "./message.txt"');

        const logs: unknown[][] = [];
        new Script(result.code).runInContext(createContext({
          console: {
            log: (...args: unknown[]) => logs.push(args)
          }
        }));
        expect(logs).toEqual([["Asset imports:2"], ["HELLO FROM TEXT"]]);
      }
    );
  });

  it("keeps non-local (bare) imports in the bundled output", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "main.vx": 'import { readFile } from "node:fs"\nreadFile("x")\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain('import { readFile } from "node:fs";');
      }
    );
  });

  it("auto-awaits ambient node module named imports inside sync functions", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "node_modules/@types/node/package.json": JSON.stringify({ name: "@types/node", types: "index.d.ts" }),
        "node_modules/@types/node/index.d.ts": dedent`
          declare module "fs/promises" {
            export function writeFile(path: string, data: string): Promise<void>;
            export function readFile(path: string, encoding: string): Promise<string>;
          }
        `,
        "main.vx": dedent`
          import { readFile, writeFile } from "fs/promises"

          sync fun main() {
            writeFile("demo.txt", "test")
            console.log(readFile("demo.txt", "utf-8"))
          }

          await main()
        `
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain('await writeFile("demo.txt", "test");');
        expect(result.code).toContain('console.log(await readFile("demo.txt", "utf-8"));');
      }
    );
  });

  it("resolves named imports from package exports subpath typings such as preact/hooks", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "node_modules/preact/package.json": JSON.stringify({
          name: "preact",
          exports: {
            "./hooks": {
              types: "./hooks/src/index.d.ts",
              import: "./hooks/dist/hooks.mjs"
            }
          }
        }),
        "node_modules/preact/hooks/src/index.d.ts": dedent`
          export type Dispatch<A> = (value: A) => void;
          export type StateUpdater<S> = S | ((prevState: S) => S);
          export function useState<S>(initialState: S | (() => S)): [S, Dispatch<StateUpdater<S>>];
        `,
        "main.vx": dedent`
          import { useState } from "preact/hooks"
          const [count, setCount] = useState(0)
          setCount(count + 1)
        `
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");
        expect(result.errors).toEqual([]);
      }
    );
  });

  it("preserves entry exports while still stripping bundled dependency module syntax", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "dep.vx": "export fun double(value: number) => value * 2\n",
        "main.vx":
          'import { double } from "./dep"\n' +
          "export const bundled = double(21)\n"
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("function double(value)");
        expect(result.code).toContain("export const bundled = double(21);");
        expect(result.code).not.toContain("export function double");
        expect(result.code).not.toContain('from "./dep"');
      }
    );
  });

  it("preserves semantic diagnostics emitted by transpile", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "main.vx": dedent`
          interface MaybeRunner {
            run(): MaybeRunner
          }
          let maybe: MaybeRunner | undefined
          let bad = maybe.run()
        `
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

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
        "main.vx": 'import moment from "moment"\nconsole.log(moment.parseZone("2026-06-07T00:00:00+02:00").format("YYYY-MM-DD"))\n'
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");

        expect(result.errors).toEqual([]);
      }
    );
  });
});
