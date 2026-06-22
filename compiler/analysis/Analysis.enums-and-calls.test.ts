import { describe, expect, it } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "./Analysis";
import type { AnalysisSymbol } from "./Analysis";
import { namedType } from "./types";
import dedent from "compiler/utils/dedent";
import { parseSource } from "../pipeline/parse";

function symbolsOfVisibleSymbolsAt(source: string, line: number, character: number): Map<string, AnalysisSymbol> {
  const ast = parseFile(tokenizeReader(source));
  const analysis = new Analysis(ast);
  return new Map(analysis.getVisibleSymbolsAt(line, character).map((symbol) => [symbol.name, symbol]));
}

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
      importedSymbols: new Map([["Color", { type: namedType("Color") }]])
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
    expect(visible.get("byNumericLiteral")?.valueType).toBe("Direction?");
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

  it("reports duplicate when async and sync functions share the same effective signature", () => {
    const analysis = new Analysis(parseFile(tokenizeReader(dedent`
      async fun demo(): Promise<int> { return 1 }
      sync fun demo(): int { return 2 }
    `)));

    expect(analysis.getIssues().map((issue) => issue.message)).toContain("Duplicate function signature for 'demo'");
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
      val <T> Array<T>.firstItem: T => this[0]
      val <T> Array<T>.doubledLength => length * 2
      let xs: int[] = [10, 20, 30]
      let first: int = xs.firstItem
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

  it("accepts brace lambdas in ordinary expression positions", () => {
    const source = dedent`
      declare function schedule(task: () => int, delay: int): int
      declare function clearTimeout(timeout: int): void
      declare function useEffect(effect: () => (() => void), inputs: int[]): void
      let count = 0
      useEffect({
        val timeout = schedule({
          count++
        }, 1000)
        return { clearTimeout(timeout) }
      }, [count])
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

    it("treats JSX children as satisfying the children prop", () => {
      const source = dedent`
        fun MyButton({ children: unknown }) {
          return <button>{children}</button>
        }

        const html = <MyButton>hello</MyButton>
      `;
      const messages = new Analysis(parseFile(tokenizeReader(source, { jsx: true }))).getIssues().map((i) => i.message);
      expect(messages).not.toContain("Missing required argument for parameter 'children'");
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

    it("accepts JSX props inherited through imported generic interfaces", () => {
      const source = dedent`
        import { InputHTMLAttributes } from "preact"

        interface HTMLInputElement {
        }

        interface InputProperties extends InputHTMLAttributes<HTMLInputElement> {
          mySpecialProp: any
        }

        const Input = (props: InputProperties) => <input {...props} />
        const html = <Input mySpecialProp="" style="" />
      `;
      const externalSource = dedent`
        export interface HTMLAttributes<T> {
          style?: string
        }

        export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
        }
      `;

      const ast = parseFile(tokenizeReader(source, { jsx: true }));
      const externalDeclarations = parseSource(externalSource, { language: "typescript" }).ast!.body;
      const analysis = new Analysis(ast, { externalDeclarations });
      const messages = analysis.getIssues().map((issue) => issue.message);

      expect(messages).not.toContain("No parameter named 'style'");
    });

    it("treats double-brace JSX callback props as zero-argument lambdas", () => {
      const source = dedent`
        fun MyButton({ onClick: () => void }) {
          return <button onClick={onClick}></button>
        }

        fun App() {
          let count = 0
          return <MyButton onClick={{ count-- }} />
        }
      `;
      const analysis = new Analysis(parseFile(tokenizeReader(source, { jsx: true })));
      expect(analysis.getIssues()).toEqual([]);
    });
  });
});
