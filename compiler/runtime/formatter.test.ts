import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { formatSource } from "./formatter";

describe("formatSource", () => {
  it("keeps named imports on a single line", () => {
    expect(formatSource('import {a,b,c} from "test"')).toBe(
      'import { a, b, c } from "test"'
    );
  });

  it("collapses multi-line named imports back to a single line", () => {
    expect(formatSource('import {\n  a,\n  b\n} from "test"')).toBe(
      'import { a, b } from "test"'
    );
  });

  it("preserves operator named imports without extra spaces", () => {
    expect(formatSource('import { Point, operator+, delay } from "./other"')).toBe(
      'import { Point, operator+, delay } from "./other"'
    );
  });

  it("keeps default, namespace, aliased, type and side-effect imports together", () => {
    const source = [
      'import * as fs from "fs"',
      'import React, { useState as useLocalState } from "react"',
      'import type { Shape } from "./types"',
      'import "./setup"'
    ].join("\n");
    expect(formatSource(source)).toBe(source);
  });

  it("groups consecutive imports and collapses blank lines between them", () => {
    expect(
      formatSource('import { a } from "a"\n\n\nimport { b } from "b"')
    ).toBe('import { a } from "a"\nimport { b } from "b"');
  });

  it("separates the import group from the rest of the code with a blank line", () => {
    expect(formatSource('import { a } from "a"\nconst x=1')).toBe(
      'import { a } from "a"\n\nconst x = 1'
    );
  });

  it("collapses extra blank lines after imports to a single separator", () => {
    expect(formatSource('import { a } from "a"\n\n\n\nconst x=1')).toBe(
      'import { a } from "a"\n\nconst x = 1'
    );
  });

  it("wraps overly long named imports one per line", () => {
    const source =
      'import { aVeryLongName, anotherVeryLongName, yetAnotherLongName, oneMoreLongName } from "./some/very/long/module/path"';
    expect(formatSource(source)).toBe(dedent`
      import {
        aVeryLongName,
        anotherVeryLongName,
        yetAnotherLongName,
        oneMoreLongName,
      } from "./some/very/long/module/path"
    `.trimEnd()
    );
  });

  it("preserves an explicit semicolon on an import statement", () => {
    expect(formatSource('import {a} from "x";')).toBe('import { a } from "x";');
  });

  it("does not treat dynamic import or import.meta as import statements", () => {
    expect(formatSource('const dynamic = import("foo")')).toBe(
      'const dynamic = import("foo")'
    );
  });

  it("formats runtime namespace declarations", () => {
    expect(formatSource("namespace Tools{export const version=1;}")).toBe(
      "namespace Tools {\n  export const version = 1;\n}"
    );
  });

  it("formats ambient namespace declarations and their parsed members", () => {
    expect(formatSource("declare namespace Tools{export const version:string;}")).toBe(
      "declare namespace Tools {\n  export const version: string;\n}"
    );
  });

  it("formats additional ambient declaration forms", () => {
    expect(formatSource("export declare function read(id:string):string;declare type Id=string;"))
      .toBe("export declare function read(id: string): string;\ndeclare type Id = string;");
  });

  it("formats function parameters with optional marker and default value", () => {
    expect(formatSource("fun test(a,v,c?,d:Int=demo){return d}"))
      .toBe("fun test(a, v, c?, d: Int = demo) {\n  return d\n}");
  });

  it("formats function and method shorthand bodies with =>", () => {
    expect(formatSource("fun demo(value:int):int=>value+1"))
      .toBe("fun demo(value: int): int => value + 1");
    expect(formatSource("class Point{operator*(other:Point):Point=>Point(x*other.x,y*other.y)}"))
      .toBe("class Point {\n  operator*(other: Point): Point => Point(x * other.x, y * other.y)\n}");
  });

  it("formats compound accessor blocks with nested accessor indentation", () => {
    expect(formatSource("class Demo{\nvar _x=0.0\nvar x{get{return _x}set{console.log(_x, \"->\", newValue)\n_x=newValue}}}"))
      .toBe(dedent`
        class Demo {
          var _x = 0.0
          var x {
            get {
              return _x
            }
            set {
              console.log(_x, \"->\", newValue)
              _x = newValue
            }
          }
        }
      `.trimEnd());
  });

  it("formats class declaration with field, constructor, and method", () => {
    expect(
      formatSource("class Demo { a=10; constructor(){}; demo(){} }")
    ).toBe(dedent`
      class Demo {
        a = 10;
        constructor() {
        };
        demo() {
        }
      }
    `.trimEnd()
    );
  });

  it("formats program statements with canonical spacing", () => {
    expect(formatSource("let a=1\na+=2\nwhile(a<10)a+=1"))
      .toBe("let a = 1\na += 2\nwhile (a < 10)a += 1");
  });

  it("inserts a blank line between function/class declarations and keeps variable declarations together", () => {
    expect(
      formatSource("let a=1\nlet b=2\nfun a(){}\nclass B{}\nfun c(){}")
    ).toBe(dedent`
      let a = 1
      let b = 2
      
      fun a() {
      }
      
      class B {
      }
      
      fun c() {
      }
    `.trimEnd());
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

  it("preserves template literals after yield", () => {
    expect(formatSource("sync fun * demo(){for(n in 0..<3){yield `${n}`}}")).toBe(
      "sync fun * demo() {\n  for (n in 0 ..< 3) {\n    yield `${n}`\n  }\n}"
    );
  });

  it("formats range operator with binary spacing", () => {
    expect(formatSource("for(a of 0...10)console.log(a)"))
      .toBe("for (a of 0 ... 10)console.log(a)");
  });

  it("formats exclusive range operator with binary spacing", () => {
    expect(formatSource("for(a of 0..<10)console.log(a)"))
      .toBe("for (a of 0 ..< 10)console.log(a)");
  });

  it("keeps generic angle brackets tight while preserving comparison spacing", () => {
    expect(formatSource("let value:Promise<Response>=load()"))
      .toBe("let value: Promise<Response> = load()");
    expect(formatSource("let nested:Outer<inner.Value<Item>>=source"))
      .toBe("let nested: Outer<inner.Value<Item>> = source");
    expect(formatSource("if(a<b>c)return value"))
      .toBe("if (a < b > c)return value");
  });

  it("formats optional type suffix annotations", () => {
    expect(formatSource("let value:any?=input\nlet callback:(()=>void)?=handler"))
      .toBe("let value: any? = input\nlet callback: (() => void)? = handler");
  });

  it("formats switch with case and default", () => {
    expect(formatSource("switch(x){case 1:let y=x;break;default:return 0}"))
      .toBe(dedent`
        switch (x) {
          case 1: let y = x;
          break;
          default: return 0
        }
      `.trimEnd());
  });

  it("formats throw and try/catch/finally statements", () => {
    expect(formatSource("try{throw err}catch(e){throw e}finally{return 0}"))
      .toBe(dedent`
        try {
          throw err
        }
        catch (e) {
          throw e
        }
        finally {
          return 0
        }
      `.trimEnd());
  });

  it("formats defer statements", () => {
    expect(formatSource("defer file.close()"))
      .toBe("defer file.close()");
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
    expect(formatSource("new Stack<number> ()"))
      .toBe("new Stack<number>()");
    expect(formatSource("new hello.world[0].test(arg1,arg2)"))
      .toBe("new hello.world[0].test(arg1, arg2)");
  });

  it("applies binary and unary spacing for plus/minus based on left token", () => {
    expect(
      formatSource(dedent`
        val a = 10+2
        val a = b+2
        val a = (10)+2
        val a = +10
        val a = -10
      `.trimEnd())
    ).toBe(dedent`
      val a = 10 + 2
      val a = b + 2
      val a = (10) + 2
      val a = +10
      val a = -10
    `.trimEnd());
  });

  it("keeps variable declarations grouped and separates function/class declarations with a blank line", () => {
    expect(
      formatSource(dedent`
        var a=10
        var b=20
        fun test()
        class Demo()
      `.trimEnd())
    ).toBe(dedent`
      var a = 10
      var b = 20
      
      fun test()
      
      class Demo()
    `.trimEnd());
  });

  it("preserves one blank line when the input contains extra consecutive newlines", () => {
    expect(formatSource("let a=1\n\n\n\nlet b=2"))
      .toBe("let a = 1\n\nlet b = 2");
  });

  it("does not insert extra blank lines for regular consecutive statements", () => {
    expect(
      formatSource(dedent`
        var b = 20 = 2;
        val a = 10 + 2
        val a = +10
      `.trimEnd())
    ).toBe(dedent`
      var b = 20 = 2;
      val a = 10 + 2
      val a = +10
    `.trimEnd());
  });

  it("does not insert a blank line between a /// doc comment and its function declaration", () => {
    expect(
      formatSource(dedent`
        /// Hello
        fun sample(): int {
          return 0
        }
      `.trimEnd())
    ).toBe(dedent`
      /// Hello
      fun sample(): int {
        return 0
      }
    `.trimEnd());
  });

  it("does not insert a blank line between multiple /// doc comment lines and a function declaration", () => {
    expect(
      formatSource(dedent`
        /// First line
        /// Second line
        fun sample(): int {
          return 0
        }
      `.trimEnd())
    ).toBe(dedent`
      /// First line
      /// Second line
      fun sample(): int {
        return 0
      }
    `.trimEnd());
  });

  it("still inserts a blank line before a /// doc comment that follows a function declaration", () => {
    expect(
      formatSource(dedent`
        fun first() {}
        /// Doc
        fun second() {}
      `.trimEnd())
    ).toBe(dedent`
      fun first() {
      }

      /// Doc
      fun second() {
      }
    `.trimEnd());
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

describe("format brace lambdas", () => {
  it("keeps the parameter header on the same line as the opening brace and breaks after '->'", () => {
    expect(
      formatSource(dedent`
        fun delay(time: TimeSpan) => new Promise { resolve, reject ->
          setTimeout(resolve, time.ms)
        }
      `.trimEnd())
    ).toBe(dedent`
      fun delay(time: TimeSpan) => new Promise { resolve, reject ->
        setTimeout(resolve, time.ms)
      }
    `.trimEnd());
  });

  it("treats '->' as a single token and surrounds it with spaces", () => {
    expect(formatSource("list.map{it->it*2}")).toBe(
      "list.map { it ->\n  it * 2\n}"
    );
  });

  it("keeps a single-parameter lambda header inline", () => {
    expect(formatSource("foo(a, b) { x, y -> x + y }")).toBe(
      "foo(a, b) { x, y ->\n  x + y\n}"
    );
  });

  it("does not treat statement blocks as lambda headers", () => {
    expect(formatSource("function f(a) { return a }")).toBe(
      "function f(a) {\n  return a\n}"
    );
  });
});

describe("format embedded XML / JSX", () => {
  it("preserves a JSX element while normalizing surrounding code", () => {
    expect(formatSource('val   a=<div class="x" id={y}>hi {name}</div>')).toBe(
      'val a = <div class="x" id={y}>hi {name}</div>'
    );
  });

  it("preserves nested and component elements", () => {
    expect(formatSource("val b   =   <Foo.Bar a={1}><Baz/></Foo.Bar>")).toBe(
      "val b = <Foo.Bar a={1}><Baz/></Foo.Bar>"
    );
  });

  it("preserves JSX returned from a function body", () => {
    expect(formatSource("fun render(){\nreturn <ul>{items}</ul>\n}")).toBe(
      "fun render() {\n  return <ul>{items}</ul>\n}"
    );
  });

  it("does not treat a less-than comparison as JSX", () => {
    expect(formatSource("val c = a < b")).toBe("val c = a < b");
  });
});
