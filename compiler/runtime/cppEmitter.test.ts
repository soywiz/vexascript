import { describe, expect, it } from "../test/expect";
import { getTypeCheckerWorkMetrics, resetTypeCheckerWorkMetrics } from "../analysis/TypeChecker";
import { transpile } from "./transpile";

describe("C++ emitter", () => {
  it("preserves floating-point type and signed zero in literals", () => {
    const result = transpile(`
const positiveZero = 0.0;
const negativeZero = -0.0;
`, { emit: "cpp", sourceFilePath: "/tmp/native-signed-zero.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("positiveZero = 0.0;");
    expect(result.code).toContain("negativeZero = (-0.0);");
  });

  it("declares recursive local callbacks before assigning their lambda", () => {
    const result = transpile(`
class Node {}
function visit(root: Node): void {
  const visitNode = (node: Node): void => {
    if (node) visitNode(node);
  };
  visitNode(root);
}
`, { emit: "cpp", sourceFilePath: "/tmp/recursive-local-callback.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::function<void(Node*)> visitNode;");
    expect(result.code).toContain("visitNode = [&](Node* node) mutable -> void");
    expect(result.code).not.toContain("auto visitNode = [&]");
  });

  it("preserves generic callback result arguments when inferring function templates", () => {
    const result = transpile(`
class Box<T> {
  constructor(readonly value: T) {}
}
function box<T>(value: T): Box<T> {
  return new Box<T>(value);
}
function through<T>(callback: () => T): T {
  return callback();
}
const result = through(() => box<string>("ready"));
`, { emit: "cpp", sourceFilePath: "/tmp/generic-callback-result.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("through<Box<std::u16string>*>(");
    expect(result.code).not.toContain("through<Box>(");
  });

  it("infers return-only function templates from nullable call results", () => {
    const result = transpile(`
class Node {}
class JsxElement extends Node {}
class JsxFragment extends Node {}
function findNode<T extends Node>(
  root: Node,
  predicate: (node: Node) => node is T
): T | null {
  return null;
}
const program = new Node();
const jsxNode = findNode(
  program,
  (node): node is JsxElement | JsxFragment =>
    node instanceof JsxElement || node instanceof JsxFragment
);
`, {
      emit: "cpp",
      sourceFilePath: "/tmp/generic-nullable-result.ts",
      typeCheck: false
    });

    expect(result.code).toContain("findNode<Node*>(");
  });

  it("keeps nullable object results when inferring callback templates", () => {
    const result = transpile(`
function withResult<T>(action: () => T): T {
  return action();
}
function collect(): ReadonlyMap<string, string> | undefined {
  return withResult(() => {
    const values = new Map<string, string>();
    return values.size > 0 ? values : undefined;
  });
}
`, {
      emit: "cpp",
      sourceFilePath: "/tmp/generic-nullable-callback-result.ts",
      typeCheck: false
    });

    expect(result.code).toContain("withResult<vexa::MapObject*>(");
    expect(result.code).not.toContain("MapObject<");
    expect(result.code).not.toContain("withResult<vexa::Undefined>(");
  });

  it("emits array comprehensions through the native loop path", () => {
    const result = transpile(`
const values = [for (value of [1, 2, 3]) value * 2]
const rangeValues = [for (value in 0 ..< 3) value]
console.log(values.join(","))
console.log(rangeValues.join(","))
`, { emit: "cpp", sourceFilePath: "/tmp/array-comprehension.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_comprehension_result");
    expect(result.code).toContain("for (auto value");
    expect(result.code).not.toContain("vexa::objectKeys");
  });

  it("mixes native array comprehensions with values and spreads", () => {
    const result = transpile(`
const items = [20, 21]
const values = [1, for (value in 0 ... 2) value, ...items, for (value in 0 ... 2) value * 2, 0]
console.log(values.join(","))
`, { emit: "cpp", sourceFilePath: "/tmp/mixed-array-comprehension.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::appendAll");
    expect(result.code).toContain("__vexa_comprehension_result");
  });

  it("emits comprehension if expressions through native lowering", () => {
    const result = transpile(`
const withElse = [for (n in 0 ... 4) if (n % 2 == 0) n else n * 3]
const withoutElse = [for (n in 0 ... 4) if (n % 2 == 0) n]
const combined = [
  for (n in 0 ... 4) if (n % 2 == 0) n else n * 3,
  for (n in 0 ... 4) if (n % 2 == 0) n,
]
console.log(withElse.join(","), withoutElse.length, combined.length)
`, { emit: "cpp", sourceFilePath: "/tmp/conditional-array-comprehension.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_comprehension_result");
    expect(result.code).toContain("vexa::makeArray<std::int32_t>()");
    expect(result.code).toContain("vexa::appendAll");
    expect(result.code).toContain("vexa::ArrayObject<std::int32_t>* combined");
    expect(result.code).not.toContain("vexa::Value::undefined()");
    expect(result.code).not.toContain("vexa::makeArray<vexa::Value>()");
    expect(result.code).not.toContain("makeArray<auto>");
    expect(result.code).not.toContain("convertValue<auto>");
  });

  it("lowers class init blocks into constructor bodies", () => {
    const result = transpile(`
class Demo {
  var value: int
  init { value = 1 }
}
`, { emit: "cpp", sourceFilePath: "/tmp/class-init.vx", parserOptions: { language: "vexa" } });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("(this->value = 1);");
  });

  it("emits VexaScript character literals as code-point integers", () => {
    const result = transpile(`
val code: int = #"😀"
val matches = 'A'.charCodeAt(0) == #'A'
`, { emit: "cpp", sourceFilePath: "/tmp/character-literal.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("std::int32_t code");
    expect(result.code).toContain("code = 128512;");
    expect(result.code).toContain("== 65");
  });

  it("lowers logical assignments without emitting invalid C++ operators", () => {
    const result = transpile(`
function merge(values: boolean[]): boolean {
  let any = false;
  let every = true;
  for (const value of values) {
    any ||= value;
    every &&= value;
  }
  return any && every;
}
`, { emit: "cpp", sourceFilePath: "/tmp/logical-assignment.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).not.toContain("||=");
    expect(result.code).not.toContain("&&=");
    expect(result.code).toContain("vexa::assignWith");
  });

  it("emits string iteration and codePointAt through native runtime helpers", () => {
    const result = transpile(`
function inspect(value: string): number {
  const characters = [...value];
  return characters.length + (value.codePointAt(0) ?? 0);
}
`, { emit: "cpp", sourceFilePath: "/tmp/string-iteration.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::appendAll(__vexa_array, value)");
    expect(result.code).toContain("vexa::codePointAt(value");
  });

  it("folds pure standard-library calls on string literals", () => {
    const result = transpile(`
const point = "a".codePointAt(0);
const upper = "vexa".toUpperCase();
const wellFormed = "A😀".isWellFormed();
const contained = "vexascript".includes("script");
const replaced = "aba".replaceAll("a", "x");
`, { emit: "cpp", sourceFilePath: "/tmp/literal-standard-calls.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Value(97)");
    expect(result.code).toContain('std::u16string(u"VEXA")');
    expect(result.code).not.toContain("vexa::codePointAt(");
    expect(result.code).not.toContain("vexa::toUpperCase(");
    expect(result.code).not.toContain("vexa::stringIsWellFormed(");
    expect(result.code).toContain("contained = true");
    expect(result.code).toContain('std::u16string(u"xbx")');
  });

  it("lowers index searches on simple array literals without allocating the array", () => {
    const result = transpile(`
function positions(value: string): number {
  return ["a", "b", "a"].indexOf(value) + ["a", "b", "a"].lastIndexOf(value);
}
`, { emit: "cpp", sourceFilePath: "/tmp/literal-array-indexes.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_literal_search");
    expect(result.code).toContain("vexa::strictEquals");
    expect(result.code).not.toContain("vexa::makeArray");
  });

  it("lowers includes on a simple array literal without allocating the array", () => {
    const result = transpile(`
function isKnown(value: string): boolean {
  return ["a", "b", "c"].includes(value);
}
`, { emit: "cpp", sourceFilePath: "/tmp/literal-array-includes.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_literal_search");
    expect(result.code).toContain("vexa::sameValueZero");
    expect(result.code).not.toContain("vexa::makeArray");
    expect(result.code).not.toContain("vexa::includes(");
  });

  it("emits every standard typed-array representation plus resizable buffers and Intl", () => {
    for (const name of [
      "Int8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
      "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
    ]) {
      const typedArray = transpile(`const values = new ${name}(4);`, {
        emit: "cpp",
        sourceFilePath: `/tmp/native-${name}.ts`,
      });
      expect(typedArray.errors).toEqual([]);
      expect(typedArray.code).toContain(`vexa::makeTypedArray<vexa::TypedArrayKind::${name.slice(0, -"Array".length)}>(4)`);
    }
    const buffer = transpile(`
const buffer = new ArrayBuffer(8);
buffer.resize(4);
`, { emit: "cpp", sourceFilePath: "/tmp/native-array-buffer-resize.ts" });
    expect(buffer.errors).toEqual([]);
    expect(buffer.code).toContain("buffer->resize(static_cast<double>(4))");
    const intl = transpile(`
const collator = new Intl.Collator("en");
`, { emit: "cpp", sourceFilePath: "/tmp/native-intl-collator.ts" });
    expect(intl.errors).toEqual([]);
    expect(intl.code).toContain("vexa::IntlObjectKind::Collator");
  });

  it("does not treat inherited coverage-policy keys as standard-library owners", () => {
    const result = transpile(`
class MethodName { name: string = "run" }
function inspect(constructor: MethodName): string {
  return constructor.name;
}
`, { emit: "cpp", sourceFilePath: "/tmp/policy-constructor-key.ts" });

    expect(result.errors).toEqual([]);
  });

  it("adapts modified brace lambdas to ordinary native callback contracts", () => {
    const result = transpile(`
function invoke(callback: (value: int) => int): int { return callback(2) }
const value = invoke(sync { it + 1 });
`, { emit: "cpp", sourceFilePath: "/tmp/modified-brace-lambda.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::blockingCallback(");
    expect(result.code).toContain("vexa::Task<std::int32_t>");
  });

  it("bounds typed-array overload comparison for Atomics calls", () => {
    resetTypeCheckerWorkMetrics();
    const result = transpile(`
const values = new Int32Array(4);
const value = Atomics.load(values, 0);
`, { emit: "cpp", sourceFilePath: "/tmp/atomics-overload-work.ts" });
    const metrics = getTypeCheckerWorkMetrics();

    expect(result.errors).toEqual([]);
    expect(metrics.distinctTypedArrayRejections > 0).toBe(true);
    expect(metrics.assignabilityComputations < 5_000).toBe(true);
  });

  it("emits negative string at indexes through the native runtime helper", () => {
    const result = transpile(`
function lastCharacter(value: string): string | undefined {
  return value.at(-1);
}
`, { emit: "cpp", sourceFilePath: "/tmp/string-at.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::stringAt(value");
    expect(result.code).not.toContain("value.at(");
  });

  it("converts dynamically emitted arithmetic into declared primitive locals", () => {
    const result = transpile(`
function offset(index: any, fixed: any): number {
  const restIndex: number = index - fixed;
  return restIndex;
}
`, { emit: "cpp", sourceFilePath: "/tmp/dynamic-arithmetic-local.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("double restIndex = vexa::toDouble(vexa::subtract(");
  });

  it("uses explicit callable return annotations when boxing interface callbacks", () => {
    const result = transpile(`
class Expr {}
interface Options {
  callback?: (expression: Expr) => string | undefined;
}
function consume(options: Options): void {}
const callback = (expression: Expr): string | undefined => expression ? "ok" : undefined;
consume({ callback: callback });
`, { emit: "cpp", sourceFilePath: "/tmp/explicit-callback-return.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::makeFunction<vexa::Value, Expr*>");
    expect(result.code).not.toContain("vexa::makeFunction<vexa::Undefined, Expr*>");
  });

  it("emits shared lowering for control-flow expressions", () => {
    const result = transpile(`
fun early(flag: boolean): int {
  flag || return 1
  return 2
}
fun scan(values: int[]) {
  for (val value of values) {
    value > 0 || continue
    value < 10 || break
  }
}
fun pick(flag: boolean): int {
  val result = if (flag) 3 else throw "No result"
  return result
}
fun requireValue(value: string | undefined): string {
  val result = value || throw Error("missing")
  return result
}
`, { emit: "cpp", sourceFilePath: "/tmp/control-expressions.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_control_0");
    expect(result.code).toContain("return 1;");
    expect(result.code).toContain("continue;");
    expect(result.code).toContain("break;");
    expect(result.code).toContain("vexa::throwValue(__vexa_literal_0->value())");
    expect(result.code).toContain("std::u16string result");
  });

  it("emits match expressions through the shared C++ conditional lowering", () => {
    const result = transpile(`
fun pick(value: int): string {
  return match {
    value == 1 -> "one"
    value == 2 -> {
      val label = "two"
      label
    }
    default -> "other"
  }
}
`, { emit: "cpp", sourceFilePath: "/tmp/match-expression.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("if (value == 1)");
    expect(result.code).toContain("if (value == 2)");
    expect(result.code).toContain("return __vexa_literal_");
  });

  it("emits structural and combined is patterns with single-evaluation captures", () => {
    const result = transpile(`
fun classify(value: any): string {
  return match {
    value is ({ kind: "ok" } and { payload: [1, 2] }) -> "object"
    value is (["error", ..., 500] or ["error", ..., 503]) -> "array"
    value is "plain" -> "literal"
    value is /^ready-[0-9]+$/i -> "regexp"
    else -> "other"
  }
}
fun range(value: int): string {
  return match (value) {
    when >= 10 and < 20: "inside"
    else -> "outside"
  }
}
fun typed(value: any): string {
  return match (value) {
    [string, val bound: number, 3] -> bound.toString()
    ["tail", ..., val ending: string] -> ending
    string -> "string"
    number -> "number"
    bigint -> "bigint"
    else -> "other"
  }
}
`, { emit: "cpp", sourceFilePath: "/tmp/is-patterns.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("[&](vexa::Value __vexa_pattern) -> bool");
    expect(result.code).toContain("vexa::hasProperty(__vexa_pattern, u\"kind\")");
    expect(result.code).toContain("dynamicIsArray()");
    expect(result.code).toContain("dynamicArraySize() >= 2");
    expect(result.code).toContain("vexa::strictEquals(__vexa_pattern");
    expect(result.code).toContain("&&");
    expect(result.code).toContain("||");
    expect(result.code).toContain("vexa::compare(__vexa_pattern");
    expect(result.code).toContain("__vexa_pattern.isString()");
    expect(result.code).toContain("vexa::regexTest(vexa::RegExp(u\"^ready-[0-9]+$\", u\"i\"), __vexa_pattern)");
    expect(result.code).toContain("__vexa_pattern.isString()");
    expect(result.code).toContain("__vexa_pattern.isNumber()");
    expect(result.code).toContain("__vexa_pattern.isBigInt()");
    expect(result.code).toContain("double bound");
    expect(result.code).toContain("dynamicArraySize() - 1");
    expect(result.code).toContain("std::u16string ending");
  });

  it("keeps concrete Set storage when an explicit semantic type lowers dynamically", () => {
    const result = transpile(`
type Name = "alpha" | "beta";
export const names: ReadonlySet<string> = new Set<Name>(["alpha", "beta"]);
`, { emit: "cpp", sourceFilePath: "/tmp/readonly-set.ts", typeCheck: false });

    expect(result.code).toContain("vexa::setFromIterable(vexa::toValue(");
    expect(result.code).not.toContain("SetObject<");
  });

  it("infers templates nested inside erased native collections", () => {
    const result = transpile(`
function cloneSetValues<T>(values: Map<string, Set<T>>): Map<string, Set<T>> {
  return values;
}
function cloneArrayValues<T>(values: Map<string, T[]>): Map<string, T[]> {
  return values;
}
const setValues: Map<string, Set<string>> = new Map();
const arrayValues: Map<string, number[]> = new Map();
cloneSetValues(setValues);
cloneArrayValues(arrayValues);
`, { emit: "cpp", sourceFilePath: "/tmp/erased-collection-template-inference.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("cloneSetValues<std::u16string>(setValues)");
    expect(result.code).toContain("cloneArrayValues<double>(arrayValues)");
  });

  it("infers flatMap tuple elements from the callback instead of the receiver", () => {
    const result = transpile(`
interface Property { name: string; type: string }
const properties: Property[] = [];
const entries = properties.flatMap((property) => {
  const type = property.type;
  return type ? [[property.name, type] as const] : [];
});
const mapped = new Map(entries);
`, { emit: "cpp", sourceFilePath: "/tmp/flat-map-tuples.ts", typeCheck: false });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("ArrayObject<vexa::ArrayObject<std::u16string>*>*");
    expect(result.code).not.toContain("toInstance<Property*>(vexa::makeArray<std::u16string>");
  });

  it("infers a chained map callback from its receiver before filter context", () => {
    const result = transpile(`
const numbers = [1, 2, 3, 4]
const transformed = numbers.map { it * 3 }.filter { it % 2 == 0 }
`, { emit: "cpp", sourceFilePath: "/tmp/chained-array-callbacks.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::ArrayObject<std::int32_t>* transformed = nullptr;");
    expect(result.code).toContain("transformed = vexa::filter(");
    expect(result.code).toContain("vexa::map(");
    expect(result.code).toContain("[&](auto it) -> std::int32_t");
    expect(result.code).not.toContain("vexa::ArrayObject<vexa::Value>* transformed");
  });

  it("does not force a filtered result type into nullable map callback values", () => {
    const result = transpile(`
class Node {}
class Identifier extends Node { name: string }
function bindingName(node: Node | undefined): string | null {
  return node instanceof Identifier ? node.name : null
}
function names(nodes: Node[]): string[] {
  return nodes.map((node) => bindingName(node)).filter((name) => name !== null)
}
`, { emit: "cpp", sourceFilePath: "/tmp/nullable-map-filter.ts", typeCheck: false });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("[&](auto node) mutable -> vexa::Value");
    expect(result.code).not.toContain("vexa::toText(bindingName(node))");
  });

  it("adapts covariant array arguments through shared runtime views", () => {
    const result = transpile(`
class Base {}
class Derived extends Base {}
function useBase(values: Base[]): void {}
const derived: Derived[] = [];
useBase(derived);
`, { emit: "cpp", sourceFilePath: "/tmp/shared-array-views.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("toInstance<vexa::ArrayObject<Base*>*>(derived)");
  });

  it("does not impose a Map result type on a nullish iterable fallback", () => {
    const result = transpile(`
function copy(existing: ReadonlyMap<string, string> | undefined): Map<string, string> {
  return new Map(existing ?? []);
}
`, { emit: "cpp", sourceFilePath: "/tmp/map-nullish-iterable.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::mapFromIterable(vexa::toValue(vexa::nullishCoalesce(");
    expect(result.code).toContain("return vexa::toValue(vexa::makeArray<vexa::Value>({}));");
    expect(result.code).not.toContain("MapObject<");
  });

  it("lowers WeakMap iterables, radix string conversion, and native binary helpers", () => {
    const result = transpile(`
const key = { kind: "buffer" }
const metadata = WeakMap<object, string>([[key, "ready"]])
const value = 255
console.log(metadata.get(key), value.toString(16))
`, { emit: "cpp", sourceFilePath: "/tmp/native-collections-and-binary.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::weakMapFromIterable(vexa::toValue(");
    expect(result.code).not.toContain("WeakMapObject<");
    expect(result.code).toContain("vexa::toString(value, static_cast<double>(16))");
  });

  it("forwards interface members through class delegation", () => {
    const result = transpile(`
interface Shape { area: number; fill(color: string): string }
class Rectangle(val width: number, val height: number): Shape {
  override area => width * height
  override fill(color: string) => color
}
class Logger(val shape: Shape): Shape by { shape }
const logger = Logger(Rectangle(2, 3))
console.log(logger.area, logger.fill("ok"))
`, { emit: "cpp", sourceFilePath: "/tmp/class-delegation.vx", parserOptions: { language: "vexa" } });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("this->shape->__vexa_property_get_area()");
    expect(result.code).toContain("this->shape->fill(color)");
  });

  it("lowers top-level delegated state reads and writes", () => {
    const result = transpile(`
fun box<T>(initial: T) { return { value: initial } }
var source = 1
var observed by () => source
var total by box(0)
total = observed + 2
total++
console.log(total)
`, { emit: "cpp", sourceFilePath: "/tmp/delegated-state.vx", parserOptions: { language: "vexa" } });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("__vexa_delegate_total");
    expect(result.code).toContain("recordGet<std::int32_t>");
  });

  it("does not turn an empty C++ annotation list into an empty C++ body", () => {
    const result = transpile(`
async function readFile(path: string): Promise<string> {
  return path;
}
`, { emit: "cpp", sourceFilePath: "/tmp/empty-cpp-annotation.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Task<std::u16string> readFile");
    expect(result.code).not.toContain("@CppBody supports synchronous functions only");
  });

  it("emits console arguments in a braced list so their side effects run left to right", () => {
    const result = transpile(`
var value = 1
fun increment(): int { value += 1; return value }
console.log(value, increment(), value)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::console.log({");
  });

  it("keeps nullish coalescing dynamic when both optional string operands can be undefined", () => {
    const result = transpile(`
class Statement { jsName?: string }
function pick(candidate: Statement, statement: Statement): void {
  const jsName = candidate.jsName ?? statement.jsName;
  if (jsName !== undefined) console.log(jsName);
}
`, { emit: "cpp", sourceFilePath: "/tmp/optional-string.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto jsName = vexa::nullishCoalesce(candidate->jsName");
    expect(result.code).not.toContain("auto jsName = vexa::toText(vexa::nullishCoalesce(candidate->jsName");
  });

  it("uses the native steady clock for performance.now", () => {
    const result = transpile("const startedAt = performance.now()", {
      emit: "cpp",
      sourceFilePath: "/tmp/performance.ts"
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::performanceNow()");
  });

  it("keeps mixed template concatenation in native text storage", () => {
    const result = transpile('const count = 2; const message = `count ${count}!`', {
      emit: "cpp",
      sourceFilePath: "/tmp/template-text.ts"
    });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::concatText({");
    expect(result.code).not.toContain("vexa::add(");
  });

  it("keeps statically numeric bitwise operations out of the dynamic Value path", () => {
    const result = transpile(`
function fold(leftValue: number, rightValue: number): number {
  const shifted = leftValue << rightValue;
  const masked = leftValue & rightValue;
  const inverted = ~leftValue;
  return shifted + masked + inverted;
}
`, { emit: "cpp", sourceFilePath: "/tmp/numeric-bitwise.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::shiftLeft(leftValue, rightValue)");
    expect(result.code).toContain("vexa::bitwiseAnd(leftValue, rightValue)");
    expect(result.code).toContain("vexa::bitwiseNot(leftValue)");
    expect(result.code).not.toContain("vexa::toValue(leftValue)");
  });

  it("caches instanceof narrowing casts instead of checking and casting twice", () => {
    const result = transpile(`
class Base {}
class Child extends Base { value: number }
function read(value: Base): number {
  if (value instanceof Child) return value.value;
  return 0;
}
`, { emit: "cpp", sourceFilePath: "/tmp/instanceof-narrowing.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("auto* __vexa_instanceof_");
    expect(result.code).toContain("vexa::toInstanceOrNull<Child*>(value)");
    expect(result.code).toContain("if (__vexa_instanceof_");
    expect(result.code).not.toContain("vexa::isInstance<Child>(value)");
  });

  it("forwards primary-constructor arguments to the native base initializer", () => {
    const result = transpile(`
class Base(val value: int)
class Child(value: int, val label: string) : Base(value)
console.log(Child(7, "ready").value)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Base(value)");
  });

  it("emits referenced C++ headers and raw function bodies", () => {
    const result = transpile(`
@CppHeader("#include <native_api.h>")
@CppBody("return native_add(left, right);")
declare function nativeAdd(left: int, right: int): int
console.log(nativeAdd(2, 3))
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain(
      '#include <native_api.h>\n#if !defined(VEXA_RUNTIME_PRECOMPILED)\n#include "runtime/runtime.hpp"\n#endif'
    );
    expect(result.code).toContain("return native_add(left, right);");
  });

  it("lowers FFILibrary classes to cached native symbols", () => {
    const result = transpile(`
@FFILibrary("native.dll", "libnative.so", "Native.framework/Native")
declare class NativeMath { static abs(value: int): int }
console.log(NativeMath.abs(-3))
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("class NativeMath final {");
    expect(result.code).toContain('vexa::LibraryOpen::symbol({"native.dll", "libnative.so", "Native.framework/Native"}, "abs")');
    expect(result.code).toContain("return __vexa_function(value);");
  });

  it("resolves an FFIName while preserving the source method name", () => {
    const result = transpile(`
@FFILibrary("libnative.so")
declare class NativeMath { @FFIName("native_abs") static Abs(value: int): int }
console.log(NativeMath.Abs(-3))
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain('vexa::LibraryOpen::symbol({"libnative.so"}, "native_abs")');
    expect(result.code).toContain("NativeMath::Abs((-3))");
  });

  it("emits ArrayBuffer-backed C ABI structs with explicit layout", () => {
    const result = transpile(`
@FFIStruct(8)
@FFIAlign(4)
class Pair(@FFIOffset(0) @FFISize(2) var x: int, @FFIOffset(4) var y: int)
const pair = Pair(7, 9)
console.log(pair.x, pair.y)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::makeManaged<vexa::ArrayBufferObject>(8)");
    expect(result.code).not.toContain("vexa::Runtime::current()");
    expect(result.code).toContain("std::int16_t& x;");
    expect(result.code).toContain("buffer_->data() + 4");
    expect(result.code).toContain("static_assert(4 % 4 == 0);");
  });

  it("preserves default values on native FFI struct constructors", () => {
    const result = transpile(`
@FFIStruct(8)
@FFIAlign(4)
class Pair(@FFIOffset(0) var x: int = 0, @FFIOffset(4) var y: int = 0)
const pair = Pair()
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Pair(std::int32_t x, std::int32_t y)");
    expect(result.code).toContain("vexa::makeManaged<Pair>(0, 0)");
  });

  it("emits field-declared FFI structs with overlapping explicit offsets", () => {
    const result = transpile(`
@FFIStruct(8)
@FFIAlign(4)
class Event {
  @FFIOffset(0) var! type: int
  @FFIOffset(0) @FFISize(2) var! code: int
  @FFIOffset(4) var! value: int
}
const event = Event()
event.type = 7
console.log(event.code)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("Event()");
    expect(result.code).toContain("std::int32_t& type;");
    expect(result.code).toContain("std::int16_t& code;");
    expect(result.code).toContain("type(*reinterpret_cast<std::int32_t*>(buffer_->data() + 0))");
    expect(result.code).toContain("code(*reinterpret_cast<std::int16_t*>(buffer_->data() + 0))");
  });

  it("passes ArrayBuffer storage directly to native FFI", () => {
    const result = transpile(`
@FFILibrary("libnative.so")
declare class Native { static fill(bytes: ArrayBuffer, value: int, size: long): FFIPointer }
Native.fill(ArrayBuffer(8), 1, 8L)
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::ArrayBufferObject* bytes");
    expect(result.code).toContain("using __vexa_function_type = void* (*)(void*, std::int32_t, std::int64_t);");
    expect(result.code).toContain("__vexa_function(bytes->data(), value, size)");
  });

  it("runs Promise-returning FFI symbols on a worker and resumes the runtime loop", () => {
    const result = transpile(`
@FFILibrary("libnative.so")
declare class Native { static wait(milliseconds: int): Promise<void> }
sync function main(): void { Native.wait(1) }
main()
`, { emit: "cpp" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::Task<void> wait(std::int32_t milliseconds)");
    expect(result.code).toContain("vexa::runAsync(");
  });

  it("emits native runtime and platform intrinsics", () => {
    const result = transpile(`
console.log(vexaRuntime(), vexaPlatform())
async function loadBytes(): Promise<Uint8Array> {
  return await nativeReadFileBytes("runtime.hpp")
}
`, { emit: "cpp" });
    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::vexaRuntimeName()");
    expect(result.code).toContain("vexa::vexaPlatformName()");
    expect(result.code).toContain("vexa::nativeReadFileBytes(vexa::toText(");
  });

  it("routes every supported ECMAScript error constructor through the native error type", () => {
    const result = transpile(`
const base = Error("base")
const range = RangeError("range")
const syntax = SyntaxError("syntax")
const type = TypeError("type")
`, { emit: "cpp", sourceFilePath: "/tmp/native-error-constructors.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code.match(/vexa::makeError\(/g)?.length).toBe(4);
    expect(result.code).not.toContain("RangeError(");
    expect(result.code).not.toContain("SyntaxError(");
    expect(result.code).not.toContain("TypeError(");
  });

  it("widens typed-array reduce accumulators to the analyzed result type", () => {
    const result = transpile(`
const total = Float16Array.of(1.5, 2.25).reduce((sum, value) => sum + value, 0)
`, { emit: "cpp", sourceFilePath: "/tmp/native-float16-reduce.vx" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("double total");
    expect(result.code).toContain("-> double");
    expect(result.code).toContain("static_cast<double>(0)");
    expect(result.code).not.toContain("std::int32_t total");
  });

  it("guards optional array method receivers before invoking native helpers", () => {
    const result = transpile(`
function positive(values: number[] | undefined): number[] | undefined {
  return values?.filter((value) => value > 0);
}
`, { emit: "cpp", sourceFilePath: "/tmp/optional-array.ts", typeCheck: false });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::optionalCall(");
    expect(result.code).toContain("vexa::filter(__vexa_optional_receiver");
  });

  it("keeps missing partial record entries optional before string conversion", () => {
    const result = transpile(`
function mappedTarget(
  mappings: Readonly<Partial<Record<string, string>>>,
  primary: string,
  fallback: string
): string | undefined {
  return mappings[primary] ?? mappings[fallback];
}
`, { emit: "cpp", sourceFilePath: "/tmp/partial-record-index.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::recordGet<vexa::Value>(mappings, vexa::propertyKey(primary))");
    expect(result.code).toContain("vexa::recordGet<vexa::Value>(mappings, vexa::propertyKey(fallback))");
    expect(result.code).not.toContain("vexa::recordGet<std::u16string>");
  });

  it("guards method calls after optional computed-member chains", () => {
    const result = transpile(`
function capture(text: string): string | undefined {
  return /^keyof\\s+(.+)$/.exec(text)?.[1]?.trim();
}
`, { emit: "cpp", sourceFilePath: "/tmp/optional-regexp-capture.ts" });

    expect(result.errors).toEqual([]);
    expect(result.code).toContain("vexa::optionalCall(");
    expect(result.code).not.toContain("vexa::trim(([&]()");
  });
});
