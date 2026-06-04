import { describe, expect, it } from "vitest";
import { formatSource } from "./formatter";

describe("formatSource", () => {
  it("formats ambient namespace declarations and their parsed members", () => {
    expect(formatSource("declare namespace Tools{export const version:string;}")).toBe(
      "declare namespace Tools {\n  export const version: string;\n}"
    );
  });

  it("formats function parameters with optional marker and default value", () => {
    expect(formatSource("fun test(a,v,c?,d:Int=demo){return d}"))
      .toBe("fun test(a, v, c?, d: Int = demo) {\n  return d\n}");
  });

  it("formats class declaration with field, constructor, and method", () => {
    expect(
      formatSource("class Demo { a=10; constructor(){}; demo(){} }")
    ).toBe(
      "class Demo {\n" +
        "  a = 10;\n" +
        "  constructor() {\n" +
        "  };\n" +
        "  demo() {\n" +
        "  }\n" +
        "}"
    );
  });

  it("formats program statements with canonical spacing", () => {
    expect(formatSource("let a=1\na+=2\nwhile(a<10)a+=1"))
      .toBe("let a = 1\na += 2\nwhile (a < 10)a += 1");
  });

  it("inserts a blank line between function/class declarations and keeps variable declarations together", () => {
    expect(
      formatSource("let a=1\nlet b=2\nfun a(){}\nclass B{}\nfun c(){}")
    ).toBe(
      "let a = 1\n" +
        "let b = 2\n" +
        "\n" +
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
      .toBe("let a = b.c[\"d\\n\\uaa00\"].dddd");
  });

  it("formats TypeScript constructor parameter properties", () => {
    expect(formatSource("class User{constructor(public readonly id:string,private age:int=0){}}"))
      .toBe("class User {\n  constructor(public readonly id: string, private age: int = 0) {\n  }\n}");
  });

  it("formats class primary constructor parameters", () => {
    expect(formatSource("class Point(val x:number,val y:number){}"))
      .toBe("class Point(val x: number, val y: number) {\n}");
  });

  it("formats class declarations without braces", () => {
    expect(formatSource("class Point"))
      .toBe("class Point");
    expect(formatSource("class Point(val x:number,val y:number)"))
      .toBe("class Point(val x: number, val y: number)");
  });

  it("formats for statements with declaration initializer", () => {
    expect(formatSource("for(let i=0;i<3;i+=1){let x=i}"))
      .toBe("for (let i = 0; i < 3; i += 1) {\n  let x = i\n}");
  });

  it("formats if-else statements", () => {
    expect(formatSource("if(a<1){let b=2}else return b"))
      .toBe("if (a < 1) {\n  let b = 2\n} else return b");
  });

  it("formats prefix and postfix increment/decrement", () => {
    expect(formatSource("++a\na--"))
      .toBe("++a\na--");
  });

  it("formats shift and equality operators", () => {
    expect(formatSource("a<<1\nb>>=2\nc===d\nx!=y"))
      .toBe("a << 1\nb >>= 2\nc === d\nx != y");
  });

  it("formats nullish, unary word operators, and ternary", () => {
    expect(
      formatSource("a??b\nx??=y\ntypeof a\nvoid a\ndelete a.b\nawait x\na?b:c")
    ).toBe(
      "a ?? b\nx ??= y\ntypeof a\nvoid a\ndelete a.b\nawait x\na ? b : c"
    );
  });

  it("formats range operator with binary spacing", () => {
    expect(formatSource("for(a of 0...10)console.log(a)"))
      .toBe("for (a of 0 ... 10)console.log(a)");
  });

  it("formats switch with case and default", () => {
    expect(formatSource("switch(x){case 1:let y=x;break;default:return 0}"))
      .toBe(
        "switch (x) {\n" +
        "  case 1: let y = x;\n" +
        "  break;\n" +
        "  default: return 0\n" +
        "}"
      );
  });

  it("formats throw and try/catch/finally statements", () => {
    expect(formatSource("try{throw err}catch(e){throw e}finally{return 0}"))
      .toBe(
        "try {\n" +
        "  throw err\n" +
        "}\n" +
        "catch (e) {\n" +
        "  throw e\n" +
        "}\n" +
        "finally {\n" +
        "  return 0\n" +
        "}"
      );
  });

  it("formats chained function calls", () => {
    expect(formatSource("hello.world[0].test(arg1,arg2)"))
      .toBe("hello.world[0].test(arg1, arg2)");
  });

  it("formats new expression variants", () => {
    expect(formatSource("new instance()"))
      .toBe("new instance()");
    expect(formatSource("new instance"))
      .toBe("new instance");
    expect(formatSource("new hello.world[0].test(arg1,arg2)"))
      .toBe("new hello.world[0].test(arg1, arg2)");
  });

  it("applies binary and unary spacing for plus/minus based on left token", () => {
    expect(
      formatSource(
        "val a = 10+2\n" +
        "val a = b+2\n" +
        "val a = (10)+2\n" +
        "val a = +10\n" +
        "val a = -10"
      )
    ).toBe(
      "val a = 10 + 2\n" +
      "val a = b + 2\n" +
      "val a = (10) + 2\n" +
      "val a = +10\n" +
      "val a = -10"
    );
  });

  it("keeps variable declarations grouped and separates function/class declarations with a blank line", () => {
    expect(
      formatSource(
        "var a=10\n" +
        "var b=20\n" +
        "fun test()\n" +
        "class Demo()"
      )
    ).toBe(
      "var a = 10\n" +
      "var b = 20\n" +
      "\n" +
      "fun test()\n" +
      "\n" +
      "class Demo()"
    );
  });

  it("preserves one blank line when the input contains extra consecutive newlines", () => {
    expect(formatSource("let a=1\n\n\n\nlet b=2"))
      .toBe("let a = 1\n\nlet b = 2");
  });

  it("does not insert extra blank lines for regular consecutive statements", () => {
    expect(
      formatSource(
        "var b = 20 = 2;\n" +
        "val a = 10 + 2\n" +
        "val a = +10"
      )
    ).toBe(
      "var b = 20 = 2;\n" +
      "val a = 10 + 2\n" +
      "val a = +10"
    );
  });

  it("keeps scientific notation literals without splitting exponent sign", () => {
    expect(formatSource("let a=10e-3\nlet b=10.573"))
      .toBe("let a = 10e-3\nlet b = 10.573");
  });

  it("keeps bigint and long literal suffixes attached to numbers", () => {
    expect(formatSource("let a=10n+20n\nlet b=10L+20L"))
      .toBe("let a = 10n + 20n\nlet b = 10L + 20L");
  });

  it("formats regular expression literals without treating slashes as division", () => {
    expect(formatSource("let re=/a\\/b+/gi\nlet quotient=total/count")).toBe(
      "let re = /a\\/b+/gi\nlet quotient = total / count"
    );
  });
  it("formats object and array destructuring declarations", () => {
    expect(formatSource("let{id,name:display,...rest}=source\nconst[first,,third=3,...tail]=values")).toBe(
      "let { id, name: display, ...rest } = source\nconst [first, , third = 3, ...tail] = values"
    );
  });

});


describe("format enum declarations", () => {
  it("formats enum members and keeps declaration spacing", () => {
    expect(formatSource('enum Direction{Up,Down=4,Right="right"}'))
      .toBe('enum Direction {\n  Up, Down = 4, Right = "right"\n}');
  });
});

describe("format destructured parameters", () => {
  it("formats object and array parameter patterns", () => {
    expect(formatSource("function unpack({id,nested:{value=1},...meta},[first,,...tail]=values){return value}"))
      .toBe("function unpack({\n  id, nested: {\n    value = 1\n  }, ...meta\n}, [first, , ...tail] = values) {\n  return value\n}");
  });
});
