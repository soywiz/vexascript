import { describe, expect, it } from "../test/expect";
import { Parser, parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "./Analysis";
import type { AnalysisSymbol } from "./Analysis";
import { typeToString } from "./types";
import type { VarStatement } from "compiler/ast/ast";
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

  it("binds export-as-namespace ambient globals from package typings", () => {
    const ambientSource = dedent`
      export as namespace ReactDOM
      export interface Renderer {
        (element: string, container: Root): void
      }
      export const render: Renderer
      declare interface Root {}
      declare var root: Root
    `;
    const source = `ReactDOM.render("hello", root)`;
    const ambientProgram = parseFile(tokenizeReader(ambientSource), { language: "typescript" });
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: ambientProgram.body });

    expect(analysis.getVisibleSymbolsAt(0, 0).map((symbol) => symbol.name)).toContain("ReactDOM");
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("keeps ambient function declarations callable when a merged namespace follows", () => {
    const ambientSource = dedent`
      declare function setTimeout(callback: (_: void) => void, delay?: number): number
      declare namespace setTimeout {
        export const __promisify__: string
      }
    `;
    const source = `setTimeout(() => {}, 1)`;
    const ambientProgram = parseFile(tokenizeReader(ambientSource), { language: "typescript" });
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: ambientProgram.body });

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("uses string index signatures from ambient interfaces for property access", () => {
    const ambientSource = dedent`
      declare namespace minimist {
        interface ParsedArgs {
          [arg: string]: any
          _: string[]
        }
      }
      declare function minimist(args?: string[]): minimist.ParsedArgs
    `;
    const source = dedent`
      const args = minimist()
      const name = args.name
      const first = args._[0]
    `;
    const ambientProgram = parseFile(tokenizeReader(ambientSource), { language: "typescript" });
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: ambientProgram.body });

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

  it("prefers DOM getter types when a property has both getter and setter accessors", () => {
    const source = dedent`
      declare interface CSSStyleDeclaration {
        background: string
      }
      declare interface ElementCSSInlineStyle {
        get style(): CSSStyleDeclaration
        set style(cssText: string)
      }
      declare interface HTMLElement extends ElementCSSInlineStyle {}
      declare interface HTMLSpanElement extends HTMLElement {}
      declare function createSpan(): HTMLSpanElement

      const span = createSpan()
      span.style.background = "red"
    `;
    const ast = parseFile(tokenizeReader(source), { language: "typescript" });
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).not.toContain(
      "Property 'background' does not exist on type 'string'"
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

  it("uses default generic DOM type arguments for querySelector when none are inferred", async () => {
    const source = 'val app = document.querySelector("#app")\n';
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: (await ensureDomProgram()).body });
    const initializer = (ast.body[0] as VarStatement).initializer!;

    expect(typeToString(analysis.getExpressionTypes().get(initializer)!)).toBe("Element | null");
  });

  it("preserves explicit generic DOM type arguments for querySelector", async () => {
    const source = 'val app = document.querySelector<HTMLDivElement>("#app")\n';
    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast, { ambientDeclarations: (await ensureDomProgram()).body });
    const initializer = (ast.body[0] as VarStatement).initializer!;

    expect(typeToString(analysis.getExpressionTypes().get(initializer)!)).toBe("HTMLDivElement | null");
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

  it("reports parameters that omit an explicit type annotation", () => {
    const source = dedent`
      fun demo(props) {
        return props
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Parameter 'props' must declare an explicit type annotation");
  });

  it("accepts 'this' return types in VexaScript classes and extension methods", () => {
    const source = dedent`
      class Builder {
        fun next(): this {
          return this
        }
      }

      fun Builder.wrap(): this {
        return this.next()
      }

      val builder: Builder = Builder().wrap()
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("accepts 'this' return types in TypeScript classes and interfaces", () => {
    const source = dedent`
      interface Chainable {
        next(): this
      }

      class Builder implements Chainable {
        next(): this {
          return this
        }
      }

      let builder: Builder = new Builder().next()
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source), { language: "typescript" }));

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

  it("types sync generator functions as AsyncGenerator<T> inferred from yield expressions", () => {
    const source = dedent`
      sync fun * demo() {
        yield 10
        yield 20
      }
      val res = demo()
      val ok: AsyncGenerator<int> = res
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("infers string yields through template interpolation in sync generators", () => {
    const source = dedent`
      sync fun * demo() {
        for (n in 0 ..< 3) {
          yield \`\${n}\`
        }
      }
      sync fun sample() {
        val res = demo()
        res
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(analysis.getVisibleSymbolsAt(7, 8).find((symbol) => symbol.name === "res")?.valueType).toBe("AsyncGenerator<string>");
  });

  it("types plain generator functions as Generator<T> inferred from yield expressions", () => {
    const source = dedent`
      fun * values() {
        yield "hello"
      }
      val ok: Generator<string> = values()
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves the element type of AsyncGenerator in for-in loops", () => {
    const source = dedent`
      sync fun * produce() {
        yield 42
      }
      sync fun consume() {
        for (v in produce()) {
          val n: int = v
        }
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
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

  it("checks TypeScript satisfies expressions without changing the expression type", () => {
    const ast = parseFile(tokenizeReader(`let ok: string = "Ada" satisfies string
let stillString: string = ("Ada" satisfies string)
let bad = "Ada" satisfies number
`, { jsx: false }), { language: "typescript" });
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Type 'string' does not satisfy target type 'number'");
    expect(messages).not.toContain("Type 'number' is not assignable to type 'string'");
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
      fun demo(a: int) {
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

  it("infers Promise executor types for new expressions with trailing lambdas", () => {
    const source = dedent`
      let promise = new Promise { resolve, reject ->
        resolve(123)
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(symbolsOfVisibleSymbolsAt(source, 1, 5).get("promise")?.valueType).toBe("Promise<int>");
  });


  it("resolves Promise.resolve(value) to Promise<T> matching the argument type", () => {
    const source = dedent`
      let p: Promise<int> = Promise.resolve(10)
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

  it("allows returning Promise<T> inside sync/async functions with non-Promise return annotation", () => {
    const source = dedent`
      sync fun demo(): int {
        return Promise.resolve(10)
      }
      async function fetchStr(): string {
        return Promise.resolve("hi")
      }
    `;
    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);

    const wrongSource = dedent`
      sync fun bad(): int {
        return Promise.resolve("oops")
      }
    `;
    const wrongAnalysis = new Analysis(parseFile(tokenizeReader(wrongSource)));
    expect(wrongAnalysis.getIssues().map((issue) => issue.message)).toContain(
      "Type 'Promise<string>' is not assignable to return type 'int'"
    );
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

    const optionalSource = dedent`
      let a: { b?: { c: int } } = { b: { c: 1 } }
      a?.b?.c = 20
      let updated: int? = a?.b?.c = 30
    `;
    const optionalAst = parseFile(tokenizeReader(optionalSource));
    const optionalMessages = new Analysis(optionalAst).getIssues().map((issue) => issue.message);
    expect(optionalMessages).not.toContain(
      "Invalid assignment target: left side must be an identifier or member access"
    );
  });

  it("validates increment/decrement operator targets as l-values", () => {
    const ERROR_MSG = "The left-hand side of an increment/decrement operator must be a variable or property access";

    for (const invalid of ["++10", "--10", "+++10", "++++10", "---10", "----10"]) {
      const ast = parseFile(tokenizeReader(invalid));
      const messages = new Analysis(ast).getIssues().map((issue) => issue.message);
      expect(messages, `expected error for: ${invalid}`).toContain(ERROR_MSG);
    }

    for (const valid of ["let a = 1\n++a", "let a = 1\n--a", "let obj = {x: 1}\n++obj.x"]) {
      const ast = parseFile(tokenizeReader(valid));
      const messages = new Analysis(ast).getIssues().map((issue) => issue.message);
      expect(messages, `expected no error for: ${valid}`).not.toContain(ERROR_MSG);
    }

    const optionalAst = parseFile(tokenizeReader("let obj = { x: 1 }\n++obj?.x"));
    const optionalMessages = new Analysis(optionalAst).getIssues().map((issue) => issue.message);
    expect(optionalMessages).toContain(ERROR_MSG);
  });

  it("requires const and val declarations to have an initializer", () => {
    for (const keyword of ["const", "val"]) {
      const astBad = parseFile(tokenizeReader(`${keyword} a: int`));
      const msgsBad = new Analysis(astBad).getIssues().map((i) => i.message);
      expect(msgsBad, `${keyword} without initializer`).toContain(`'${keyword}' declarations must be initialized`);

      const astGood = parseFile(tokenizeReader(`${keyword} a = 1`));
      const msgsGood = new Analysis(astGood).getIssues().map((i) => i.message);
      expect(msgsGood, `${keyword} with initializer`).not.toContain(`'${keyword}' declarations must be initialized`);
    }

    // declare const is exempt (TypeScript mode)
    const astDeclareConst = parseFile(tokenizeReader("declare const a: int"), { language: "typescript" });
    expect(new Analysis(astDeclareConst).getIssues().map((i) => i.message)).not.toContain("'const' declarations must be initialized");

    // declare val is exempt (VexaScript mode)
    const astDeclareVal = parseFile(tokenizeReader("declare val a: int"));
    expect(new Analysis(astDeclareVal).getIssues().map((i) => i.message)).not.toContain("'val' declarations must be initialized");
  });

  it("requires var declarations to have an explicit type when not initialized", () => {
    const astBad = parseFile(tokenizeReader("var a"));
    const msgsBad = new Analysis(astBad).getIssues().map((i) => i.message);
    expect(msgsBad).toContain("Variable 'a' implicitly has an 'any' type");

    // with type annotation — ok
    const astType = parseFile(tokenizeReader("var a: int"));
    const msgsType = new Analysis(astType).getIssues().map((i) => i.message);
    expect(msgsType).not.toContain("Variable 'a' implicitly has an 'any' type");

    // with initializer — ok
    const astInit = parseFile(tokenizeReader("var a = 1"));
    const msgsInit = new Analysis(astInit).getIssues().map((i) => i.message);
    expect(msgsInit).not.toContain("Variable 'a' implicitly has an 'any' type");

    // declare var is exempt
    const astDeclare = parseFile(tokenizeReader("declare var a"), { language: "typescript" });
    const msgsDeclare = new Analysis(astDeclare).getIssues().map((i) => i.message);
    expect(msgsDeclare).not.toContain("Variable 'a' implicitly has an 'any' type");
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

  it("validates tuple delegate shape: empty, wrong element count, non-function setter, type mismatch", () => {
    function issues(src: string) {
      return new Analysis(parseFile(tokenizeReader(src))).getIssues().map((i) => i.message);
    }

    // [] — empty tuple
    expect(issues("fun f() => []\nvar a by f()")).toContain("Property delegate tuple must not be empty");

    // [value] — single-element getter: valid, no error
    expect(issues("fun f() => [1]\nvar a by f()")).not.toContain("Property delegate tuple must not be empty");
    expect(issues("fun f() => [1]\nvar a by f()")).not.toContain("Second element of property delegate tuple must be a setter function, got 'int'");

    // [a, b] where b is not a function — invalid setter
    expect(issues("fun f() => [1, 2]\nvar a by f()")).toContain(
      "Second element of property delegate tuple must be a setter function, got 'int'"
    );

    // [a, b, c] — too many elements
    expect(issues("fun f() => [1, 2, 3]\nvar a by f()")).toContain(
      "Property delegate tuple must have 1 or 2 elements, got 3"
    );

    // [value, setter] with matching types: valid
    expect(issues(`fun f() => ["test", (value: string) => {}]\nvar a by f()`)).not.toContain(
      "Getter type 'string' is not assignable to setter parameter type 'string'"
    );

    // [value, setterAlias] where setter is a callable type alias: valid
    expect(issues(
      "type Dispatch<T> = (value: T) => void\nfun f(): [int, Dispatch<int>] => [1, (value: int) => {}]\nvar a by f()"
    )).not.toContain(
      "Second element of property delegate tuple must be a setter function, got 'Dispatch<int>'"
    );

    // [value, setter] with mismatched types: invalid
    expect(issues("fun f() => [1, (value: string) => {}]\nvar a by f()")).toContain(
      "Getter type 'int' is not assignable to setter parameter type 'string'"
    );

    // [getter fn, setter] with matching types: valid
    expect(issues(`fun f() => [() => "test", (value: string) => {}]\nvar a by f()`)).not.toContain(
      "Getter type 'string' is not assignable to setter parameter type 'string'"
    );

    // [getter fn, setter] with mismatched types: invalid
    expect(issues("fun f() => [() => 10, (value: string) => {}]\nvar a by f()")).toContain(
      "Getter type 'int' is not assignable to setter parameter type 'string'"
    );
  });

  it("reports read access to setter-only class property as an error", () => {
    const source = dedent`
      class Demo {
        set value(v: int) {}
      }
      var demo = Demo()
      demo.value
    `;
    const ast = parseFile(tokenizeReader(source));
    const messages = new Analysis(ast).getIssues().map((i) => i.message);
    expect(messages).toContain("Property 'value' on type 'Demo' has no getter");
  });

  it("allows write access to setter-only class property", () => {
    const source = dedent`
      class Demo {
        set value(v: int) {}
      }
      var demo = Demo()
      demo.value = 10
    `;
    const ast = parseFile(tokenizeReader(source));
    const messages = new Analysis(ast).getIssues().map((i) => i.message);
    expect(messages).not.toContain("Property 'value' on type 'Demo' has no getter");
  });

  it("allows read access when both getter and setter are defined", () => {
    const source = dedent`
      class Demo {
        get value(): int { return 1 }
        set value(v: int) {}
      }
      var demo = Demo()
      demo.value
    `;
    const ast = parseFile(tokenizeReader(source));
    const messages = new Analysis(ast).getIssues().map((i) => i.message);
    expect(messages).not.toContain("Property 'value' on type 'Demo' has no getter");
  });

  it("rejects named-type delegate with setter-only value property", () => {
    const source = dedent`
      class SetterOnly {
        set value(v: int) {}
      }
      var x by SetterOnly()
    `;
    const ast = parseFile(tokenizeReader(source));
    const messages = new Analysis(ast).getIssues().map((i) => i.message);
    expect(messages).toContain("Type 'SetterOnly' is not a valid property delegate; property 'value' has no getter");
  });

  it("accepts named-type delegate with object value property", () => {
    const source = dedent`
      fun makeState() => { value: 10 }
      var x by makeState()
    `;
    const ast = parseFile(tokenizeReader(source));
    const messages = new Analysis(ast).getIssues().map((i) => i.message);
    expect(messages).not.toContain("Type 'makeState' is not a valid property delegate");
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
    expect(symbols.get("point")?.valueType).toBe("{ x: int, label: string? }");
    expect(messages).toContain("Type 'int' is not assignable to return type 'string'");
    expect(messages).toContain("Type '{ x: int, label: int }' is not assignable to type '{ x: int, label: string }'");
  });

  it("supports optional type suffix annotations as sugar for '| undefined'", () => {
    const source = dedent`
      let maybe: string? = "ok"
      maybe = undefined
      maybe = 1
      let callback: (() => void)? = undefined
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const symbols = new Map(analysis.getVisibleSymbolsAt(3, 5).map((symbol) => [symbol.name, symbol]));
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(symbols.get("maybe")?.valueType).toBe("string?");
    expect(symbols.get("callback")?.valueType).toBe("(() => void)?");
    expect(messages).toContain("Type 'int' is not assignable to type 'string?'");
  });

  it("accepts required object properties where the target property type is optional", () => {
    const source = dedent`
      let point: { x: int, label: string? } = { x: 1, label: "ok" }
      let clock: { time: number? } = { time: Date.now() }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("accepts assigning defined values to optional class fields through this", () => {
    const source = dedent`
      declare class Component {}

      class Clock extends Component {
        var timer: number? = 10

        constructor() {
          super()
          this.timer = 10
          this.timer = undefined
          timer = 10
        }
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
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

  it("reports unknown types in primary constructor parameters", () => {
    const source = "class Vec2(val x: number2, val y: number)\n";
    const analysis = new Analysis(parseFile(tokenizeReader(source)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Unknown type 'number2'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter"
    );
  });

  it("checks extension properties declared with accessor blocks", () => {
    const source = dedent`
      class Vec2(val x: number, val y: number)
      class View(var x: number, var y: number)
      var View.point: Vec2 {
        get => Vec2(x, y)
        set { x = newValue.x; y = newValue.y }
      }
      val view = View(1, 2)
      val point: Vec2 = view.point
      view.point = Vec2(3, 4)
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues()).toEqual([]);
  });

  it("allows interface receiver accessors to see members inherited from implementing classes", () => {
    const source = dedent`
      class Vec2(val x: number, val y: number)
      interface View {}
      class Container(var x: number, var y: number)
      class Sprite extends Container implements View
      var View.point: Vec2 {
        get => Vec2(x, y)
        set { x = newValue.x; y = newValue.y }
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).not.toContain("Undefined variable 'x'");
    expect(messages).not.toContain("Undefined variable 'y'");
  });

  it("reports unknown receiver types on extension property declarations", () => {
    const source = dedent`
      class Vec2(val x: number, val y: number)
      var View2.point: Vec2 {
        get => Vec2(x, y)
      }
    `;

    const analysis = new Analysis(parseFile(tokenizeReader(source)));
    expect(analysis.getIssues().map((issue) => issue.message)).toContain(
      "Unknown type 'View2'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface/type parameter"
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

  it("applies default generic type arguments when classes are called without new", () => {
    const source = dedent`
      interface Renderer {
        resize(width: number, height: number): void
      }

      class App<R = Renderer>(val renderer: R)

      let app = App({ resize(width: number, height: number) {} })
      app.renderer.resize(100, 200)
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const symbols = symbolsOfVisibleSymbolsAt(source, 6, 4);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
    expect(symbols.get("app")?.valueType).toBe("App<Renderer>");
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

  it("reports missing explicit constructor arguments for class calls and new expressions", () => {
    const source = dedent`
      class Demo2 {
        constructor(x: number, y: number) {
        }
      }
      fun demo() {
        new Demo2()
        Demo2()
      }

`;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages.filter((message) => message === "Expected at least 2 argument(s), but got 0")).toHaveLength(2);
  });

  it("reports constructor argument type mismatches for class calls without new", () => {
    const source = dedent`
      class Demo(val a: number, val b: string)
      Demo(10, 10)
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Argument 2 of type 'int' is not assignable to parameter 'b' of type 'string'");
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

  it("propagates 'any' through member access expressions", () => {
    const source = dedent`
      fun demo(props: any) {
        const direct = props.style
        const computed = props["style"]
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const demo = ast.body[0] as import("../ast/ast.js").FunctionStatement;
    const directType = analysis.getExpressionTypes().get(
      (demo.body.body[0] as import("../ast/ast.js").VarStatement).initializer!
    );
    const computedType = analysis.getExpressionTypes().get(
      (demo.body.body[1] as import("../ast/ast.js").VarStatement).initializer!
    );

    expect(messages.some((message) => message.includes("does not exist on type 'any'"))).toBe(false);
    expect(directType?.kind === "builtin" && directType.name).toBe("any");
    expect(computedType?.kind === "builtin" && computedType.name).toBe("any");
  });

  it("allows calling members reached through 'any'", () => {
    const source = dedent`
      fun demo(props: any) {
        return props.render()
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);
    const callType = analysis.getExpressionTypes().get(
      ((ast.body[0] as import("../ast/ast.js").FunctionStatement).body.body[0] as import("../ast/ast.js").ReturnStatement)
        .expression!
    );

    expect(messages.some((message) => message.includes("not callable"))).toBe(false);
    expect(callType?.kind === "builtin" && callType.name).toBe("any");
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

});
