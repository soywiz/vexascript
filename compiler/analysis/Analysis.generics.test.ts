import { describe, expect, it } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { Analysis } from "./Analysis";
import type { AnalysisSymbol } from "./Analysis";
import { namedType } from "./types";
import dedent from "compiler/utils/dedent";

function symbolsOfVisibleSymbolsAt(source: string, line: number, character: number): Map<string, AnalysisSymbol> {
  const ast = parseFile(tokenizeReader(source));
  const analysis = new Analysis(ast);
  return new Map(analysis.getVisibleSymbolsAt(line, character).map((symbol) => [symbol.name, symbol]));
}

describe("Analysis", () => {
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

  it("rejects explicit type arguments on non-generic calls and when too many are supplied", () => {
    const source = dedent`
      fun App() {
      }
      fun useState<S>(initialState: S): S {
        return initialState
      }
      fun useRef<T>() {
      }
      App<int>()
      useState<number, int>(0)
      useRef<string, number, number>()
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toContain("Expected at most 0 type argument(s), but got 1");
    expect(messages).toContain("Expected at most 1 type argument(s), but got 2");
    expect(messages).toContain("Expected at most 1 type argument(s), but got 3");
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

  it("expands mapped aliases whose property values use conditional branches", () => {
    const source = dedent`
      interface Color {
        red: number
      }
      type ColorRepresentation = Color | string | number
      type MapColorProperties<T> = {
        [P in keyof T]: T[P] extends Color ? ColorRepresentation : T[P]
      }
      interface MaterialProperties {
        color: Color
        roughness: number
        metalness: number
      }
      interface MaterialParameters extends Partial<MapColorProperties<MaterialProperties>> {}
      let ok: MaterialParameters = {
        color: "#44bce9",
        roughness: 0.28,
        metalness: 0.12
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);
    const messages = analysis.getIssues().map((issue) => issue.message);

    expect(messages).toEqual([]);
  });

  it("resolves common TypeScript utility aliases beyond Partial and Pick", () => {
    const source = dedent`
      type WithoutNulls = NonNullable<string | null | undefined>
      type LoadingState = Exclude<"idle" | "loading" | "done", "idle">
      type FinalState = Extract<"idle" | "loading" | "done", "done" | "error">
      type Labels = Record<"title" | "subtitle", string>
      type Config = Readonly<{ theme: string, retries: int }>
      type Settled = Awaited<Promise<Promise<string>>>
      type Fn = (name: string, count: int) => boolean
      type FnReturn = ReturnType<Fn>
      type FnParameters = Parameters<Fn>

      let withoutNulls: WithoutNulls = "Ada"
      let loading: LoadingState = "loading"
      let final: FinalState = "done"
      let labels: Labels = { title: "Hello", subtitle: "World" }
      let config: Config = { theme: "light", retries: 3 }
      let settled: Settled = "ok"
      let fnReturn: FnReturn = true
      let fnParameters: FnParameters = ["Ada", 1]
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves constructor and this-parameter utility aliases", () => {
    const source = dedent`
      class User {
        constructor(name: string, age: int) {}
      }

      type UserCtorArgs = ConstructorParameters<User>
      type UserInstance = InstanceType<User>
      type Method = (this: User, value: string) => boolean
      type Receiver = ThisParameterType<Method>
      type BoundMethod = OmitThisParameter<Method>

      let ctorArgs: UserCtorArgs = ["Ada", 1]
      let user: UserInstance = new User("Ada", 1)
      let receiver: Receiver = user
      let bound: BoundMethod = (value: string) => true
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves identity and string-transform utility aliases", () => {
    const source = dedent`
      type Literal = "hello world"
      type Alias = NoInfer<Literal>
      type Context = ThisType<{ name: string }>
      type Loud = Uppercase<Literal>
      type Quiet = Lowercase<"HELLO WORLD">
      type Title = Capitalize<"hello">
      type Camel = Uncapitalize<"Hello">

      let alias: Alias = "hello world"
      let context: Context = { name: "Ada" }
      let loud: Loud = "HELLO WORLD"
      let quiet: Quiet = "hello world"
      let title: Title = "Hello"
      let camel: Camel = "hello"
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves template literal types from literal unions and wide strings conservatively", () => {
    const source = dedent`
      type Prefix = "pre"
      type Event = "click" | "focus"
      type EventName = \`\${Prefix}:\${Event}\`
      type DynamicEventName = \`\${string}:\${Event}\`

      let click: EventName = "pre:click"
      let focus: EventName = "pre:focus"
      let dynamic: DynamicEventName = "anything:click"
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves readonly array and tuple shorthand types", () => {
    const source = dedent`
      type ReadonlyNames = readonly string[]
      type ReadonlyPair = readonly [name: string, count: int]
      type First<T extends ReadonlyArray<unknown>> = T[number]

      let names: ReadonlyNames = ["Ada", "Grace"]
      let pair: ReadonlyPair = ["Ada", 1]
      let arrayLike: ReadonlyArray<string> = names
      let firstName: First<ReadonlyNames> = "Ada"
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("treats readonly arrays and tuples as non-mutable targets", () => {
    const source = dedent`
      type ReadonlyNames = readonly string[]
      type ReadonlyPair = readonly [name: string, count: int]

      let mutableNames: string[] = ["Ada"]
      let readonlyNames: ReadonlyNames = mutableNames
      let mutableFromReadonly: string[] = readonlyNames

      let readonlyPair: ReadonlyPair = ["Ada", 1]
      readonlyNames[0] = "Grace"
      readonlyPair[1]++
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([
      "Type 'readonly string[]' is not assignable to type 'string[]'",
      "Cannot assign through readonly index access",
      "Cannot assign through readonly index access"
    ]);
  });

  it("treats Readonly and mapped readonly object properties as non-mutable targets", () => {
    const source = dedent`
      type User = { id: int, name?: string }
      type FrozenUser = Readonly<User>
      type Freeze<T> = { readonly [K in keyof T]: T[K] }
      type FrozenViaMapped = Freeze<User>
      type MutableAgain = { -readonly [K in keyof FrozenViaMapped]-?: FrozenViaMapped[K] }

      let frozenUser: FrozenUser = { id: 1, name: "Ada" }
      let frozenViaMapped: FrozenViaMapped = { id: 2 }
      let mutableAgain: MutableAgain = { id: 3, name: "Grace" }
      let exactUser: { id: int, name: string } = mutableAgain

      frozenUser.id = 2
      frozenViaMapped["id"] = 4
      mutableAgain.id = 5
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([
      "Cannot assign to readonly member 'id'",
      "Cannot assign to readonly member 'id'"
    ]);
  });

  it("resolves top-level conditional aliases that use common infer patterns", () => {
    const source = dedent`
      type Element<T> = T extends (infer U)[] ? U : T
      type AwaitedValue<T> = T extends Promise<infer U> ? U : T
      type Result<T> = T extends (...args: any) => infer R ? R : never

      type Handler = (name: string, count: int) => boolean

      let element: Element<string[]> = "Ada"
      let awaitedValue: AwaitedValue<Promise<int>> = 1
      let result: Result<Handler> = true
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves constrained infer, nested conditional branches, and distributive conditional aliases", () => {
    const source = dedent`
      type Constrained<T> = T extends infer U extends string ? U : never
      type Recursive<T> = T extends string ? true : T extends number ? false : never
      type Dist<T> = T extends string ? "text" : "other"

      let constrained: Constrained<"Ada"> = "Ada"
      let recursiveString: Recursive<string> = true
      let recursiveNumber: Recursive<int> = false
      let distributiveText: Dist<string | int> = "text"
      let distributiveOther: Dist<string | int> = "other"
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves mapped aliases that remap, filter, and concretize keys", () => {
    const source = dedent`
      interface Person {
        name: string
        age: int
      }
      interface MaybePerson {
        name?: string
      }
      type Labels<T> = { [K in keyof T as \`label_\${K}\`]: T[K] }
      type WithoutName<T> = { [K in keyof T as Exclude<K, "name">]: T[K] }
      type Concrete<T> = { [K in keyof T as K]-?: T[K] }

      let labels: Labels<Person> = { label_name: "Ada", label_age: 1 }
      let labelName: string = labels.label_name
      let onlyAge: WithoutName<Person> = { age: 1 }
      let age: int = onlyAge.age
      let concrete: Concrete<MaybePerson> = { name: "Ada" }
      let concreteName: string = concrete.name
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("resolves unique symbol, assertion signatures, and abstract constructor signatures", () => {
    const source = dedent`
      class User {
        constructor(name: string, age: int) {}
      }
      type Token = unique symbol
      type AssertString = (value: unknown) => asserts value is string
      type UserCtorArgs = ConstructorParameters<abstract new (name: string, age: int) => User>
      type UserInstance = InstanceType<abstract new (name: string, age: int) => User>

      let token: Token = Symbol.iterator
      let assertString: AssertString = (value: unknown) => {}
      let args: UserCtorArgs = ["Ada", 1]
      let user: UserInstance = new User("Ada", 1)
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("narrows identifiers after local assertion-signature calls", () => {
    const source = dedent`
      fun assertString(value: unknown): asserts value is string {}

      let maybe: unknown = "Ada"
      assertString(maybe)
      let ok: string = maybe
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("narrows stable member expressions after local assertion-signature calls", () => {
    const source = dedent`
      fun assertPresent(value: string?): asserts value {}

      let box: { item: string? } = { item: "Ada" }
      assertPresent(box.item)
      let ok: string = box.item
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("narrows nullable values after local generic bare assertion-signature calls", () => {
    const source = dedent`
      fun assertPresent<T>(value: T): asserts value {}

      let maybeHeadline: string? = "Ready"
      assertPresent(maybeHeadline)
      let okHeadline: string = maybeHeadline
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
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
        console.log(new Date(Date.now()).toLocaleTimeString())
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
    expect(symbols.get("optionalCall")?.valueType).toBe("int?");
    expect(symbols.get("optionalElement")?.valueType).toBe("int?");
    expect(messages).toContain("Argument 2 of type 'string' is not assignable to parameter 'values' of type 'int'");
    expect(messages).toContain("Type 'int?' is not assignable to type 'int'");
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

  it("narrows stable member expressions after truthy checks", () => {
    const source = dedent`
      interface Payload {
        title: string
      }
      interface QueryResult {
        data: Payload | undefined
      }
      let result: QueryResult
      if (result.data) {
        let title = result.data.title
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
  });

  it("narrows identifiers after an early-return falsy guard", () => {
    const source = dedent`
      interface Payload {
        title: string
      }
      fun headline(payload: Payload | undefined): string {
        if (!payload) {
          return "missing"
        }
        return payload.title
      }
    `;

    const ast = parseFile(tokenizeReader(source));
    const analysis = new Analysis(ast);

    expect(analysis.getIssues().map((issue) => issue.message)).toEqual([]);
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
      importedSymbols: new Map([["Point", { type: namedType("Point") }]])
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

  it("infers generic rest tuple arguments for variadic container helpers", () => {
    const source = dedent`
      class Container {}
      class Graphics extends Container {}
      class Stage {
        addChild<U extends Container[]>(...children: U): void {}
      }

      let stage = Stage()
      let badge = Graphics()
      stage.addChild(badge)
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
