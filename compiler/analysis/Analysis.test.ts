import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { Parser, parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "./Analysis";
import type { AnalysisSymbol } from "./Analysis";
import { namedType } from "./types";
import { ensureDomProgram } from "compiler/runtime/domDeclarations";
import dedent from "compiler/utils/dedent";

function namesOfVisibleSymbolsAt(source: string, line: number, character: number): string[] {
  const ast = parseFile(tokenizeReader(source));
  const analysis = new Analysis(ast);
  return analysis.getVisibleSymbolsAt(line, character).map((symbol) => symbol.name).sort();
}

function symbolsOfVisibleSymbolsAt(source: string, line: number, character: number): Map<string, AnalysisSymbol> {
  const ast = parseFile(tokenizeReader(source));
  const analysis = new Analysis(ast);
  return new Map(analysis.getVisibleSymbolsAt(line, character).map((symbol) => [symbol.name, symbol]));
}

describe("Analysis", () => {
  it("checks exported runtime namespace members", () => {
    const ast = parseFile(tokenizeReader("namespace Tools { export const version: int = 1; const hidden = 2 }\nlet ok: int = Tools.version\nlet bad = Tools.hidden"));
    const analysis = new Analysis(ast);
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Property 'hidden' does not exist on type 'Tools'");
    expect(analysis.getIssues().map((issue) => issue.message)).not.toContain("Property 'version' does not exist on type 'Tools'");
  });

  it("binds ambient namespace names and analyzes declarations inside their scope", () => {
    const source = "declare namespace Tools {\nexport const version: string;\nexport function read(): string;\n}\nconst outside = 1";
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const analysis = new Analysis(ast);

    expect(analysis.getVisibleSymbolsAt(1, 16).map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["Tools", "version", "read"]));
    expect(analysis.getVisibleSymbolsAt(4, 0).map((symbol) => symbol.name)).toContain("Tools");
    expect(analysis.getVisibleSymbolsAt(4, 0).map((symbol) => symbol.name)).not.toContain("version");
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("uses ambient function signatures and exported ambient declarations during analysis", () => {
    const source = dedent`
      declare type Id = string
      export declare function lookup(id: Id): int
      lookup(123)
    `;
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const analysis = new Analysis(ast);

    expect(analysis.getVisibleSymbolsAt(2, 0).map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["Id", "lookup"]));
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Argument 1 of type 'int' is not assignable to parameter 'id' of type 'string'");
  });

  it("tracks annotation references and validates annotation arguments", () => {
    const source = dedent`
      annotation DemoTag(val label: string)
      @DemoTag("ok")
      @DemoTag(1)
      @DemoTag()
      @DemoTag("a", "b")
      fun demo() {}
    `;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const declaration = analysis.getSymbolAt(0, 12);
    const callSite = analysis.getSymbolAt(1, 5);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(declaration?.symbol.kind).toBe("annotation");
    expect(callSite?.symbol).toBe(declaration?.symbol);
    expect(analysis.getReferenceRangesAt(0, 12, true)).toEqual([
      {
        start: { line: 0, character: 11 },
        end: { line: 0, character: 18 }
      },
      {
        start: { line: 1, character: 1 },
        end: { line: 1, character: 8 }
      },
      {
        start: { line: 2, character: 1 },
        end: { line: 2, character: 8 }
      },
      {
        start: { line: 3, character: 1 },
        end: { line: 3, character: 8 }
      },
      {
        start: { line: 4, character: 1 },
        end: { line: 4, character: 8 }
      }
    ]);
    expect(messages).toContain("Argument 1 of type 'int' is not assignable to parameter 'label' of type 'string'");
    expect(messages).toContain("Expected at least 1 argument(s), but got 0");
    expect(messages).toContain("Expected at most 1 argument(s), but got 2");
  });

  it("accepts zero-argument annotations without parentheses", () => {
    const source = dedent`
      annotation DemoAnnotation
      @DemoAnnotation
      fun demo() {}
    `;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues()).toEqual([]);
    expect(analysis.getReferenceRangesAt(0, 13, true)).toEqual([
      {
        start: { line: 0, character: 11 },
        end: { line: 0, character: 25 }
      },
      {
        start: { line: 1, character: 1 },
        end: { line: 1, character: 15 }
      }
    ]);
  });

  it("treats function values as assignable to the ambient Function type", () => {
    const source = dedent`
      declare function setTimeout(handler: TimerHandler, timeout?: number): number
      declare type TimerHandler = string | Function
      declare class TimeSpan { ms: number }

      function delay<T>(resolve: (arg1: T) => void, time: TimeSpan) {
        setTimeout(resolve, time.ms)
      }
    `;
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).not.toContain(
      "Argument 1 of type '(arg1: T) => void' is not assignable to parameter 'handler' of type 'TimerHandler'"
    );
  });

  it("expands ambient type aliases before checking function assignability", () => {
    const ambientSource = dedent`
      declare type TimerHandler = string | Function
      declare function setTimeout(handler: TimerHandler, timeout?: number): number
    `;
    const ambientProgram = parseFile(tokenizeReader(ambientSource), { language: "typescript" });
    const source = dedent`
      export fun delay() {
        setTimeout(() => {}, 1)
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)), { ambientDeclarations: ambientProgram.body });

    expect(analysis.getIssues().map((issue) => issue.message)).not.toContain(
      "Argument 1 of type '() => void' is not assignable to parameter 'handler' of type 'TimerHandler'"
    );
  });

  it("treats DOM accessor declarations as property types", () => {
    const source = dedent`
      declare interface Node {
        get textContent(): string
        set textContent(value: string | null)
      }
      declare interface HTMLElement extends Node {}
      declare function createElement(tagName: string): HTMLElement

      const summary = createElement("pre")
      summary.textContent = "Preview width: 1261px"
    `;
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).not.toContain(
      "Type 'string' is not assignable to type '(value: string | null) => void'"
    );
  });

  it("enforces inferred generic DOM constraints on method calls", async () => {
    const source = "document.body.appendChild(10)\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: (await ensureDomProgram()).body });

    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Type argument 'int' does not satisfy constraint 'Node' for type parameter 'T'"
    );
  });

  it("accepts DOM append calls with elements returned from createElement", async () => {
    const source = dedent`
      val app = document.querySelector("#app")
      val summary = document.createElement("pre")
      summary.textContent = "Preview width: 1261px"
      app?.append(summary)
    `;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: (await ensureDomProgram()).body });

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("accepts DOM appendChild calls with elements returned from createElement", async () => {
    const source = dedent`
      val summary = document.createElement("pre")
      document.body.appendChild(summary)
    `;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: (await ensureDomProgram()).body });

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("infers literal DOM overloads for createElement and getContext", async () => {
    const source = dedent`
      val canvas = document.createElement("canvas")
      val ctx = canvas.getContext("2d")
      ctx?.fillRect(0, 0, 10, 10)
    `;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: (await ensureDomProgram()).body });

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves constrained DOM members after non-null assertions on generic calls", async () => {
    const source = dedent`
      const root: HTMLElement = document.createElement("main")
      const first = root.querySelector(".demo")!.firstChild
      first?.nodeType
    `;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: (await ensureDomProgram()).body });

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("prefers non-type-predicate array overloads for boolean callbacks", () => {
    const source = dedent`
      const xs = [1, 2, 3, 4]
      xs.filter(it => it % 2 == 0)
      xs.find(it => it % 2 == 0)
      xs.every(it => it < 10)
      xs.reduce((acc: number, value: number) => acc + value, 0)
    `;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });


  it("accepts constructing DOM URL objects from ambient declarations", async () => {
    const source = 'fetch(new URL("http://localhost"))\n';
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: (await ensureDomProgram()).body });

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("builds nested scopes and exposes function parameters/local variables", () => {
    const source = dedent`
      let top = 1
      fun demo(a, b: Num = top) {
        let inner = a
        {
          let deep = inner
          return deep
        }
      }
    `
    
    const visible = namesOfVisibleSymbolsAt(source, 5, 6);
    expect(visible).toContain("a");
    expect(visible).toContain("b");
    expect(visible).toContain("inner");
    expect(visible).toContain("deep");
    expect(visible).toContain("demo");
    expect(visible).toContain("top");
  });

  it("erases TypeScript this parameters from callable signatures", () => {
    const ast = parseFile(tokenizeReader(`function bind(this: Loader, id: string): string { return id }
let after = bind`));
    const analysis = new Analysis(ast);
    const symbols = new Map(analysis.getVisibleSymbolsAt(1, 4).map((symbol) => [symbol.name, symbol]));

    expect(symbols.get("bind")?.valueType).toBe("(id: string) => string");
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("treats ambient callable interfaces as invocable values", () => {
    const source = dedent`
      fun demo() {
        val test: int = 10
        val result = BigInt(test)
        return result
      }
    `;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const symbols = new Map(analysis.getVisibleSymbolsAt(3, 15).map((symbol) => [symbol.name, symbol]));

    expect(symbols.get("result")?.valueType).toBe("bigint");
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("does not leak function locals outside the function scope", () => {
    const source = dedent`
      let top = 1
      fun demo(a) {
        let inner = a
        return inner
      }
      let after = top
      
`;

    const visible = namesOfVisibleSymbolsAt(source, 5, 4);
    expect(visible).toContain("top");
    expect(visible).toContain("demo");
    expect(visible).toContain("after");
    expect(visible).not.toContain("a");
    expect(visible).not.toContain("inner");
  });

  describe("cross-file extension methods (externalDeclarations)", () => {
    const otherFileSource = "class Point(val x: number, val y: number)\n";
    const mainSource = dedent`
      fun Point.operator+(other: Point) => Point(x + other.x, y + other.y)
      fun Point.distanceTo(other: Point): number => this.x - other.x + (this.y - other.y)
      
`;

    it("resolves the implicit receiver and members of an imported class", () => {
      const externalDeclarations = parseFile(tokenizeReader(otherFileSource)).body;
      const ast = parseFile(tokenizeReader(mainSource));
      const analysis = new Analysis(ast, { externalDeclarations });
      const messages = analysis.getIssues().map((issue) => issue.message);

      expect(messages).not.toContain("Undefined variable 'x'");
      expect(messages).not.toContain("Undefined variable 'y'");
      expect(messages.filter((message) => message.includes("Operator '+' is not defined"))).toEqual([]);
      expect(messages.filter((message) => message.includes("Operator '-' is not defined"))).toEqual([]);
    });

    it("still reports the receiver members as undefined without the imported class", () => {
      const ast = parseFile(tokenizeReader(mainSource));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);

      expect(messages).toContain("Undefined variable 'x'");
    });

    it("resolves an operator overload declared in an imported file", () => {
      const externalSource = dedent`
        class Point(val x: number, val y: number)
        fun Point.operator+(other: Point): Point => Point(x + other.x, y + other.y)
        
`;
      const usageSource =
        'import { Point, operator+ } from "./other"\n' +
        "val sum = Point(1, 2) + Point(3, 4)\n";
      const externalDeclarations = parseFile(tokenizeReader(externalSource)).body;
      const ast = parseFile(tokenizeReader(usageSource));
      const analysis = new Analysis(ast, { externalDeclarations });
      const messages = analysis.getIssues().map((issue) => issue.message);

      expect(messages.filter((message) => message.includes("Operator '+' is not defined"))).toEqual([]);
    });

    it("infers the receiver type of an imported class constructor call", () => {
      // An explicit `import { Point }` must not delete the imported class from the
      // type tables; the constructor call should resolve to the class type so a
      // missing operator overload is reported against 'Point' (not 'unknown'),
      // which is what makes the operator-import quick fix discoverable.
      const externalSource = "class Point(val x: number, val y: number)\n";
      const usageSource =
        'import { Point } from "./other"\n' +
        "val sum = Point(1, 2) + Point(3, 4)\n";
      const externalDeclarations = parseFile(tokenizeReader(externalSource)).body;
      const ast = parseFile(tokenizeReader(usageSource));
      const analysis = new Analysis(ast, { externalDeclarations });
      const messages = analysis.getIssues().map((issue) => issue.message);

      expect(messages).toContain("Operator '+' is not defined for types 'Point' and 'Point'");
      expect(messages.some((message) => message.includes("'unknown'"))).toBe(false);
    });
  });

  describe("unary operator overloads", () => {
    it("resolves unary - on a class with a 0-param operator- method", () => {
      const source = dedent`
        class Point(val x: number, val y: number) {
          operator-(): Point => Point(-x, -y)
        }
        val p = Point(1, 2)
        val neg = -p

`;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages.filter((m) => m.includes("Unary operator"))).toEqual([]);
      const negType = analysis.getExpressionTypes().get(
        (ast.body[2] as import("../ast/ast.js").VarStatement).initializer!
      );
      expect(negType?.kind === "named" && negType.name).toBe("Point");
    });

    it("reports an error for unary - on a class with no operator- method", () => {
      const source = dedent`
        class Point(val x: number, val y: number)
        val p = Point(1, 2)
        val neg = -p

`;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages).toContain("Unary operator '-' is not defined for type 'Point'");
    });

    it("resolves unary + on a class with a 0-param operator+ method", () => {
      const source = dedent`
        class Vec(val x: number) {
          operator+(): Vec => this
        }
        val v = Vec(3)
        val pos = +v

`;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages.filter((m) => m.includes("Unary operator"))).toEqual([]);
    });

    it("does not report an error for unary - on int", () => {
      const source = "val n: int = 5\nval neg = -n\n";
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages.filter((m) => m.includes("Unary operator"))).toEqual([]);
    });

    it("a class can have both unary operator- and binary operator- independently", () => {
      const source = dedent`
        class Point(val x: number, val y: number) {
          operator-(): Point => Point(-x, -y)
          operator-(other: Point): Point => Point(x - other.x, y - other.y)
        }
        val p = Point(1, 2)
        val q = Point(3, 4)
        val neg = -p
        val diff = p - q

`;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages.filter((m) => m.includes("not defined"))).toEqual([]);
    });
  });

  describe("operator arity validation", () => {
    it("reports an error when operator* has 0 parameters", () => {
      const source = dedent`
        class Num(val x: number) {
          operator*(): Num => this
        }

`;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages).toContain("Operator '*' must declare exactly one parameter");
    });

    it("reports an error when operator+ has more than one parameter", () => {
      const source = dedent`
        class Num(val x: number) {
          operator+(a: Num, b: Num): Num => a
        }

`;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages).toContain("Operator '+' must declare at most one parameter");
    });

    it("allows operator+ and operator- with 0 or 1 parameters", () => {
      const source = dedent`
        class Num(val x: number) {
          operator+(): Num => this
          operator-(): Num => Num(-x)
          operator+(other: Num): Num => Num(x + other.x)
          operator-(other: Num): Num => Num(x - other.x)
        }

`;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages.filter((m) => m.includes("must declare"))).toEqual([]);
    });

    it("reports an error for extension operator with wrong arity", () => {
      const source = dedent`
        class Point(val x: number, val y: number)
        fun Point.operator*(): Point => this

`;
      const ast = parseFile(tokenizeReader(source));
      const analysis = new Analysis(ast);
      const messages = analysis.getIssues().map((issue) => issue.message);
      expect(messages).toContain("Operator '*' must declare exactly one parameter");
    });
  });

  it("allows yield only inside generator functions", () => {
    const source = dedent`
      function* ok() {
        yield 1
        yield* []
      }
      function bad() {
        yield 2
      }
      class Store {
        *values() {
          yield 3
        }
        async save() {
          yield 4
        }
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("The 'yield' keyword is only allowed inside generator functions");
    expect(messages.filter((message) => message === "The 'yield' keyword is only allowed inside generator functions")).toHaveLength(2);
  });

  it("allows await only at top level and inside async or sync functions", () => {
    const source = dedent`
      declare function promised(): Promise<int>
      await promised()
      async function okAsync() {
        await promised()
      }
      sync function okSync(): int {
        await promised()
        return 1
      }
      function badNormal() {
        await promised()
      }
      function* badGenerator() {
        await promised()
      }
      class Service {
        async okMethod() {
          await promised()
        }
        badMethod() {
          await promised()
        }
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    const awaitMessage = "The 'await' keyword is only allowed inside async or sync functions or at the top level";
    expect(messages).toContain(awaitMessage);
    expect(messages.filter((message) => message === awaitMessage)).toHaveLength(3);
  });

  it("allows the go operator only inside sync functions", () => {
    const source = dedent`
      declare function promised(): Promise<int>
      sync function okSync(): int {
        let p: Promise<int> = go promised()
        return 1
      }
      async function badAsync() {
        let p: Promise<int> = go promised()
      }
      function badNormal() {
        let p: Promise<int> = go promised()
      }
      let top: Promise<int> = go promised()

`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    const goMessage = "The 'go' operator is only allowed inside sync functions";
    expect(messages).toContain(goMessage);
    expect(messages.filter((message) => message === goMessage)).toHaveLength(3);
  });

  it("uses the final comma expression operand as the expression type", () => {
    const ast = parseFile(tokenizeReader("let value: string = (1, \"ok\")"));
    const analysis = new Analysis(ast);
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("checks TypeScript angle-bracket assertions like as assertions", () => {
    const ast = parseFile(tokenizeReader(`let value: string = <string>unknownValue\nlet unsafe = <number>"oops"
`, { jsx: false }), { language: "typescript" });
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Undefined variable 'unknownValue'");
    expect(messages).toContain("Type assertion from 'string' to 'number' may be unsafe because neither type is assignable to the other");
  });

  it("resolves keyof, typeof type queries, and indexed access types semantically", () => {
    const source = dedent`
      interface Person {
        name: string
        age: int
      }
      let person: Person = { name: "Ada", age: 36 }
      let key: keyof Person = "name"
      let copiedName: typeof person.name = "Ada"
      let indexedName: Person["name"] = "Grace"
      let indexedNames: Person["name"][] = ["Grace"]
      let indexedValue: Person[keyof Person] = 1
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("reports missing properties in indexed access type annotations", () => {
    const source = dedent`
      interface Person { name: string }
      let value: Person["missing"] = "Ada"
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Type 'Person' has no property 'missing'"
    );
  });

  it("reports semantic errors for unresolved variables in scope", () => {
    const source = dedent`
      let top = 1
      fun demo(a) {
        return a + missing + obj.prop + obj[dynamic]
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Undefined variable 'missing'");
    expect(messages).toContain("Undefined variable 'obj'");
    expect(messages).toContain("Undefined variable 'dynamic'");
    expect(messages.some((message) => message.includes("'prop'"))).toBe(false);
    expect(messages.some((message) => message.includes("'a'"))).toBe(false);
  });

  it("infers regular expression literals, sparse array holes, and duplicate switch defaults", () => {
    const source = dedent`
      declare class RegExp {}
      let re: RegExp = /a+/g
      let values: (int | undefined)[] = [1, , 3]
      switch (values[0]) {
        default:
          break
        default:
          break
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Switch statement cannot contain multiple default clauses");
    expect(messages.some((message) => message.includes("RegExp"))).toBe(false);
    expect(messages.some((message) => message.includes("undefined") && message.includes("assignable"))).toBe(false);
  });

  it("reports switch case fallthrough unless control flow exits before the next case", () => {
    const source = dedent`
      switch (value) {
        case 1:
          let one = value
        case 2:
          break
        case 3:
          if (value > 0) {
            return
          } else {
            throw value
          }
        default:
          let other = value
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Switch case falls through to the next case; add 'break', 'return', 'throw', or 'continue' to make control flow explicit");
    expect(messages.filter((message) => message.includes("falls through"))).toHaveLength(1);
  });

  it("reports semantic errors for illegal break/continue usage", () => {
    const source = dedent`
      break
      continue
      switch (x) {
        case 1:
          break
          continue
      }
      while (x) {
        continue
        break
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Illegal 'break' statement outside of a loop or switch");
    expect(messages).toContain("Illegal 'continue' statement outside of a loop");
    expect(messages.filter((message) => message === "Illegal 'continue' statement outside of a loop")).toHaveLength(2);
    expect(messages.filter((message) => message === "Illegal 'break' statement outside of a loop or switch")).toHaveLength(1);
  });

  it("validates labeled break and continue targets", () => {
    const source = dedent`
      outer: while (ok) {
        continue outer
        break outer
      }
      blockLabel: {
        break blockLabel
        continue blockLabel
      }
      break missingLabel
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Illegal 'continue' target 'blockLabel' because the label does not reference a loop");
    expect(messages).toContain("Undefined statement label 'missingLabel'");
    expect(messages.some((message) => message.includes("'outer'"))).toBe(false);
    expect(messages.some((message) => message.includes("'blockLabel'") && message.startsWith("Undefined"))).toBe(false);
  });

  it("requires every reachable path in non-void functions and methods to return", () => {
    const source = dedent`
      function complete(flag: boolean): int {
        if (flag) {
          return 1
        } else {
          return 2
        }
      }
      function incomplete(flag: boolean): int {
        if (flag) return 1
      }
      class Calculator {
        choose(flag: boolean): string {
          if (flag) return "yes"
        }
        fail(): int {
          throw "failure"
        }
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const missingReturnIssues = analysis.getIssues().filter(
      (issue) => issue.message === "Not all code paths return a value"
    );

    expect(missingReturnIssues).toHaveLength(2);
    expect(missingReturnIssues.map((issue) => issue.node.kind)).toEqual(["Identifier", "Identifier"]);
    expect(missingReturnIssues.map((issue) => (issue.node as { name?: string }).name)).toEqual([
      "incomplete",
      "choose"
    ]);
  });

  it("checks return values against the nearest function return type", () => {
    const source = dedent`
      function wrong(): int {
        return "bad"
      }
      function missingValue(): string {
        return
      }
      function wrongVoid(): void {
        return 1
      }
      function outer(): string {
        function inner(): int {
          return "inner bad"
        }
        return "ok"
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const issues = analysis.getIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Type 'string' is not assignable to return type 'int'",
      "A function whose declared return type is neither 'undefined' nor 'void' must return a value",
      "Type 'int' is not assignable to return type 'void'",
      "Type 'string' is not assignable to return type 'int'"
    ]);
    expect(issues.map((issue) => issue.node.kind)).toEqual([
      "ReturnStatement",
      "ReturnStatement",
      "ReturnStatement",
      "ReturnStatement"
    ]);
  });

  it("reports empty template interpolations as semantic missing-expression errors", () => {
    const source = "class TimeSpan(val ms: number) {\n  toString() => `${}`\n}\n";

    const ast = parseFile(tokenizeReader(source));
    const parser = new Parser(tokenizeReader(source));
    parser.parseFile();
    const analysis = new Analysis(ast);

    expect(parser.errors).toEqual([]);
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Expected an expression");
    expect(analysis.getIssues().map((issue) => issue.node.kind)).toContain("MissingExpression");
  });

  it("accepts awaited and non-awaited return values in async functions with Promise return types", () => {
    const source = dedent`
      declare function promisedInt(): Promise<int>
      async function goodValue(): Promise<int> {
        return 10
      }
      async function goodPromise(): Promise<int> {
        return promisedInt()
      }
      async function bad(): Promise<int> {
        return "bad"
      }
      async function empty(): Promise<void> {
        return
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const issues = analysis.getIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Type 'string' is not assignable to return type 'Promise<int>'"
    ]);
    expect(issues.map((issue) => issue.node.kind)).toEqual([
      "ReturnStatement"
    ]);
  });

  it("unwraps Promise values in await expressions and preserves non-Promise values", () => {
    const source = dedent`
      declare function promisedInt(): Promise<int>
      declare function plainInt(): int
      
      async function consumePromise() {
        let value: int = await promisedInt()
      }
      
      async function consumePlain() {
        let value: int = await plainInt()
      }
      
      async function wrongAwaitedType() {
        let value: string = await promisedInt()
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const issues = analysis.getIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Type 'int' is not assignable to type 'string'",
      "Nested type mismatch: expression 'await ... )' is 'int' but expected 'string'"
    ]);
    expect(issues.map((issue) => issue.node.kind)).toEqual([
      "Identifier",
      "UnaryExpression"
    ]);
  });

  it("infers Promise return types from async function returns", () => {
    const source = dedent`
      async function inferred(flag: boolean) {
        if (flag) return 10
        return 20
      }
      let expectsPromise: (flag: boolean) => Promise<int> = inferred
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });


  it("contextually types Promise constructor executors and infers resolved values", () => {
    const okSource = dedent`
      let promise: Promise<int> = new Promise((resolve, reject) => {
        resolve(123)
      })
    `;
    const okAnalysis = new Analysis(parseFile(tokenizeReader(okSource)));
    expect(okAnalysis.getIssues().map((issue) => issue.message)).toEqual([]);

    const mismatchSource = dedent`
      let promise: Promise<string> = new Promise((resolve, reject) => {
        resolve(123)
      })
    `;
    const mismatchAnalysis = new Analysis(parseFile(tokenizeReader(mismatchSource)));
    expect(mismatchAnalysis.getIssues().map((issue) => issue.message)).toContain(
      "Type 'Promise<int>' is not assignable to type 'Promise<string>'"
    );
  });

  it("validates Promise constructor and resolver arity", () => {
    const source = dedent`
      let missing = new Promise()
      let extra = new Promise((resolve, reject) => {
        resolve(1, 2)
      })
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "Expected at least 1 argument(s), but got 0",
      "Expected at most 1 argument(s), but got 2",
      "Unexpected argument 2; function expects at most 1 argument(s)"
    ]));
  });

  it("contextually types Promise executors for class calls without new", () => {
    const source = dedent`
      let promise: Promise<int> = Promise { resolve, reject ->
        resolve(123)
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });


  it("auto-wraps non-Promise annotations on async functions as Promise<T>", () => {
    const source = dedent`
      async function inferred(): number {
        return 10
      }
      class Box {
        async load(): string {
          return "x"
        }
      }
      let a: () => Promise<number> = inferred
      let b: () => Promise<string> = () => new Box().load()
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("treats sync functions as Promise<T> producers without requiring a Promise annotation", () => {
    const source = dedent`
      sync function inferred(): number {
        return 10
      }
      class Box {
        sync load(): string {
          return "x"
        }
      }
      let a: () => Promise<number> = inferred
      let b: () => Promise<string> = () => new Box().load()
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("auto-awaits Promise-typed bindings inside sync functions while go preserves the Promise", () => {
    const source = dedent`
      sync fun fetchValue(): int { return 1 }
      sync fun main(): int {
        let x = fetchValue()
        let p: Promise<int> = go fetchValue()
        return x + 10
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("observes auto-awaited sync results as their unwrapped type", () => {
    const source = dedent`
      sync fun fetchValue(): int { return 1 }
      sync fun main(): void {
        let s: string = fetchValue()
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Type 'int' is not assignable to type 'string'"
    );
  });

  it("auto-awaits Promise-typed subexpressions in argument and member positions", () => {
    const source = dedent`
      declare function use(value: int): void
      class Box { value(): int { return 1 } }
      sync fun fetchValue(): int { return 1 }
      sync fun fetchBox(): Box { return Box() }
      sync fun main(): void {
        use(fetchValue())
        use(fetchValue() + 1)
        use(fetchBox().value())
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("keeps the Promise type of local variables instead of auto-awaiting references", () => {
    const source = dedent`
      async fun demo2(): Promise<int> { return 10 }
      sync fun demo(): void {
        let stored = go demo2()
        let alias: Promise<int> = stored
        let plain: int = stored
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    // `alias = stored` is fine (both Promise<int>); `plain: int = stored` is a mismatch because the
    // local variable reference is not auto-awaited.
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([
      "Type 'Promise<int>' is not assignable to type 'int'"
    ]);
  });

  it("keeps the Promise type when go opts out, even in argument positions", () => {
    const source = dedent`
      declare function use(value: int): void
      sync fun fetchValue(): int { return 1 }
      sync fun main(): void {
        use(go fetchValue())
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Argument 1 of type 'Promise<int>' is not assignable to parameter 'value' of type 'int'"
    );
  });

  it("checks contextual function-expression and arrow-function returns", () => {
    const source = dedent`
      let arrow: (flag: boolean) => int = (flag) => {
        if (flag) return 1
      }
      let expression: () => string = function(): string {
        return 1
      }
      let concise: () => int = () => "bad"
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const issues = analysis.getIssues();

    expect(issues.map((issue) => issue.message)).toEqual([
      "Not all code paths return a value",
      "Type 'int' is not assignable to return type 'string'",
      "Type 'string' is not assignable to return type 'int'"
    ]);
    expect(issues.map((issue) => issue.node.kind)).toEqual([
      "ArrowFunctionExpression",
      "ReturnStatement",
      "StringLiteral"
    ]);
  });

  it("recognizes exhaustive switch and try/catch return paths", () => {
    const source = dedent`
      function viaSwitch(value: int): string {
        switch (value) {
          case 1:
            return "one"
          default:
            return "other"
        }
      }
      function viaTry(flag: boolean): int {
        try {
          if (flag) return 1
          throw "bad"
        } catch (error) {
          return 2
        }
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues()).toEqual([]);
  });

  it("checks with statement object expressions and bodies", () => {
    const source = dedent`
      let scope = { value: 1 }
      with (scope) {
        let inner: int = "bad"
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("binds catch parameter in try/catch scope and validates throw expressions", () => {
    const source = dedent`
      fun demo() {
        try {
          throw missing
        } catch (err) {
          throw err
        } finally {
          return 0
        }
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Undefined variable 'missing'");
    expect(messages.some((message) => message.includes("'err'"))).toBe(false);
  });

  it("resolves class/function symbols declared later in the same scope", () => {
    const source = dedent`
      fun demo() {
        const a = new Point(1, 2)
        return makePoint(a)
      }
      class Point {
      }
      fun makePoint(value) {
        return value
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'Point'"))).toBe(false);
    expect(messages.some((message) => message.includes("'makePoint'"))).toBe(false);
  });

  it("allows forward references only from global scope declarations", () => {
    const source = dedent`
      fun demo() {
        while (zz) {
          break
        }
        return zz
      }
      var zz = true
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'zz'"))).toBe(false);
  });

  it("requires local variables to be declared before use inside function scope", () => {
    const source = dedent`
      fun demo() {
        return localValue
        let localValue = 1
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Undefined variable 'localValue'");
  });

  it("validates assignment targets as l-values", () => {
    const invalidSource = "20 = 10\n";
    const invalidAst = parseFile(tokenizeReader(invalidSource));
    const invalidAnalysis = new Analysis(invalidAst);
    const invalidMessages = invalidAnalysis.getIssues().map((issue) => issue.message);
    expect(invalidMessages).toContain(
      "Invalid assignment target: left side must be an identifier or member access"
    );

    const validSource = "let a = 1\na.b[10].c = 20\n";
    const validAst = parseFile(tokenizeReader(validSource));
    const validAnalysis = new Analysis(validAst);
    const validMessages = validAnalysis.getIssues().map((issue) => issue.message);
    expect(validMessages).not.toContain(
      "Invalid assignment target: left side must be an identifier or member access"
    );
  });

  it("reports incompatible assignment types", () => {
    const source = dedent`
      var a = 10
      a = "test"
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("reports non-array values used with array destructuring and invalid property delegates", () => {
    const source = dedent`
      fun useState(value: number) {
        return 10
      }

      fun demo2() {
        val [value, setValue] = useState(0)
        var nvalue by useState(0)
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'int' cannot be destructured with an array binding pattern");
    expect(messages).toContain("Type 'int' is not a valid property delegate; expected a function, tuple, or object with a 'value' property");
  });

  it("infers tuple element types for destructuring and generic tuple returns", () => {
    const source = dedent`
      fun useState<T>(value: T) {
        return [value, (newValue: T) => { console.log("setNewValue", newValue) }]
      }

      fun demo() {
        const [result, setResult] = useState(0)
        setResult(result + 1)
        setResult("wrong")
        return result
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = new Map(analysis.getVisibleSymbolsAt(7, 5).map((symbol) => [symbol.name, symbol]));

    expect(symbols.get("result")?.valueType).toBe("int");
    expect(symbols.get("setResult")?.valueType).toBe("(newValue: int) => void");
    expect(messages).toContain("Argument 1 of type 'string' is not assignable to parameter 'newValue' of type 'int'");
    expect(messages.some((message) => message.includes("result + 1"))).toBe(false);
  });


  it("uses VexaScript inline destructuring type annotations and double-colon renames", () => {
    const source = dedent`
      function Page({ name : string, title :: displayTitle : string }) {
        let label = name + displayTitle
        return label
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const symbols = new Map(analysis.getVisibleSymbolsAt(2, 5).map((symbol) => [symbol.name, symbol]));
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(symbols.get("name")?.valueType).toBe("string");
    expect(symbols.get("displayTitle")?.valueType).toBe("string");
    expect(messages).not.toContain("Undefined variable 'name'");
  });

  it("supports labeled TypeScript tuple element types", () => {
    const source = dedent`
      let pair: [name: string, count: int] = ["Ada", 1]
      const [name, count] = pair
      let bad: [name: string, count: int] = [1, "Ada"]
      fun demo() {
        return count
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = new Map(analysis.getVisibleSymbolsAt(4, 5).map((symbol) => [symbol.name, symbol]));

    expect(symbols.get("name")?.valueType).toBe("string");
    expect(symbols.get("count")?.valueType).toBe("int");
    expect(messages).toContain("Type '[int, string]' is not assignable to type '[string, int]'");
  });

  it("checks union, intersection, literal, and tuple type annotations", () => {
    const source = dedent`
      interface Named { name: string }
      interface Aged { age: int }
      let person: Named & Aged = { name: "Ada", age: 1 }
      let incomplete: Named & Aged = { name: "Ada" }
      let maybe: string | int = 1
      maybe = "ok"
      maybe = false
      let status: "ready" | "done" = "ready"
      status = "bad"
      let pair: [string, int] = ["age", 1]
      pair = [2, "wrong"]
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type '{ name: string }' is not assignable to type 'Named & Aged'");
    expect(messages).toContain("Type 'boolean' is not assignable to type 'string | int'");
    expect(messages).toContain("Type 'string' is not assignable to type '\"ready\" | \"done\"'");
    expect(messages).toContain("Type '[int, string]' is not assignable to type '[string, int]'");
    expect(messages.some((message) => message.includes("'ready'"))).toBe(false);
  });


  it("keeps nested unions inside object type annotations", () => {
    const source = dedent`
      type Result = { value: string | int }
      let numeric: Result = { value: 1 }
      let textual: Result = { value: "ok" }
      let invalid: Result = { value: true }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([
      "Type '{ value: boolean }' is not assignable to type '{ value: string | int }'",
      "Nested type mismatch: expression '{ ... }' is '{ value: boolean }' but expected '{ value: string | int }'"
    ]);
  });

  it("checks function and object type literal annotations", () => {
    const source = dedent`
      let mapper: (value: int) => string = (value: int) => "ok"
      let badMapper: (value: int) => string = (value: int) => value
      let point: { x: int; label?: string } = { x: 1 }
      let badPoint: { x: int; label: string } = { x: 1, label: 2 }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = new Map(analysis.getVisibleSymbolsAt(3, 5).map((symbol) => [symbol.name, symbol]));

    expect(symbols.get("mapper")?.valueType).toBe("(value: int) => string");
    expect(symbols.get("point")?.valueType).toBe("{ x: int, label: string | undefined }");
    expect(messages).toContain("Type 'int' is not assignable to return type 'string'");
    expect(messages).toContain("Type '{ x: int, label: int }' is not assignable to type '{ x: int, label: string }'");
  });

  it("reports reassignment of const/val variables", () => {
    const source = dedent`
      const point = 1
      point = 2
      val count = 1
      count += 1
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Cannot assign to 'point' because it is a constant");
    expect(messages).toContain("Cannot assign to 'count' because it is a constant");
  });

  it("reports update expressions on const/val variables", () => {
    const source = dedent`
      const n = 1
      n++
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Cannot assign to 'n' because it is a constant");
  });

  it("reports incompatible assignment types for class members", () => {
    const source = dedent`
      class Point(val y: int)
      fun demo() {
        const point = new Point(1)
        point.y = "test"
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("allows prefix and postfix update expressions on identifiers", () => {
    const source = dedent`
      var a: int = 10
      ++a
      --a
      a++
      a--
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("supports multiple declarations in a single var statement", () => {
    const source = dedent`
      val a = 10 * 2, lol = true
      fun demo() {
        return lol
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'lol'"))).toBe(false);
  });

  it("introduces VexaScript for-in iterator variable in loop scope", () => {
    const source = dedent`
      let iterable = data
      for (value in iterable) {
        return value
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'value'"))).toBe(false);
  });

  it("infers expression and variable types, including function signature types", () => {
    const source = dedent`
      val a = 10
      val b = a + 20
      val s = "hello"
      function hello(x: int): int {
        return x + b
      }
      fun demo() {
        return s
      }
      
`;

    const symbols = symbolsOfVisibleSymbolsAt(source, 7, 3);

    expect(symbols.get("a")?.valueType).toBe("int");
    expect(symbols.get("b")?.valueType).toBe("int");
    expect(symbols.get("s")?.valueType).toBe("string");
    expect(symbols.get("hello")?.valueType).toBe("(x: int) => int");
  });

  it("infers typed arrays from literal element types", () => {
    const source = dedent`
      let nums = [1, 2, 3]
      let mixed = [1, "x"]
      fun demo() {
        return nums
      }
      
`;

    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 3);
    expect(symbols.get("nums")?.valueType).toBe("int[]");
    expect(symbols.get("mixed")?.valueType).toBe("any[]");
  });

  it("unifies the integer and big-integer numeric families to numeric in array literals", () => {
    const source = dedent`
      let mixedNumeric = [10, 10L]
      let intsAndDecimals = [1, 2.5]
      let longsAndBigints = [10L, 10n]
      let incompatible = [10, "string"]
      fun demo() {
        return mixedNumeric
      }

`;

    const symbols = symbolsOfVisibleSymbolsAt(source, 5, 3);
    // `int` (10) and `long` (10L) share the common supertype `numeric`.
    expect(symbols.get("mixedNumeric")?.valueType).toBe("numeric[]");
    // `int` widens to `number`, both within the integer family.
    expect(symbols.get("intsAndDecimals")?.valueType).toBe("number[]");
    // `long` widens to `bigint`, both within the big-integer family.
    expect(symbols.get("longsAndBigints")?.valueType).toBe("bigint[]");
    // Genuinely incompatible elements fall back to `any[]`, not `unknown[]`.
    expect(symbols.get("incompatible")?.valueType).toBe("any[]");
  });

  it("evolves an unknown array element type from push", () => {
    const source =
      "fun demoGenerics() {\n" +
      "  const array: unknown[] = []\n" +
      "  array.push(10)\n" +
      "  return array\n" +
      "}\n";

    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 5);
    expect(symbols.get("array")?.valueType).toBe("int[]");
  });

  it("evolves an implicitly typed empty array from unshift", () => {
    const source =
      "fun demo() {\n" +
      "  let xs = []\n" +
      "  xs.unshift(\"hello\")\n" +
      "  return xs\n" +
      "}\n";

    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 5);
    expect(symbols.get("xs")?.valueType).toBe("string[]");
  });

  it("does not evolve an array that already has a known element type", () => {
    const source =
      "fun demo() {\n" +
      "  const nums: int[] = []\n" +
      "  nums.push(10)\n" +
      "  return nums\n" +
      "}\n";

    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 5);
    expect(symbols.get("nums")?.valueType).toBe("int[]");
  });

  it("resolves builtin and declared class types in annotations and reports unknown types", () => {
    const source = dedent`
      function makePoint(p: Point): int {
        return 1
      }
      class Point {
      }
      fun bad(v: MissingType) {
        return v
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Unknown type 'Point'"))).toBe(false);
    expect(messages).toContain(
      "Unknown type 'MissingType'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter"
    );
  });

  it("reports variable type mismatch on the variable name when initializer is not assignable", () => {
    const source = "let aa: string = 10 * 2\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const issues = analysis.getIssues();

    const mismatch = issues.find((issue) =>
      issue.message === "Type 'int' is not assignable to type 'string'"
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.node.kind).toBe("Identifier");
    expect((mismatch?.node as { name?: string }).name).toBe("aa");
    expect(mismatch?.node.firstToken?.value).toBe("aa");
  });



  it("checks local named export specifiers semantically", () => {
    const okAst = parseFile(tokenizeReader("const value = 1\nexport { value }"));
    expect(new Analysis(okAst).getIssues().map((issue) => issue.message)).toEqual([]);

    const missingAst = parseFile(tokenizeReader("export { missing }"));
    expect(new Analysis(missingAst).getIssues().map((issue) => issue.message)).toContain("Undefined variable 'missing'");
  });

  it("binds and checks declarations nested inside export statements", () => {
    const source = dedent`
      export class Point
      export const p: Point = new Point()
      let again = new Point()
      
`;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = symbolsOfVisibleSymbolsAt(source, 2, 5);

    expect(messages.some((message) => message.includes("'Point'"))).toBe(false);
    expect(symbols.get("p")?.valueType).toBe("Point");
    expect(symbols.get("again")?.valueType).toBe("Point");
  });

  it("resolves symbols introduced by import statements", () => {
    const source = dedent`
      import { Point } from "./a"
      fun demo() {
        return new Point()
      }
      
`;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'Point'"))).toBe(false);
  });

  it("resolves symbols introduced by default, namespace, and aliased imports", () => {
    const source = dedent`
      import React from "react"
      import * as fs from "fs"
      import { Point as LocalPoint } from "./a"
      fun demo() {
        React
        fs
        return new LocalPoint()
      }
      
`;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("'React'"))).toBe(false);
    expect(messages.some((message) => message.includes("'fs'"))).toBe(false);
    expect(messages.some((message) => message.includes("'LocalPoint'"))).toBe(false);
  });

  it("infers imported class instance type from new expressions", () => {
    const source = dedent`
      import { MyPoint } from "./world"
      fun demo() {
        const point = new MyPoint()
        return point
      }
      
`;
    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 10);

    expect(symbols.get("point")?.valueType).toBe("MyPoint");
  });

  it("infers class instance types when classes are called without new", () => {
    const source = dedent`
      class Point(val x: int)
      let point = Point(1)
      
`;
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const symbols = symbolsOfVisibleSymbolsAt(source, 1, 4);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(symbols.get("point")?.valueType).toBe("Point");
  });

  it("reports missing constructor arguments for class calls and new expressions", () => {
    const source = dedent`
      class Point(val x: number, val y: number)
      fun demo() {
        new Point()
        Point()
      }
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Expected at least 2 argument(s), but got 0")).toHaveLength(2);
  });

  it("infers class type for new expressions", () => {
    const source = dedent`
      class Point
      let p = new Point()
      
`;
    const symbols = symbolsOfVisibleSymbolsAt(source, 1, 5);

    expect(symbols.get("p")?.valueType).toBe("Point");
  });

  it("infers number type for decimal and scientific literals", () => {
    const source = dedent`
      let a = 10.573
      let b = 10e-3
      
`;
    const symbols = symbolsOfVisibleSymbolsAt(source, 1, 5);

    expect(symbols.get("a")?.valueType).toBe("number");
    expect(symbols.get("b")?.valueType).toBe("number");
  });

  it("infers numeric separator and non-decimal literal types", () => {
    const source = dedent`
      let a = 1_000
      let b = 0xff
      let c = 0xfn
      
`;
    const symbols = symbolsOfVisibleSymbolsAt(source, 2, 5);

    expect(symbols.get("a")?.valueType).toBe("int");
    expect(symbols.get("b")?.valueType).toBe("int");
    expect(symbols.get("c")?.valueType).toBe("bigint");
  });

  it("infers bigint and long literal and arithmetic types", () => {
    const source = dedent`
      let a = 10n
      let b = 20n
      let c = a + b
      let x = 10L
      let y = 20L
      let z = x + y
      
`;
    const symbols = symbolsOfVisibleSymbolsAt(source, 5, 5);

    expect(symbols.get("a")?.valueType).toBe("bigint");
    expect(symbols.get("c")?.valueType).toBe("bigint");
    expect(symbols.get("x")?.valueType).toBe("long");
    expect(symbols.get("z")?.valueType).toBe("long");
  });

  it("treats builtin string and array length properties as int", () => {
    const source = dedent`
      let textLength = "hello".length
      let arrayLength = [1, 2, 3].length
      let bytesLength = new Uint8Array(4).length

`;
    const symbols = symbolsOfVisibleSymbolsAt(source, 2, 5);

    expect(symbols.get("textLength")?.valueType).toBe("int");
    expect(symbols.get("arrayLength")?.valueType).toBe("int");
    expect(symbols.get("bytesLength")?.valueType).toBe("int");
  });

  it("infers dedicated primitive literal node types", () => {
    const source = dedent`
      let t = true
      let f = false
      let n = null
      let u = undefined
      
`;
    const symbols = symbolsOfVisibleSymbolsAt(source, 3, 5);

    expect(symbols.get("t")?.valueType).toBe("boolean");
    expect(symbols.get("f")?.valueType).toBe("boolean");
    expect(symbols.get("n")?.valueType).toBe("null");
    expect(symbols.get("u")?.valueType).toBe("undefined");
  });

  it("resolves pending TypeScript primitive type annotations with assignability semantics", () => {
    const source = dedent`
      declare function makeSymbol(): symbol
      declare function fail(): never
      let flexible: any = "Ada"
      let strict: int = flexible
      let opaque: unknown = 1
      let record: object = { a: 1 }
      let token: symbol = makeSymbol()
      let recovered: number = fail()
      
`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    expect(messages).toEqual([]);
  });

  it("infers types for ternary, nullish coalescing, relational keywords, and unary word operators", () => {
    const source = dedent`
      let a = true ? 1 : 2
      let b = maybe ?? 10
      let c = item in obj
      let d = item instanceof Point
      let e = typeof a
      let f = void a
      let g = delete obj.key
      
`;
    const symbols = symbolsOfVisibleSymbolsAt(source, 6, 5);

    expect(symbols.get("a")?.valueType).toBe("int");
    expect(symbols.get("b")?.valueType).toBe("int");
    expect(symbols.get("c")?.valueType).toBe("boolean");
    expect(symbols.get("d")?.valueType).toBe("boolean");
    expect(symbols.get("e")?.valueType).toBe("string");
    expect(symbols.get("f")?.valueType).toBe("undefined");
    expect(symbols.get("g")?.valueType).toBe("boolean");
  });

  it("reports semantic error for unknown class members", () => {
    const source = dedent`
      class MyPoint(val y: int) {
        sum(): int {
          return y
        }
      }
      
      fun demo() {
        const point = new MyPoint(1)
        point.y
        point.sum()
        point.xx
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Property 'xx' does not exist on type 'MyPoint'");
    expect(messages.some((message) => message.includes("'y' does not exist"))).toBe(false);
    expect(messages.some((message) => message.includes("'sum' does not exist"))).toBe(false);
  });

  it("reports semantic error for member access on unknown", () => {
    const source = dedent`
      fun maybeUnknown()

      fun demo() {
        const root: unknown = maybeUnknown()
        root.id
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Property 'id' does not exist on type 'unknown'");
  });

  it("reports call argument type and arity mismatches, with int->number and long->bigint assignability", () => {
    const source = dedent`
      fun test2(a: number, b: bigint, c: string) {
      }
      fun demo() {
        test2(1, 10L, "ok")
        test2("hello", 10, "ok")
        test2(1, 10L)
        test2(1, 10L, "ok", 42)
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Argument 1 of type 'string' is not assignable to parameter 'a' of type 'number'"
    );
    expect(messages).toContain(
      "Argument 2 of type 'int' is not assignable to parameter 'b' of type 'bigint'"
    );
    expect(messages).toContain("Expected at least 3 argument(s), but got 2");
    expect(messages).toContain("Expected at most 3 argument(s), but got 4");
    expect(messages).toContain("Unexpected argument 4; function expects at most 3 argument(s)");
  });

  it("reports boxed builtin member-call arity mismatches", () => {
    const source = dedent`
      fun demo() {
        10.toFixed(1, 2, 3)
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Expected at most 1 argument(s), but got 3");
    expect(messages).toContain("Unexpected argument 2; function expects at most 1 argument(s)");
    expect(messages).toContain("Unexpected argument 3; function expects at most 1 argument(s)");
  });

  it("reports calling non-callable values instead of silently resolving to unknown", () => {
    const source = dedent`
      fun demo(): bigint {
        val test: int = 10
        test()
        return BigInt(test)
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'int' is not callable");
  });

  it("reports constructing non-constructable values instead of silently resolving to unknown", () => {
    const source = dedent`
      fun demo() {
        val test: int = 1
        new test()
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'int' is not constructable");
  });

  it("supports assignability between compatible function types beyond strict equality", () => {
    const source = dedent`
      fun target(a: number): int {
        return 1
      }
      fun compatible(a: int, b?: int): int {
        return a
      }
      fun incompatible(a: string): int {
        return 1
      }
      fun demo() {
        let fn = target
        fn = compatible
        fn = incompatible
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("compatible") && message.includes("not assignable"))
    ).toBe(false);
    expect(messages).toContain(
      "Type '(a: string) => int' is not assignable to type '(a: number) => int'"
    );
  });

  it("infers object literal shapes and validates named-type members structurally", () => {
    const source = dedent`
      class Pair(val x: int, val y: int)
      fun sum(pair: Pair): int {
        return pair.x + pair.y
      }
      fun demo() {
        let pair: Pair = { x: 1, y: 2 }
        return sum({ x: 3, y: 4 })
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("not assignable"))).toBe(false);
    expect(messages.some((message) => message.includes("does not exist on type"))).toBe(false);
  });

  it("infers object method types and checks method bodies", () => {
    const source = dedent`
      fun demo() {
        let calc = { add(a: int, b: int): int { return a + b } }
        let value: int = calc.add(1, 2)
        let bad: string = calc.add(1, 2)
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'int' is not assignable to type 'string'");
    expect(messages.some((message) => message.includes("Property 'add' does not exist"))).toBe(false);
  });

  it("reports missing members for inferred object literal shapes", () => {
    const source = dedent`
      fun demo() {
        let pair = { x: 1, y: 2 }
        return pair.z
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Property 'z' does not exist on type '{ x: int, y: int }'");
  });

  it("infers shorthand and spread object literal shapes and checks spread operands", () => {
    const source = dedent`
      fun demo() {
        let a = 1
        let base = { name: "Ada" }
        let merged = { a, ...base, name: "Grace" }
        let age: int = merged.name
        let invalid = { ...a }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
    expect(messages).toContain("Spread types may only be created from object types; got 'int'");
    expect(messages.some((message) => message.includes("Undefined variable 'a'"))).toBe(false);
  });

  it("propagates array element type through iterator and computed assignment", () => {
    const source = dedent`
      let nums = [1, 2, 3]
      for (value in nums) {
        let s: string = value
      }
      nums[0] = "x"
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'int' is not assignable to type 'string'");
    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("adds nested-expression context for type mismatches", () => {
    const source = dedent`
      let value: int = 1 + "x"
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
    expect(
      messages.some((message) => message.startsWith("Nested type mismatch: expression"))
    ).toBe(true);
  });

  it("specializes explicit generic function calls", () => {
    const source = dedent`
      fun identity<T>(value: T): T {
        return value
      }
      let ok: string = identity<string>("hello")
      let wrongReturn: number = identity<string>("hello")
      let wrongArgument = identity<number>("hello")
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'number'");
    expect(messages).toContain("Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'");
    expect(messages.some((message) => message.includes("Unknown type 'T'"))).toBe(false);
  });

  it("infers generic function type arguments from call arguments", () => {
    const source = dedent`
      fun identity<T>(value: T): T {
        return value
      }
      fun first<T>(items: T[]): T {
        return items[0]
      }
      let okString: string = identity("hello")
      let wrongString: int = identity("hello")
      let okArray: int = first([1, 2, 3])
      let wrongArray: string = first([1, 2, 3])
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Type 'string' is not assignable to type 'int'")).toHaveLength(1);
    expect(messages.filter((message) => message === "Type 'int' is not assignable to type 'string'")).toHaveLength(1);
    expect(messages.some((message) => message.includes("Unknown type 'T'"))).toBe(false);
  });

  it("infers generic function type arguments from contextual return types", () => {
    const source = dedent`
      fun make<T>(): T {
      }
      fun empty<T>(): T[] {
      }
      let text: string = make()
      let numbers: int[] = empty()
      let badExplicit: string = make<number>()
      let badArray: int[] = empty<string>()
      let assigned: string
      assigned = make()
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Type 'number' is not assignable to type 'string'")).toHaveLength(1);
    expect(messages.filter((message) => message === "Type 'string[]' is not assignable to type 'int[]'")).toHaveLength(1);
    expect(messages.some((message) => message.includes("Type 'T' is not assignable"))).toBe(false);
  });

  it("allows empty and unknown[] arrays to be assigned to typed arrays", () => {
    const source = dedent`
      fun demo() {
        const a: int[] = []
        const b: string[] = []
        let c: int[]
        c = []
        const u: unknown[] = []
        const d: int[] = u
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message.includes("is not assignable to type"))).toHaveLength(0);
  });

  it("uses array and object literal context for nested generic call return inference", () => {
    const source = dedent`
      interface Box {
        value: string
      }
      fun make<T>(): T {
      }
      let values: string[] = [make()]
      let boxed: Box = { value: make() }
      let badValues: int[] = [make<string>()]
      let badBox: Box = { value: make<number>() }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Type 'string[]' is not assignable to type 'int[]'")).toHaveLength(1);
    expect(messages.filter((message) => message === "Type '{ value: number }' is not assignable to type 'Box'")).toHaveLength(1);
    expect(messages.some((message) => message.includes("Type 'T' is not assignable"))).toBe(false);
  });

  it("contextually types function arguments before generic call inference", () => {
    const source = dedent`
      interface Mapper<T, U> {
        map(item: T): U
      }
      fun mapValue<T, U>(value: T, mapper: Mapper<T, U>): U {
      }
      let okNumber: number = mapValue(1, { map: item => 1 })
      let okText: string = mapValue("hello", { map: item => "ok" })
      let wrongArgument = mapValue(1, { map: item => item.missing })
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = symbolsOfVisibleSymbolsAt(source, 4, 3);

    expect(symbols.get("okNumber")?.valueType).toBe("number");
    expect(symbols.get("okText")?.valueType).toBe("string");
    expect(messages).toContain(
      "Argument 2 of type '{ map: (item: int) => unknown }' is not assignable to parameter 'mapper' of type 'Mapper<int, U>'"
    );
    expect(messages.some((message) => message.includes("Undefined variable 'item'"))).toBe(false);
    expect(messages.some((message) => message.includes("Type 'T' is not assignable"))).toBe(false);
  });

  it("keeps explicit generic function type arguments authoritative over inference", () => {
    const source = dedent`
      fun identity<T>(value: T): T {
        return value
      }
      let wrongArgument = identity<number>("hello")
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Argument 1 of type 'string' is not assignable to parameter 'value' of type 'number'");
  });

  it("resolves generic type aliases in annotations and member access", () => {
    const source = dedent`
      class Box<T> {
        value: T
      }
      type Text = string
      type TextBox = Box<Text>
      type Boxed<T> = Box<T>
      let ok: Text = "hello"
      let bad: Text = 1
      let box: Boxed<Text> = new Box<string>()
      let value: string = box.value
      let wrongValue: int = box.value
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Type 'int' is not assignable to type 'string'")).toHaveLength(1);
    expect(messages.filter((message) => message === "Type 'string' is not assignable to type 'int'")).toHaveLength(1);
    expect(messages.some((message) => message.includes("Unknown type 'Text'"))).toBe(false);
    expect(messages.some((message) => message.includes("Unknown type 'Boxed'"))).toBe(false);
  });

  it("accepts mapped and conditional aliases conservatively", () => {
    const source = dedent`
      type Optional<T> = { [K in keyof T]?: T[K] }
      type Element<T> = T extends (infer U)[] ? U : T
      let optional: Optional<{ name: string }> = { name: "Ada" }
      let element: Element<string[]> = "Ada"
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("supports generic type annotations in classes and interfaces", () => {
    const source = dedent`
      interface PairStore<K, V> {
        keys: K[]
        values: V[]
      }
      
      class Map<K, V> implements PairStore<K, V> {
        keys: K[]
        values: V[]
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("accepts class extends/implements with generic type arguments", () => {
    const source = dedent`
      class Base<T> {
        value: T
      }
      interface Readable<T> {
        value: T
      }
      class Child<T> extends Base<T> implements Readable<T> {
        value: T
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("does not treat generic type arguments in 'new' expressions as runtime identifiers", () => {
    const source = dedent`
      class Map<K, V> {
        a: K
        b: V
      }
      fun demo() {
        const map: boolean = new Map<string, string>()
        map
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Undefined variable 'string'"))).toBe(false);
    expect(messages).toContain("Type 'Map<string, string>' is not assignable to type 'boolean'");
  });

  it("treats class accessors as typed properties and validates accessor parameters", () => {
    const source = dedent`
      class Box {
        get value(): string {
          return "ok"
        }
        set value(next: string) {
        }
        get bad(value: string): string {
          return value
        }
        set missing() {
        }
      }
      let box: Box
      const ok: string = box.value
      const fail: int = box.value
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
    expect(messages).toContain("Getter 'bad' cannot declare parameters");
    expect(messages).toContain("Setter 'missing' must declare exactly one parameter");
    expect(messages.some((message) => message.includes("Property 'value' does not exist"))).toBe(false);
  });

  it("treats getter shorthand members as typed properties", () => {
    const source = dedent`
      class Rect {
        width: number
        height: number
        area: number => this.width * this.height
      }
      let rect: Rect
      const ok: number = rect.area
      const fail: string = rect.area
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'number' is not assignable to type 'string'");
    expect(messages.some((message) => message.includes("Property 'area' does not exist"))).toBe(false);
  });

  it("resolves class member types from generic specifics", () => {
    const source = dedent`
      class Map<K, V> {
        a: K
        b: V
      }
      fun demo() {
        const map: Map<string, int> = new Map<string, int>()
        const ok: string = map.a
        const fail: int = map.a
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Property 'a' does not exist"))).toBe(false);
    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("resolves generic class method signatures from specifics", () => {
    const source = dedent`
      class Map<K, V> {
        get(key: K): V {
        }
      }
      fun demo() {
        const map: Map<string, int> = new Map<string, int>()
        const ok: int = map.get("id")
        const badArg: int = map.get(1)
        const badReturn: string = map.get("id")
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("Argument 1 of type 'int' is not assignable to parameter 'key' of type 'string'"))
    ).toBe(true);
    expect(messages).toContain("Type 'int' is not assignable to type 'string'");
  });

  it("resolves inherited members from generic extends specifics", () => {
    const source = dedent`
      class Base<T> {
        value: T
      }
      class Child extends Base<string> {
      }
      fun demo() {
        const child = new Child()
        const ok: string = child.value
        const bad: int = child.value
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Property 'value' does not exist"))).toBe(false);
    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("resolves members from generic interfaces through extends and implements", () => {
    const source = dedent`
      interface Readable<T> {
        read(): T
      }
      interface NamedReadable<T> extends Readable<T> {
      }
      class Reader implements NamedReadable<string> {
        read(): string {
        }
      }
      fun demo() {
        const reader = new Reader()
        const ok: string = reader.read()
        const bad: int = reader.read()
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Property 'read' does not exist"))).toBe(false);
    expect(messages).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("validates constrained generic type arguments on declarations and calls", () => {
    const source = dedent`
      interface Entity {
        id: string
      }
      class User implements Entity {
        id: string
      }
      class Box<T extends Entity> {
        value: T
      }
      fun readId<T extends Entity>(value: T): string {
      }
      fun demo() {
        const okBox: Box<User> = new Box<User>()
        const badBox: Box<string> = new Box<string>()
        const ok = readId(new User())
        const bad = readId("nope")
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Type argument 'string' does not satisfy constraint 'Entity' for type parameter 'T'"
    );
    expect(messages.some((message) => message.includes("Type argument 'User' does not satisfy"))).toBe(false);
  });

  it("accepts DataView constructor constraints for ArrayBuffer values", () => {
    const source = dedent`
      fun demo() {
        const buffer = ArrayBuffer(4)
        const view = DataView(buffer)
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("does not satisfy constraint"))).toBe(false);
  });

  it("reports missing properties when class does not satisfy implemented interface", () => {
    const source = dedent`
      interface Readable {
        value: string
      }
      class Reader implements Readable {
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'Reader' incorrectly implements interface 'Readable'. Property 'value' is missing"
    );
  });

  it("reports incompatible property types in implemented interface contracts", () => {
    const source = dedent`
      interface Store {
        save(value: string): string
      }
      class NumberStore implements Store {
        save(value: int): int {
        }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'NumberStore' incorrectly implements interface 'Store'. Property 'save' is of type '(value: int) => int' but expected '(value: string) => string'"
    );
  });

  it("reports optionality mismatch in implemented interface method parameters", () => {
    const source = dedent`
      interface Runner {
        run(step: int): int
      }
      class BadRunner implements Runner {
        run(step?: int): int {
        }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'BadRunner' incorrectly implements interface 'Runner'. Property 'run' is of type '(step?: int) => int' but expected '(step: int) => int'"
    );
  });

  it("assumes void return type for interface methods without explicit return annotation", () => {
    const source = dedent`
      interface Runner {
        run(step: int)
      }
      class BadRunner implements Runner {
        run(step: int): int {
        }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'BadRunner' incorrectly implements interface 'Runner'. Property 'run' is of type '(step: int) => int' but expected '(step: int) => void'"
    );
  });

  it("accepts class methods without explicit return type when interface method implies void", () => {
    const source = dedent`
      interface Runner {
        run(step: int)
      }
      class GoodRunner implements Runner {
        run(step: int) {
        }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("incorrectly implements interface"))
    ).toBe(false);
  });

  it("accepts getter shorthand members for implemented interface properties", () => {
    const source = dedent`
      interface Shape {
        area: number
      }
      class Rectangle implements Shape {
        width: number
        height: number
        area: number => this.width * this.height
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("incorrectly implements interface"))
    ).toBe(false);
  });

  it("validates colon interface contracts against own class members", () => {
    const source = dedent`
      interface Shape {
        area: number
        perimeter: number
        describe(): string
      }
      class Rectangle : Shape {
        width: number
        height: number
        area() => this.width * this.height
        perimeter() => 2 * (this.width + this.height)
        describe() => \`Rectangle(\${this.width}x\${this.height})\`
      }
      class Circle : Shape {
        radius: number
        area => Math.PI * radius * radius
        perimeter => 2 * Math.PI * radius
        describe() => \`Circle(r=\${this.radius})\`
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain(
      "Class 'Rectangle' incorrectly implements interface 'Shape'. Property 'area' is of type '() => number' but expected 'number'"
    );
    expect(messages).toContain(
      "Class 'Rectangle' incorrectly implements interface 'Shape'. Property 'perimeter' is of type '() => number' but expected 'number'"
    );
    expect(
      messages.some((message) => message.includes("Class 'Circle' incorrectly implements interface 'Shape'"))
    ).toBe(false);
  });

  it("accepts delegated class interfaces as implemented members", () => {
    const source = dedent`
      interface Shape {
        area: number
        fill(): string
      }
      class BaseShape : Shape {
        area => 12
        fill() => "filled"
      }
      class MyDemo(val shape: Shape) : Shape by { shape } {
      }
      val demoArea = MyDemo(BaseShape()).area
      val filled = MyDemo(BaseShape()).fill()
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("accepts shorthand class methods with explicit return types when implementing interfaces", () => {
    const source = dedent`
      interface Shape {
        describe(): string
      }
      class Rectangle implements Shape {
        width: number
        height: number
        describe(): string => \`Rectangle(\${this.width}x\${this.height})\`
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("accepts shorthand class methods with inferred return types when implementing interfaces", () => {
    const source = dedent`
      interface Shape {
        describe(): string
      }
      class Rectangle implements Shape {
        width: number
        height: number
        describe() => \`Rectangle(\${this.width}x\${this.height})\`
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(
      messages.some((message) => message.includes("incorrectly implements interface"))
    ).toBe(false);
  });

  it("resolves lambda parameters inside lambda scope", () => {
    const source = dedent`
      declare function apply(fn): int
      let x = apply((a, b, c) => a + b + c)
      let y = apply(function(a: int, b: int, c: int) { return a + b + c })
      let z = apply(callable { a, b, c -> a + b + c })
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message === "Undefined variable 'a'")).toBe(false);
    expect(messages.some((message) => message === "Undefined variable 'b'")).toBe(false);
    expect(messages.some((message) => message === "Undefined variable 'c'")).toBe(false);
  });

  it("loads ECMAScript runtime declarations as ambient globals", () => {
    const source = dedent`
      fun demo() {
        let values = [1, 2]
        values.includes(1)
        values.join(",")
        let scores = new Map<string, number>()
        scores.set("ada", Math.max(1, 2))
        console.log(JSON.stringify(scores))
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("resolves static constructor members on ambient runtime globals", () => {
    const source = dedent`
      fun demo() {
        console.log(Date.now())
        console.log(Date.parse("2024-01-01"))
        let d = new Date()
        console.log(d.getTime())
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("does not let a later interface merge clobber a declare var value type", () => {
    const source = dedent`
      interface Widget { paint(): void }
      declare var Widget: WidgetConstructor
      interface WidgetConstructor { create(): Widget }
      interface Widget { resize(): void }
      fun demo() {
        Widget.create()
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("uses declared Array<T> members for T[] alias member resolution", () => {
    const source = dedent`
      declare class Array<T> {
        map<R>(mapper: (item: T) => T): Array<R>
      }
      fun demo() {
        [1,2,3,4].map { it * 2 }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Property 'map' does not exist"))).toBe(false);
    expect(messages.some((message) => message === "Undefined variable 'it'")).toBe(false);
  });

  it("does not require return paths for methods declared inside ambient classes", () => {
    const source = dedent`
      declare class MathConstructor {
        abs(x: number): number
        ceil(x: number): number
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).not.toContain("Not all code paths return a value");
    expect(messages).toEqual([]);
  });



  it("uses TypeScript as assertions as semantic target types", () => {
    const source = dedent`
      let unknownValue: unknown = "Ada"
      let name: string = unknownValue as string
      let unsafe = true as string
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Cannot assign value of type 'unknown' to 'string'"))).toBe(false);
    expect(messages).toContain("Type assertion from 'boolean' to 'string' may be unsafe because neither type is assignable to the other");
  });

  it("narrows nullable unions with TypeScript non-null assertions", () => {
    const source = dedent`
      let maybeName: string | null | undefined = "Ada"
      let name: string = maybeName!
      let stillMaybe: string = maybeName
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string | null | undefined' is not assignable to type 'string'");
    expect(messages.filter((message) => message.includes("is not assignable to type"))).toEqual([
      "Type 'string | null | undefined' is not assignable to type 'string'"
    ]);
  });

  it("treats const assertions as erased assertions that keep the expression type", () => {
    const source = dedent`
      let values = [1, 2] as const
      let count: number = 1 as const
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("binds super in derived class methods for inherited member semantics", () => {
    const source = dedent`
      class Base {
        label(): string { return "base" }
      }
      class Child extends Base {
        label(): string {
          return super.label()
        }
        mismatch(): number {
          let value: number = super.label()
          return value
        }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).not.toContain("Undefined variable 'super'");
    expect(messages).toContain("Type 'string' is not assignable to type 'number'");
  });

  it("validates private and protected class member access", () => {
    const source = dedent`
      class Base {
        private secret: string
        protected token: string
        read() {
          return this.secret
        }
      }
      class Child extends Base {
        readToken() {
          return this.token
        }
      }
      let base: Base
      let child: Child
      base.secret
      base.token
      child.token
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Member 'secret' is private and can only be accessed within class 'Base'");
    expect(messages).toContain("Member 'token' is protected and can only be accessed within class 'Base' or its subclasses");
    expect(messages.filter((message) => message.includes("Member 'token' is protected"))).toHaveLength(2);
  });

  it("analyzes constructor parameter properties as typed readonly members", () => {
    const source = dedent`
      
      class User {
        constructor(public readonly id: string, private age: int) {}
        birthday() {
          this.age = this.age + 1
          this.id = "changed"
        }
      }
      let user = new User("a", 1)
      let id: string = user.id
      let hidden = user.age
      let bad: int = user.id
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Cannot assign to readonly member 'id'");
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Member 'age' is private and can only be accessed within class 'User'");
    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Type 'string' is not assignable to type 'int'");
  });

  it("validates readonly and abstract class member semantics", () => {
    const source = dedent`
      abstract class Base {
        public readonly id: string
        abstract run(): void
        constructor() {
          this.id = "init"
        }
        rename() {
          this.id = "next"
        }
      }
      class Bad {
        abstract missing(): void
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Cannot assign to readonly member 'id'");
    expect(messages).toContain("Abstract member 'missing' can only appear within an abstract class");
    expect(messages).not.toContain("Class method 'run' must have a body");
  });

  it("validates override usage and compatibility against base members", () => {
    const source = dedent`
      class Base {
        value: string
        read(v: int): string {
        }
      }
      class Child extends Base {
        override value: string
        override read(v: int): string {
        }
      }
      class NoBase {
        override name: string
      }
      class Wrong extends Base {
        override missing: int
        override read(v: string): string {
        }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message.includes("Child"))).toBe(false);
    expect(messages).toContain(
      "Member 'name' cannot use 'override' because class 'NoBase' does not extend another class"
    );
    expect(messages).toContain(
      "Member 'missing' cannot override because no member with that name exists in base type 'Base'"
    );
    expect(messages).toContain(
      "Member 'read' override type '(v: string) => string' does not match base type '(v: int) => string'"
    );
  });

  it("reports class method signatures without body as semantic errors", () => {
    const source = dedent`
      class Demo {
        say(): number
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Class method 'say' must have a body");
    expect(messages.some((message) => message.includes("Expected '{' to start class method body"))).toBe(false);
  });

  it("attaches missing implements contract errors to class name node", () => {
    const source = dedent`
      interface Readable {
        say(): number
      }
      class Map implements Readable {
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const issue = analysis
      .getIssues()
      .find((candidate) => candidate.message.includes("Property 'say' is missing"));

    expect(issue).toBeDefined();
    expect(issue?.node.kind).toBe("Identifier");
    expect((issue?.node as { kind: string; name?: string }).name).toBe("Map");
  });

  it("attaches incompatible implements contract errors to member name node", () => {
    const source = dedent`
      interface Readable {
        say(): number
      }
      class Map implements Readable {
        say(): string {
        }
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const issue = analysis
      .getIssues()
      .find((candidate) => candidate.message.includes("incorrectly implements interface"));

    expect(issue).toBeDefined();
    expect(issue?.node.kind).toBe("Identifier");
    expect((issue?.node as { kind: string; name?: string }).name).toBe("say");
  });
  it("checks rest parameters, spread arguments, and optional access types", () => {
    const source = dedent`
      fun collect(label: string, ...values: int[]): int {
        return values[0]
      }
      let numbers: int[] = [1, 2, 3]
      let moreNumbers = [0, ...numbers]
      let ok: int = collect("ok", 1, 2, ...numbers)
      let bad = collect("bad", "wrong")
      interface MaybeRunner {
        run(): int
      }
      let maybe: MaybeRunner | undefined
      let optionalCall = maybe?.run()
      let optionalElement = numbers?.[0]
      let badOptional: int = optionalCall
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = symbolsOfVisibleSymbolsAt(source, 12, 3);

    expect(symbols.get("moreNumbers")?.valueType).toBe("int[]");
    expect(symbols.get("optionalCall")?.valueType).toBe("int | undefined");
    expect(symbols.get("optionalElement")?.valueType).toBe("int | undefined");
    expect(messages).toContain("Argument 2 of type 'string' is not assignable to parameter 'values' of type 'int'");
    expect(messages).toContain("Type 'int | undefined' is not assignable to type 'int'");
  });

  it("reports member access on nullable receivers unless ?. or ! is used", () => {
    const source = dedent`
      interface MaybeRunner {
        run(): MaybeRunner
      }
      let maybe: MaybeRunner | undefined
      let bad = maybe.run().run()
      let ok1 = maybe?.run()
      let ok2 = maybe!.run()
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Object is possibly 'null' or 'undefined'. Use optional access '?.' or a non-null assertion '!'");
    expect(messages.filter((message) => message.includes("Object is possibly 'null' or 'undefined'"))).toHaveLength(1);
  });

  it("reports unknown members inside optional chains after a nullable access narrows to unknown", () => {
    const source = dedent`
      interface NodeLike {
        firstChild: unknown
      }
      interface ElementLike {
        querySelector(value: string): ElementLike | null
        firstChild: NodeLike | null
      }
      let root: ElementLike
      root.querySelector(".demo")?.firstChild?.firstChild2?.test?.lol
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Property 'firstChild2' does not exist on type 'NodeLike | null | undefined'");
    expect(messages).toContain("Property 'test' does not exist on type 'unknown'");
    expect(messages).toContain("Property 'lol' does not exist on type 'unknown'");
  });

  it("infers imported static field types from external class initializers", () => {
    const source = dedent`
      import { Point } from "./geometry.vx"
      Point.origin.x
    `;
    const externalSource = dedent`
      export class Point(val x: int) {
        static origin = Point(0)
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const externalDeclarations = parseFile(tokenizeReader(externalSource)).body;
    const analysis = new Analysis(ast, {
      externalDeclarations,
      importedSymbolTypes: new Map([["Point", namedType("Point")]])
    });

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("uses the local jsx factory return type for jsx expression members", () => {
    const source = dedent`
      fun h(type: any, props: any, ...children: any[]) {
        return { type, props, children }
      }
      const view = <section class="card"><span /></section>
      const fragment = <><span /></>
      const className = view.props.class
      const childType = view.children[0].type
      const fragmentType = fragment.type
    `;

    const ast = parseFile(tokenizeReader(source, { jsx: true }));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const symbols = new Map(analysis.getVisibleSymbolsAt(7, 5).map((symbol) => [symbol.name, symbol]));

    expect(messages).toEqual([]);
    expect(symbols.get("view")?.valueType).toBe("{ type: any, props: any, children: any[] }");
    expect(symbols.get("fragment")?.valueType).toBe("{ type: any, props: any, children: any[] }");
  });

  it("supports variadic runtime Console methods", () => {
    const source = dedent`
      console.log(42, 10, "ok")
      console.error("boom", 1)
      console.warn()
      console.info(true, false)
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("requires rest parameters to use array types", () => {
    const source = dedent`
      declare class Console {
        log(...a: any)
      }
      fun collect(...values: string) {
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Rest parameter 'a' must have an array type");
    expect(messages).toContain("Rest parameter 'values' must have an array type");
  });

  it("binds every identifier introduced by nested destructuring declarations", () => {
    const source = dedent`
      let { id, name :: displayName, nested :: { value = 1 }, ...rest } = source
      const [first, , third = 3, ...tail] = values
      displayName; value; rest; first; third; tail
      first = 4
    `.trimEnd();
    const ast = parseFile(tokenizeReader(source));
    const messages = new Analysis(ast).getIssues().map((issue) => issue.message);

    for (const name of ["id", "displayName", "value", "rest", "first", "third", "tail"]) {
      expect(messages).not.toContain(`Undefined variable '${name}'`);
    }
    expect(messages).toContain("Cannot assign to 'first' because it is a constant");
  });

});


describe("enum semantic analysis", () => {
  it("binds enum declarations and resolves enum member access", () => {
    const source = "enum Direction { Up, Down }\nlet direction: Direction = Direction.Up\n";
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
    const visible = symbolsOfVisibleSymbolsAt(source, 1, 4);
    expect(visible.get("Direction")?.valueType).toBe("Direction");
  });

  it("reports unknown enum members and invalid initializer types", () => {
    const ast = parseFile(tokenizeReader('enum Direction { Up = true }\nlet value = Direction.Missing'));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Enum member 'Up' initializer must be assignable to int or string");
    expect(messages).toContain("Property 'Missing' does not exist on type 'Direction'");
  });

  it("treats imported enum names as enum objects for member access", () => {
    const externalDeclarations = parseFile(tokenizeReader("export enum Color { Red, Green, Blue }")).body;
    const source = 'import { Color } from "./colors"\nlet chosen = Color.Red\nlet missing = Color.Nope\n';
    const analysis = new Analysis(parseFile(tokenizeReader(source)), {
      externalDeclarations,
      importedSymbolTypes: new Map([["Color", namedType("Color")]])
    });
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Property 'Nope' does not exist on type 'Color'");
    expect(messages.filter((message) => message.includes("'Red'"))).toEqual([]);
  });

  it("distinguishes enum name lookups, literal-value lookups, and enum-value lookups", () => {
    const source = dedent`
      enum Direction { Up, Down }
      enum Label { Start = "start", End = "end" }
      let byName = Direction["Up"]
      let byNumericLiteral = Direction[0]
      let byEnumValue = Direction[Direction.Up]
      let stringByName = Label["Start"]
      let stringByValue = Label["start"]
      let stringByEnumValue = Label[Label.Start]
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const visible = symbolsOfVisibleSymbolsAt(source, 6, 4);

    expect(analysis.getIssues()).toEqual([]);
    expect(visible.get("byName")?.valueType).toBe("Direction");
    expect(visible.get("byNumericLiteral")?.valueType).toBe("Direction | undefined");
    expect(visible.get("byEnumValue")?.valueType).toBe("int");
    expect(visible.get("stringByName")?.valueType).toBe("Label");
    expect(visible.get("stringByValue")?.valueType).toBe("Label");
    expect(visible.get("stringByEnumValue")?.valueType).toBe("string");
  });

  it("reports duplicate variable declarations in the same scope", () => {
    const analysis = new Analysis(parseFile(tokenizeReader(dedent`
      let value = 1
      let value = 2
    `)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Duplicate declaration of 'value'");
  });

  it("reports duplicate top-level function signatures in the same file", () => {
    const analysis = new Analysis(parseFile(tokenizeReader(dedent`
      fun example(value: int): string { return "a" }
      fun example(value: int): string { return "b" }
    `)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Duplicate function signature for 'example'");
  });

  it("still allows overloaded top-level functions with different parameter signatures", () => {
    const analysis = new Analysis(parseFile(tokenizeReader(dedent`
      fun describe(value: int): string { return "int" }
      fun describe(value: string): string { return value }
      let a = describe(1)
      let b = describe("ok")
    `)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("does not allow enum-member chaining on enum values", () => {
    const analysis = new Analysis(parseFile(tokenizeReader(dedent`
      enum StrEnum { ADA = "ADA", CPP = "CPP" }
      let value = StrEnum.CPP
      let invalid = value.ADA
    `)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Property 'ADA' does not exist on type 'StrEnum'"
    );
  });

  it("supports bitwise operators on int-backed enum values and enum computed members", () => {
    const source = dedent`
      enum Demo { HELLO = 1, WORLD = 2 }
      enum FileAccess {
        None,
        Read = 1 << 1,
        Write = 1 << 2,
        ReadWrite = Read | Write,
        G = "123".length,
      }
      let combined = Demo.HELLO | Demo.WORLD
      let reverseLookup = FileAccess[FileAccess.ReadWrite]
      let computedReverseLookup = FileAccess[FileAccess.G]
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const visible = symbolsOfVisibleSymbolsAt(source, 10, 4);

    expect(analysis.getIssues()).toEqual([]);
    expect(visible.get("combined")?.valueType).toBe("int");
    expect(visible.get("reverseLookup")?.valueType).toBe("int");
    expect(visible.get("computedReverseLookup")?.valueType).toBe("int");
  });

  it("requires an initializer after a non-numeric-constant enum member", () => {
    const analysis = new Analysis(parseFile(tokenizeReader(dedent`
      enum Bad {
        A = "value",
        B,
      }
    `)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Enum member 'B' must have an initializer because the previous member is not a numeric constant"
    );
  });
  it("resolves unqualified members inside classes and extension members", () => {
    const source = dedent`
      class Counter(val value: int) {
        increment(amount: int): int { return value + amount }
      }
      fun Counter.doubled(): int { return value + value }
      val Counter.next => increment(1)
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues()).toEqual([]);
  });

  it("checks extension properties only when declared or imported", () => {
    const missing = new Analysis(parseFile(tokenizeReader("val duration = 10.milliseconds")));
    expect(missing.getIssues().map((issue) => issue.message)).toContain(
      "Property 'milliseconds' does not exist on type 'int'"
    );

    const local = new Analysis(parseFile(tokenizeReader(
      "class Duration(val value: number)\nval number.milliseconds => Duration(this)\nval duration = 10.milliseconds"
    )));
    expect(local.getIssues()).toEqual([]);

    const imported = new Analysis(parseFile(tokenizeReader(
      'import { milliseconds } from "./duration"\nval duration = 10.milliseconds'
    )));
    expect(imported.getIssues()).toEqual([]);
  });

  it("resolves generic extension methods and properties on Array receivers", () => {
    const analysis = new Analysis(parseFile(tokenizeReader(dedent`
      fun <T> Array<T>.second(): T { return this[1] }
      val <T> Array<T>.doubledLength => length * 2
      let xs: int[] = [10, 20, 30]
      let value: int = xs.second()
      let total: number = xs.doubledLength
    `.trimEnd())));
    expect(analysis.getIssues()).toEqual([]);
  });

  it("checks explicit type annotations on extension properties", () => {
    const ok = new Analysis(parseFile(tokenizeReader(dedent`
      class Duration(val value: number)
      val number.milliseconds: Duration => Duration(this)
      val duration: Duration = 10.milliseconds
    `.trimEnd())));
    expect(ok.getIssues()).toEqual([]);

    const mismatch = new Analysis(parseFile(tokenizeReader(dedent`
      class Duration(val value: number)
      val number.milliseconds: Duration => this
    `.trimEnd())));
    expect(mismatch.getIssues().map((issue) => issue.message)).toContain(
      "Type 'number' is not assignable to type 'Duration'"
    );
  });

  it("infers number for mixed int and number multiplication", () => {
    const source = dedent`
      let a: number = 1
      let b: int = 2
      let leftMixed = a * b
      let rightMixed = b * a
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const symbols = new Map(analysis.getVisibleSymbolsAt(3, 0).map((symbol) => [symbol.name, symbol]));

    expect(analysis.getIssues()).toEqual([]);
    expect(symbols.get("leftMixed")?.valueType).toBe("number");
    expect(symbols.get("rightMixed")?.valueType).toBe("number");
  });


  it("contextually interprets ambiguous brace arguments as lambdas or object literals", () => {
    const source = dedent`
      interface Options { it: int }
      declare function transform(fn: (value: int) => int): int
      declare function consume(options: Options): int
      let it = 4
      let doubled = transform({ it })
      let incremented = transform({ value -> value + 1 })
      let consumed = consume({ it })
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues()).toEqual([]);
  });

  it("smart-casts identifiers in if and else branches for type and range checks", () => {
    const source = dedent`
      class Cat { meow(): int { return 1 } }
      class Dog { bark(): int { return 2 } }
      fun speak(value: Cat | Dog) {
        if (value is Cat) { value.meow() } else { value.bark() }
        if (value instanceof Dog) { value.bark() } else { value.meow() }
      }
      fun classify(value: string | int) {
        if (value in 0 ... 10) { let numberValue: int = value } else { let textValue: string = value }
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues()).toEqual([]);
  });

  it("smart-casts identifiers for 'is' checks when accessing narrowed members", () => {
    const source = dedent`
      class NumberExpr(val value: number) {
        readonly kind = "number"
      }
      class UnaryExpr(val operator: string, val operand: any) {
        readonly kind = "unary"
      }
      function foldConstants(expression: NumberExpr | UnaryExpr): any {
        if (expression is UnaryExpr) {
          expression.operator
          expression.operand
        }
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message === "Property 'operator' does not exist on type 'UnaryExpr'")).toBe(false);
    expect(messages.some((message) => message === "Property 'operand' does not exist on type 'UnaryExpr'")).toBe(false);
  });

  it("smart-casts identifiers for 'instanceof' checks when accessing narrowed members", () => {
    const source = dedent`
      class NumberExpr(val value: number) {
        readonly kind = "number"
      }
      class UnaryExpr(val operator: string, val operand: any) {
        readonly kind = "unary"
      }
      function foldConstants(expression: NumberExpr | UnaryExpr): any {
        if (expression instanceof UnaryExpr) {
          expression.operator
          expression.operand
        }
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message === "Property 'operator' does not exist on type 'UnaryExpr'")).toBe(false);
    expect(messages.some((message) => message === "Property 'operand' does not exist on type 'UnaryExpr'")).toBe(false);
  });

  it("preserves outer smart-casts inside nested conditional blocks", () => {
    const source = dedent`
      class NumberExpr(val value: number) {
        readonly kind = "number"
      }
      class UnaryExpr(val operator: string, val operand: any) {
        readonly kind = "unary"
      }
      function foldConstants(expression: any): any {
        if (expression is UnaryExpr) {
          const operand = foldConstants(expression.operand)
          if (operand is NumberExpr) {
            expression.operator
            expression.operand
          }
        }
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.some((message) => message === "Property 'operator' does not exist on type 'UnaryExpr'")).toBe(false);
    expect(messages.some((message) => message === "Property 'operand' does not exist on type 'UnaryExpr'")).toBe(false);
  });

});

describe("destructured parameter analysis", () => {
  it("binds every identifier introduced by nested parameter patterns", () => {
    const source = "function unpack({ id, nested :: { value = 1 }, ...meta }, [first, , ...tail]) { return id + value + first; meta; tail }";
    const messages = new Analysis(parseFile(tokenizeReader(source))).getIssues().map((issue) => issue.message);
    for (const name of ["id", "value", "meta", "first", "tail"]) {
      expect(messages).not.toContain(`Undefined variable '${name}'`);
    }
  });
});

describe("named call argument analysis", () => {
  it("accepts named arguments matched to their parameters", () => {
    const source = [
      "fun connect(host: string, port: number) {}",
      'connect(port: 8080, host: "localhost")'
    ].join("\n");
    const messages = new Analysis(parseFile(tokenizeReader(source))).getIssues().map((issue) => issue.message);
    expect(messages).toEqual([]);
  });

  it("reports a type mismatch on a named argument value", () => {
    const source = [
      "fun connect(host: string, port: number) {}",
      'connect(host: "localhost", port: "nope")'
    ].join("\n");
    const messages = new Analysis(parseFile(tokenizeReader(source))).getIssues().map((issue) => issue.message);
    expect(messages).toContain("Argument of type 'string' is not assignable to parameter 'port' of type 'number'");
  });

  it("reports an unknown named argument", () => {
    const source = [
      "fun connect(host: string, port: number) {}",
      'connect(host: "localhost", protocol: "https")'
    ].join("\n");
    const messages = new Analysis(parseFile(tokenizeReader(source))).getIssues().map((issue) => issue.message);
    expect(messages).toContain("No parameter named 'protocol'");
  });

  it("reports a missing required parameter when using named arguments", () => {
    const source = [
      "fun connect(host: string, port: number) {}",
      'connect(host: "localhost")'
    ].join("\n");
    const messages = new Analysis(parseFile(tokenizeReader(source))).getIssues().map((issue) => issue.message);
    expect(messages).toContain("Missing required argument for parameter 'port'");
  });

  describe("JSX expression container type checking", () => {
    it("resolves the type of a variable used inside a JSX attribute expression container", () => {
      const source = dedent`
        fun demo() {
          val greeting: string = "hi"
          return <div class={greeting}></div>
        }
      `;
      const analysis = new Analysis(parseFile(tokenizeReader(source, { jsx: true })));
      // line 3 (0-based: 2), column inside `greeting` inside `{greeting}`
      const hover = analysis.getHoverAt(2, 22);
      expect(hover?.contents).not.toContain("unknown");
      expect(hover?.contents).toContain("string");
    });

    it("reports undefined variable inside a JSX attribute expression container", () => {
      const source = dedent`
        fun demo() {
          return <div class={missing}></div>
        }
      `;
      const messages = new Analysis(parseFile(tokenizeReader(source, { jsx: true }))).getIssues().map((i) => i.message);
      expect(messages).toContain("Undefined variable 'missing'");
    });

    it("reports undefined variable inside a JSX child expression container", () => {
      const source = dedent`
        fun demo() {
          return <div>{missing}</div>
        }
      `;
      const messages = new Analysis(parseFile(tokenizeReader(source, { jsx: true }))).getIssues().map((i) => i.message);
      expect(messages).toContain("Undefined variable 'missing'");
    });

    it("reports all component prop diagnostics for destructured parameters", () => {
      const source = dedent`
        fun Page({ name: string, lol: number }) {
          return <h1>{name}</h1>
        }

        const html = <Page name={1} demo="test" name={"test"} />
      `;
      const messages = new Analysis(parseFile(tokenizeReader(source, { jsx: true }))).getIssues().map((i) => i.message);
      expect(messages).toContain("Argument of type 'int' is not assignable to parameter 'name' of type 'string'");
      expect(messages).toContain("No parameter named 'demo'");
      expect(messages).toContain("Missing required argument for parameter 'lol'");
    });

    it("resolves variables visible inside JSX expression containers for autocomplete", () => {
      const source = dedent`
        fun demo() {
          val myVar: string = "x"
          return <div class={myVar}></div>
        }
      `;
      const ast = parseFile(tokenizeReader(source, { jsx: true }));
      const analysis = new Analysis(ast);
      // Position inside the JSX expression container on line 3 (0-based: 2)
      const names = analysis.getVisibleSymbolsAt(2, 22).map((s) => s.name);
      expect(names).toContain("myVar");
    });
  });
});
