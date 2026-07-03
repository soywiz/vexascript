import { Script, createContext, describe, expect, it, join, mkdir, mkdtemp, rm, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { bundleModuleGraph, bundleModuleGraphAsModules } from "./moduleGraph";
import { ensureEcmaScriptRuntimeProgram } from "./ecmascriptDeclarations";
import { ensureDomProgram } from "./domDeclarations.shared";

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

const matrixRuntimeSource = dedent`
  class Vector3(val x: number, val y: number, val z: number)
  class Vector4(val x: number, val y: number, val z: number, val w: number)
  class Quaternion {
    static val identity = Quaternion()
  }

  class Matrix4x4(
    val m00: number, val m01: number, val m02: number, val m03: number,
    val m10: number, val m11: number, val m12: number, val m13: number,
    val m20: number, val m21: number, val m22: number, val m23: number,
    val m30: number, val m31: number, val m32: number, val m33: number
  ) {
    static val identity = Matrix4x4(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    )
    static val zero = Matrix4x4(
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0
    )

    static fun TRS(position: Vector3, rotation: Quaternion, scale: Vector3): Matrix4x4 {
      return Matrix4x4(
        scale.x, 0, 0, position.x,
        0, scale.y, 0, position.y,
        0, 0, scale.z, position.z,
        0, 0, 0, 1
      )
    }

    static fun Ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): Matrix4x4 {
      return Matrix4x4(
        2 / (right - left), 0, 0, 0,
        0, 2 / (top - bottom), 0, 0,
        0, 0, -2 / (far - near), 0,
        0, 0, 0, 1
      )
    }

    static fun Perspective(fov: number, aspect: number, near: number, far: number): Matrix4x4 {
      return Matrix4x4(
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, -1, 0
      )
    }

    val determinant: number => m00 * m11 * m22
    val isIdentity: boolean => m00 == 1 && m11 == 1 && m22 == 1 && m03 == 0 && m13 == 0 && m23 == 0
    val inverse: Matrix4x4 => Matrix4x4(
      1 / m00, 0, 0, -m03 / m00,
      0, 1 / m11, 0, -m13 / m11,
      0, 0, 1 / m22, -m23 / m22,
      0, 0, 0, 1
    )

    fun MultiplyPoint3x4(point: Vector3): Vector3 {
      return Vector3(
        m00 * point.x + m01 * point.y + m02 * point.z + m03,
        m10 * point.x + m11 * point.y + m12 * point.z + m13,
        m20 * point.x + m21 * point.y + m22 * point.z + m23
      )
    }

    fun MultiplyVector(vector: Vector3): Vector3 {
      return Vector3(
        m00 * vector.x + m01 * vector.y + m02 * vector.z,
        m10 * vector.x + m11 * vector.y + m12 * vector.z,
        m20 * vector.x + m21 * vector.y + m22 * vector.z
      )
    }

    fun GetRow(index: int): Vector4 {
      if (index == 0) return Vector4(m00, m01, m02, m03)
      if (index == 1) return Vector4(m10, m11, m12, m13)
      if (index == 2) return Vector4(m20, m21, m22, m23)
      return Vector4(m30, m31, m32, m33)
    }

    fun GetColumn(index: int): Vector4 {
      if (index == 0) return Vector4(m00, m10, m20, m30)
      if (index == 1) return Vector4(m01, m11, m21, m31)
      if (index == 2) return Vector4(m02, m12, m22, m32)
      return Vector4(m03, m13, m23, m33)
    }

    operator*(other: Matrix4x4): Matrix4x4 {
      return Matrix4x4(
        m00 * other.m00 + m01 * other.m10 + m02 * other.m20 + m03 * other.m30,
        m00 * other.m01 + m01 * other.m11 + m02 * other.m21 + m03 * other.m31,
        m00 * other.m02 + m01 * other.m12 + m02 * other.m22 + m03 * other.m32,
        m00 * other.m03 + m01 * other.m13 + m02 * other.m23 + m03 * other.m33,
        m10 * other.m00 + m11 * other.m10 + m12 * other.m20 + m13 * other.m30,
        m10 * other.m01 + m11 * other.m11 + m12 * other.m21 + m13 * other.m31,
        m10 * other.m02 + m11 * other.m12 + m12 * other.m22 + m13 * other.m32,
        m10 * other.m03 + m11 * other.m13 + m12 * other.m23 + m13 * other.m33,
        m20 * other.m00 + m21 * other.m10 + m22 * other.m20 + m23 * other.m30,
        m20 * other.m01 + m21 * other.m11 + m22 * other.m21 + m23 * other.m31,
        m20 * other.m02 + m21 * other.m12 + m22 * other.m22 + m23 * other.m32,
        m20 * other.m03 + m21 * other.m13 + m22 * other.m23 + m23 * other.m33,
        m30 * other.m00 + m31 * other.m10 + m32 * other.m20 + m33 * other.m30,
        m30 * other.m01 + m31 * other.m11 + m32 * other.m21 + m33 * other.m31,
        m30 * other.m02 + m31 * other.m12 + m32 * other.m22 + m33 * other.m32,
        m30 * other.m03 + m31 * other.m13 + m32 * other.m23 + m33 * other.m33
      )
    }

    operator[](row: int, column: int): number {
      if (row == 0 && column == 0) return m00
      if (row == 0 && column == 1) return m01
      if (row == 0 && column == 2) return m02
      if (row == 0 && column == 3) return m03
      if (row == 1 && column == 0) return m10
      if (row == 1 && column == 1) return m11
      if (row == 1 && column == 2) return m12
      if (row == 1 && column == 3) return m13
      if (row == 2 && column == 0) return m20
      if (row == 2 && column == 1) return m21
      if (row == 2 && column == 2) return m22
      if (row == 2 && column == 3) return m23
      if (row == 3 && column == 0) return m30
      if (row == 3 && column == 1) return m31
      if (row == 3 && column == 2) return m32
      return m33
    }
  }
`;

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

  it("bundles local modules imported through absolute import mappings", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "runtime/myengine-runtime.vx": "class Vector3(val x: number, val y: number, val z: number)\n",
        "example/main.vx": 'import { Vector3 } from "myengine"\n\nconst p = Vector3(1, 2, 3)\n'
      },
      async (dir) => {
        const runtimePath = join(dir, "runtime", "myengine-runtime.vx");
        const result = await bundleModuleGraph(join(dir, "example", "main.vx"), "conservative", {
          importMappings: {
            myengine: runtimePath
          }
        });

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("class Vector3 {");
        expect(result.code).not.toContain('from "myengine"');
        expect(result.code).toContain("const p = new Vector3(1, 2, 3);");
      }
    );
  });

  it("makes configured global symbol files available without imports and emits them on globalThis", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "runtime/myengine-runtime.vx": "class Vector3(val x: number, val y: number, val z: number)\n",
        "example/main.vx": "const p = Vector3(1, 2, 3)\n"
      },
      async (dir) => {
        const runtimePath = join(dir, "runtime", "myengine-runtime.vx");
        const result = await bundleModuleGraph(join(dir, "example", "main.vx"), "conservative", {
          globalSymbols: {
            paths: [runtimePath],
            emit: "globalThis"
          }
        });

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("class Vector3 {");
        expect(result.code).toContain("globalThis.Vector3 = Vector3;");
        expect(result.code).toContain("const p = new Vector3(1, 2, 3);");
      }
    );
  });

  it("bundles and executes the Matrix4x4 runtime helpers end-to-end", async () => {
    await ensureEcmaScriptRuntimeProgram();

    await withTempProject(
      {
        "runtime/myengine-runtime.vx": matrixRuntimeSource,
        "example/main.vx": dedent`
          import { Matrix4x4, Quaternion, Vector3 } from "myengine"

          const matrix = Matrix4x4.TRS(Vector3(10, 20, 30), Quaternion.identity, Vector3(2, 3, 4))
          const transformed = matrix.MultiplyPoint3x4(Vector3(1, 2, 3))
          const restored = matrix.inverse.MultiplyPoint3x4(transformed)
          const product = Matrix4x4.identity * matrix
          const row = product.GetRow(0)
          const column = product.GetColumn(3)
          const vector = product.MultiplyVector(Vector3(1, 1, 1))
          const ortho = Matrix4x4.Ortho(-2, 2, -2, 2, 0.1, 10)
          const perspective = Matrix4x4.Perspective(60, 2, 0.1, 100)

          console.log(matrix.determinant, transformed.x, transformed.y, transformed.z)
          console.log(restored.x, restored.y, restored.z, product.isIdentity)
          console.log(row.x, row.y, row.z, row.w)
          console.log(column.x, column.y, column.z, column.w)
          console.log(vector.x, vector.y, vector.z)
          console.log(ortho[0, 0], ortho[1, 1], perspective[3, 2], Matrix4x4.zero.determinant)
        `
      },
      async (dir) => {
        const runtimePath = join(dir, "runtime", "myengine-runtime.vx");
        const result = await bundleModuleGraph(join(dir, "example", "main.vx"), "conservative", {
          importMappings: {
            myengine: runtimePath
          }
        });

        expect(result.errors).toEqual([]);
        const logs: unknown[][] = [];
        new Script(result.code).runInContext(createContext({
          console: { log: (...args: unknown[]) => logs.push(args) }
        }));

        const normalizedLogs = logs.map((row) =>
          row.map((value) => {
            if (typeof value !== "number") {
              return value;
            }
            const rounded = Math.round(value);
            return Math.abs(value - rounded) <= 1e-9 ? rounded : value;
          })
        );

        expect(normalizedLogs).toEqual([
          [24, 12, 26, 42],
          [1, 2, 3, false],
          [2, 0, 0, 10],
          [10, 20, 30, 1],
          [2, 3, 4],
          [0.5, 0.5, -1, 0]
        ]);
      }
    );
  });

  it("bundles the website playground starter workspace without stack overflows", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "main.vx": dedent`
          import { increment, LoggedProperty } from "./counter.vx"
          import { Point } from "./point.vx"
          import { TimeSpan, delay, seconds, milliseconds, operator+, operator/ } from "./time.vx"
          import { drawCard, drawDot } from "./c2d.vx"

          fun describe(point: Point): string {
            return \`(\${point.x}, \${point.y})\`
          }

          val cardOrigin = Point(36, 28)
          val cardSize = Point(248, 116)
          val pulseCenter = cardOrigin + Point(190, 58)
          val pulseDelay = 1.seconds + 250.milliseconds

          sync fun example() {
            val current = increment(41)
            console.log(current.toString())
            console.log(describe(pulseCenter))

            val app = document.querySelector("#app")
            val canvas = document.createElement("canvas") as HTMLCanvasElement
            canvas
              ..width = 320
              ..height = 180
            app?.append(canvas)

            const c2d = canvas.getContext("2d")! as CanvasRenderingContext2D
            c2d
              ..fillStyle = "#f4f8fc"
              ..fillRect(0, 0, canvas.width, canvas.height)
              ..drawCard(cardOrigin, cardSize, "#8cb3d9", "VexaScript")
              ..drawDot(pulseCenter, 12, "#17324d")

            let prop by LoggedProperty(10)
            prop++

            for (n in 0..<80) {
              c2d.drawDot(pulseCenter, 18 + n / 4.0, "#4d7ea8")
              c2d.drawDot(pulseCenter, 12 - n / 20.0, "#17324d")
              delay(pulseDelay / 100)
            }

            prop += 5

            console.log(TimeSpan(500.0).ms)
            console.log((pulseDelay + 500.milliseconds).ms)
          }

          example()
        `,
        "c2d.vx": dedent`
          import { Point } from "./point.vx"

          export fun CanvasRenderingContext2D.circle(p: Point, radius: number) {
            beginPath()
            arc(p.x, p.y, radius, 0, Math.PI * 2)
          }

          export fun CanvasRenderingContext2D.fillWithStyle(style: string | CanvasGradient | CanvasPattern) {
            fillStyle = style
            fill()
          }

          export fun CanvasRenderingContext2D.drawCard(origin: Point, size: Point, fill: string, label: string) {
            fillStyle = fill
            fillRect(origin.x, origin.y, size.x, size.y)
            fillStyle = "#17324d"
            font = "bold 18px sans-serif"
            fillText(label, origin.x + 16, origin.y + 32)
          }

          export fun CanvasRenderingContext2D.drawDot(center: Point, radius: number, fill: string) {
            circle(center, radius)
            fillWithStyle(fill)
          }
        `,
        "counter.vx": dedent`
          export fun increment(value: int): int {
            return value + 1
          }

          export class LoggedProperty<T>(var current: T) {
            get value(): T => current
            set value(newValue: T) {
              console.log("changed value", current, "->", newValue)
              current = newValue
            }
          }
        `,
        "point.vx": dedent`
          export class Point(val x: number, val y: number) {
            operator+() => this
            operator-() => Point(-x, -y)
            operator+(other: Point) => Point(x + other.x, y + other.y)
            operator-(other: Point) => Point(x - other.x, y - other.y)
            operator*(scale: number) => Point(x * scale, y * scale)
          }
        `,
        "time.vx": dedent`
          export class TimeSpan(val ms: number)

          export val number.seconds => TimeSpan(this * 1000.0)
          export val number.milliseconds => TimeSpan(this)

          fun TimeSpan.operator+(other: TimeSpan): TimeSpan => TimeSpan(ms + other.ms)
          fun TimeSpan.operator-(other: TimeSpan): TimeSpan => TimeSpan(ms - other.ms)
          fun TimeSpan.operator*(scale: number): TimeSpan => TimeSpan(ms * scale)
          fun TimeSpan.operator/(scale: number): TimeSpan => TimeSpan(ms / scale)

          export fun delay(time: TimeSpan) {
            return new Promise { resolve, reject ->
              setTimeout(resolve, time.ms)
            }
          }
        `,
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "optimized", {
          ambientDeclarations: (await ensureDomProgram()).body,
        });

        expect(result.errors).toEqual([]);
      }
    );
  });

  it("emits imported extension-property setters in CommonJS module bundles", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "position.vx": dedent`
          class Vec2(val x: number, val y: number)
          class View(var x: number, var y: number)
          var View.point: Vec2 {
            get { return Vec2(x, y) }
            set { x = newValue.x; y = newValue.y }
          }
        `,
        "main.vx": dedent`
          import { View, Vec2, point } from "./position"
          val view = View(0, 0)
          view.point = Vec2(3, 4)
          console.log(view.point.x, view.point.y)
        `
      },
      async (dir) => {
        const result = await bundleModuleGraphAsModules(join(dir, "main.vx"), "conservative", {
          moduleFormat: "commonjs"
        });

        expect(result.errors).toEqual([]);
        const dependencySource = result.moduleSources.get(join(dir, "position.vx")) ?? "";
        expect(dependencySource).toContain("exports.View$$point = View$$point;");
        expect(dependencySource).toContain("exports.View$$point$set = View$$point$set;");
        expect(result.entrySource).toContain("const { View, Vec2, View$$point, View$$point$set } = require(\"./position\");");
        expect(result.entrySource).toContain("View$$point$set(view, new Vec2(3, 4));");
        expect(result.entrySource).toContain("console.log(View$$point(view).x, View$$point(view).y);");
      }
    );
  });

  it("re-exports and resolves an extension operator overload across CommonJS modules", async () => {
    // Regression: the emitter and the implicit `.vx` export planner used two
    // disagreeing operator->name maps. For `*` the function was emitted as
    // `Vec2$$operator$star$$Vec2` but implicitly exported as
    // `Vec2$$operator$multiply$$Vec2`, so a cross-module call resolved to
    // `undefined`. Both now share one map, so the dependency must export the
    // exact name the emitter defines and the entry imports.
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "vec.vx": dedent`
          class Vec2(val x: number, val y: number)
          fun Vec2.operator*(other: Vec2) => Vec2(x * other.x, y * other.y)
        `,
        "main.vx": dedent`
          import { Vec2, operator* } from "./vec"
          const scaled = Vec2(2, 3) * Vec2(4, 5)
          console.log(scaled.x, scaled.y)
        `
      },
      async (dir) => {
        const result = await bundleModuleGraphAsModules(join(dir, "main.vx"), "conservative", {
          moduleFormat: "commonjs"
        });

        expect(result.errors).toEqual([]);
        const dependencySource = result.moduleSources.get(join(dir, "vec.vx")) ?? "";
        // The emitted definition and the implicit export must use the same name.
        expect(dependencySource).toContain("function Vec2$$operator$star$$Vec2($this, other)");
        expect(dependencySource).toContain("exports.Vec2$$operator$star$$Vec2 = Vec2$$operator$star$$Vec2;");
        // The consumer imports and calls that same name.
        expect(result.entrySource).toContain('require("./vec")');
        expect(result.entrySource).toContain("Vec2$$operator$star$$Vec2(new Vec2(2, 3), new Vec2(4, 5))");

        // End-to-end: wiring the CommonJS modules together must compute a value,
        // not throw a ReferenceError or read `undefined`.
        const logs: unknown[][] = [];
        const modules = new Map<string, { exports: Record<string, unknown> }>();
        const runModule = (source: string): { exports: Record<string, unknown> } => {
          const moduleObject = { exports: {} as Record<string, unknown> };
          const require = (specifier: string) => {
            const key = specifier.replace(/^\.\//, "").replace(/\.(vx|js)$/, "");
            return modules.get(key)?.exports ?? {};
          };
          const context = createContext({
            exports: moduleObject.exports,
            module: moduleObject,
            require,
            console: { log: (...args: unknown[]) => logs.push(args) }
          });
          new Script(source).runInContext(context);
          return moduleObject;
        };
        modules.set("vec", runModule(dependencySource));
        runModule(result.entrySource);

        expect(logs).toEqual([[8, 15]]);
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

  it("resolves named imports from packages that reexport declarations through bare export-star typings", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "node_modules/pixi.js/package.json": JSON.stringify({
          name: "pixi.js",
          types: "./lib/index.d.ts"
        }),
        "node_modules/pixi.js/lib/index.d.ts": 'export * from "@pixi/text";\nexport * from "@pixi/app";\n',
        "node_modules/@pixi/text/package.json": JSON.stringify({
          name: "@pixi/text",
          types: "./lib/index.d.ts"
        }),
        "node_modules/@pixi/text/lib/index.d.ts": "export declare class TextStyle {}\nexport declare class Text { anchor: { set(value: number): void } }\n",
        "node_modules/@pixi/app/package.json": JSON.stringify({
          name: "@pixi/app",
          types: "./lib/index.d.ts"
        }),
        "node_modules/@pixi/app/lib/index.d.ts": "export declare class Application { view: unknown }\n",
        "main.vx": dedent`
          import { Application, Text, TextStyle } from "pixi.js"
          const app = new Application()
          const label = new Text()
          label.anchor.set(0.5)
          console.log(app.view, TextStyle)
        `
      },
      async (dir) => {
        const result = await bundleModuleGraph(join(dir, "main.vx"), "conservative");
        expect(result.errors).toEqual([]);
      }
    );
  });

  it("follows triple-slash references and support imports inside package typings", async () => {
    await ensureEcmaScriptRuntimeProgram();
    await withTempProject(
      {
        "node_modules/pixi-like/package.json": JSON.stringify({
          name: "pixi-like",
          types: "./lib/index.d.ts"
        }),
        "node_modules/pixi-like/global.d.ts": dedent`
          declare namespace GlobalMixins {
            interface Application {
              ticker: {
                add(callback: () => void): void;
              };
            }
          }
        `,
        "node_modules/pixi-like/lib/plugin.d.ts": dedent`
          declare namespace GlobalMixins {
            interface Application {
              pluginReady: boolean;
            }
          }
        `,
        "node_modules/pixi-like/lib/Application.d.ts": dedent`
          export interface Application extends GlobalMixins.Application {
          }

          export declare class Application {
          }
        `,
        "node_modules/pixi-like/lib/index.d.ts": dedent`
          /// <reference path="../global.d.ts" />
          import "./plugin";
          export * from "./Application";
        `,
        "main.vx": dedent`
          import { Application } from "pixi-like"
          const app = new Application()
          app.ticker.add(() => {})
          console.log(app.pluginReady)
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
