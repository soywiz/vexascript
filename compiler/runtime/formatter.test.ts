import { describe, expect, it } from "vitest";
import { formatSource } from "./formatter";

describe("formatSource", () => {
  it("formats function parameters with optional marker and default value", () => {
    expect(formatSource("fun test(a,v,c?,d:Int=demo){return d}"))
      .toBe("fun test(a, v, c?, d: Int = demo) {\n  return d;\n}");
  });

  it("formats class declaration with field, constructor, and method", () => {
    expect(
      formatSource("class Demo { a=10; constructor(){}; demo(){} }")
    ).toBe(
      "class Demo {\n" +
        "  a = 10;\n" +
        "\n" +
        "  constructor() {\n" +
        "  }\n" +
        "\n" +
        "  demo() {\n" +
        "  }\n" +
        "}"
    );
  });

  it("formats program statements with canonical spacing and semicolons", () => {
    expect(formatSource("let a=1\na+=2\nwhile(a<10)a+=1"))
      .toBe("let a = 1;\na += 2;\nwhile (a < 10)\n  a += 1;");
  });

  it("inserts a blank line between function/class declarations and keeps variable declarations together", () => {
    expect(
      formatSource("let a=1\nlet b=2\nfun a(){}\nclass B{}\nfun c(){}")
    ).toBe(
      "let a = 1;\n" +
        "let b = 2;\n" +
        "fun a() {\n" +
        "}\n" +
        "\n" +
        "class B {\n" +
        "}\n" +
        "\n" +
        "fun c() {\n" +
        "}"
    );
  });

  it("keeps unicode escape sequences in string literals", () => {
    expect(formatSource("let a = b.c[\"d\\n\\uaa00\"].dddd"))
      .toBe("let a = b.c[\"d\\n\\uaa00\"].dddd;");
  });

  it("formats class primary constructor parameters", () => {
    expect(formatSource("class Point(val x:number,val y:number){}"))
      .toBe("class Point(val x: number, val y: number) {\n}");
  });

  it("formats for statements with declaration initializer", () => {
    expect(formatSource("for(let i=0;i<3;i+=1){let x=i}"))
      .toBe("for (let i = 0; i < 3; i += 1) {\n  let x = i;\n}");
  });

  it("formats if-else statements", () => {
    expect(formatSource("if(a<1){let b=2}else return b"))
      .toBe("if (a < 1) {\n  let b = 2;\n} else\n  return b;");
  });

  it("formats prefix and postfix increment/decrement", () => {
    expect(formatSource("++a\na--"))
      .toBe("++a;\na--;");
  });

  it("formats shift and equality operators", () => {
    expect(formatSource("a<<1\nb>>=2\nc===d\nx!=y"))
      .toBe("a << 1;\nb >>= 2;\nc === d;\nx != y;");
  });
});
