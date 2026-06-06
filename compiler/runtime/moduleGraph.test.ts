import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "../test/expect";
import { bundleModuleGraph } from "./moduleGraph";

function withTempProject(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mylang-module-graph-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const filePath = join(dir, name);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bundleModuleGraph", () => {
  it("inlines local imports and drops their import statements", () => {
    withTempProject(
      {
        "other.my": "class Point(val x: number, val y: number)\n",
        "main.my": 'import { Point } from "./other"\n\nconst p = Point(1, 2)\n'
      },
      (dir) => {
        const result = bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("class Point {");
        expect(result.code).not.toContain('from "./other"');
        expect(result.code).toContain("const p = new Point(1, 2);");
      }
    );
  });

  it("lowers cross-file operator overloads using the imported declaration", () => {
    withTempProject(
      {
        "other.my":
          "class Point(val x: number, val y: number)\n" +
          "fun Point.operator+(other: Point) => Point(x + other.x, y + other.y)\n",
        "main.my":
          'import { Point, operator+ } from "./other"\n\n' +
          "const sum = Point(1, 2) + Point(3, 4)\n"
      },
      (dir) => {
        const result = bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain("function Point$$operator$plus$$Point($this, other)");
        expect(result.code).toContain(
          "const sum = Point$$operator$plus$$Point(new Point(1, 2), new Point(3, 4));"
        );
      }
    );
  });

  it("emits each module once for diamond-shaped dependencies", () => {
    withTempProject(
      {
        "base.my": "class Base(val value: number)\n",
        "left.my": 'import { Base } from "./base"\nfun makeLeft() => Base(1)\n',
        "right.my": 'import { Base } from "./base"\nfun makeRight() => Base(2)\n',
        "main.my":
          'import { makeLeft } from "./left"\nimport { makeRight } from "./right"\nmakeLeft()\nmakeRight()\n'
      },
      (dir) => {
        const result = bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        const baseDefinitions = result.code.split("class Base {").length - 1;
        expect(baseDefinitions).toBe(1);
      }
    );
  });

  it("keeps non-local (bare) imports in the bundled output", () => {
    withTempProject(
      {
        "main.my": 'import { readFile } from "node:fs"\nreadFile("x")\n'
      },
      (dir) => {
        const result = bundleModuleGraph(join(dir, "main.my"), "conservative");

        expect(result.errors).toEqual([]);
        expect(result.code).toContain('import { readFile } from "node:fs";');
      }
    );
  });
});
