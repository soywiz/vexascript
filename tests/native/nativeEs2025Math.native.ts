import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  rm,
  tmpdir,
  writeFile,
} from "../../compiler/test/expect";
import { runCli } from "../../cli/cli";
import { runCommandCapture } from "../../cli/io";

const coveredMathMembers = [
  "E", "LN10", "LN2", "LOG10E", "LOG2E", "PI", "SQRT1_2", "SQRT2",
  "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh",
  "cbrt", "ceil", "clz32", "cos", "cosh", "exp", "expm1", "f16round",
  "floor", "fround", "hypot", "imul", "log", "log10", "log1p", "log2",
  "max", "min", "pow", "random", "round", "sign", "sin", "sinh",
  "sqrt", "tan", "tanh", "trunc",
] as const;

function declaredMathMembers(declarations: string): string[] {
  const names = new Set<string>();
  for (const block of declarations.matchAll(/interface Math\s*\{([\s\S]*?)\n\}/g)) {
    const body = block[1] ?? "";
    for (const member of body.matchAll(/^\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:)/gm)) {
      if (member[1]) names.add(member[1]);
    }
  }
  return [...names].sort();
}

describe("native ES2025 Math", () => {
  it("keeps every declared numeric Math API in the native execution smoke", async () => {
    const declarations = await readFile(join(process.cwd(), "compiler", "runtime", "es2025.d.ts"), "utf8");
    expect(declaredMathMembers(declarations)).toEqual([...coveredMathMembers].sort());

    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-es2025-math-"));
    const sourcePath = join(outputRoot, "math.vx");
    const executablePath = join(outputRoot, "math");
    try {
      await writeFile(sourcePath, `
function check(condition: boolean, name: string): void {
  if (!condition) throw Error(name);
}
function near(actual: number, expected: number, name: string): void {
  check(Math.abs(actual - expected) < 0.000001, name);
}

near(Math.E, 2.718281828459045, "E");
near(Math.LN10, 2.302585092994046, "LN10");
near(Math.LN2, 0.6931471805599453, "LN2");
near(Math.LOG10E, 0.4342944819032518, "LOG10E");
near(Math.LOG2E, 1.4426950408889634, "LOG2E");
near(Math.PI, 3.141592653589793, "PI");
near(Math.SQRT1_2, 0.7071067811865476, "SQRT1_2");
near(Math.SQRT2, 1.4142135623730951, "SQRT2");
check(Math.abs(-3) === 3, "abs");
near(Math.acos(1), 0, "acos");
near(Math.acosh(1), 0, "acosh");
near(Math.asin(0), 0, "asin");
near(Math.asinh(0), 0, "asinh");
near(Math.atan(0), 0, "atan");
near(Math.atan2(0, 1), 0, "atan2");
near(Math.atanh(0), 0, "atanh");
near(Math.cbrt(27), 3, "cbrt");
check(Math.ceil(1.2) === 2, "ceil");
check(Math.clz32(1) === 31, "clz32");
near(Math.cos(0), 1, "cos");
near(Math.cosh(0), 1, "cosh");
near(Math.exp(0), 1, "exp");
near(Math.expm1(0), 0, "expm1");
check(Math.f16round(1.337) === 1.3369140625, "f16round");
check(Math.floor(1.8) === 1, "floor");
near(Math.fround(1.337), 1.337, "fround");
near(Math.hypot(3, 4, 12), 13, "hypot");
check(Math.imul(2147483647, 2) === -2, "imul");
near(Math.log(1), 0, "log");
near(Math.log10(100), 2, "log10");
near(Math.log1p(0), 0, "log1p");
near(Math.log2(8), 3, "log2");
check(Math.max(1, 4, 2) === 4, "max");
check(Math.min(1, -4, 2) === -4, "min");
near(Math.pow(3, 2), 9, "pow");
const random = Math.random();
check(random >= 0 && random <= 1, "random");
check(Math.round(2.6) === 3, "round");
check(Math.sign(-4) === -1, "sign");
near(Math.sin(0), 0, "sin");
near(Math.sinh(0), 0, "sinh");
near(Math.sqrt(9), 3, "sqrt");
near(Math.tan(0), 0, "tan");
near(Math.tanh(0), 0, "tanh");
check(Math.trunc(2.9) === 2, "trunc");
console.log("es2025-math-ok");
`, "utf8");

      await runCli([
        "node", "vexa", "cpp", "link", sourcePath,
        "--out", executablePath,
        "--build-dir", join(outputRoot, "build"),
        "-O0",
      ]);
      const result = await runCommandCapture(executablePath, [], { cwd: outputRoot });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("es2025-math-ok");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
