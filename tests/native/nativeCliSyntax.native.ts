import { describe, dirname, expect, it, join, mkdtemp, readFile, readdir, rm, tmpdir, writeFile } from "../../compiler/test/expect";
import { runCli } from "../../cli/cli";
import { validateNativeCppSyntax } from "../../cli/nativeBuild";

describe("native CLI syntax", () => {
  async function generatedNativeSources(output: string): Promise<{ code: string; syntaxPath: string }> {
    const directory = dirname(output);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith(".cpp") || name.endsWith(".hpp"))
      .sort();
    const cppNames = names.filter((name) => name.endsWith(".cpp"));
    const codeParts: string[] = [];
    for (const name of names) codeParts.push(await readFile(join(directory, name), "utf8"));
    const syntaxPath = join(directory, "all-generated.cpp");
    await writeFile(syntaxPath, cppNames.map((name) => `#include "${name}"`).join("\n"), "utf8");
    return { code: codeParts.join("\n"), syntaxPath };
  }

  it("cpp build accepts the complete TypeScript CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-cpp-self-host-"));
    const output = join(dir, "vexa-cli.cpp");
    try {
      await runCli([
        "node",
        "vexa",
        "cpp",
        "build",
        join(process.cwd(), "cli", "cli.ts"),
        "--target",
        "optimized",
        "--out",
        output,
      ]);

      const generated = await generatedNativeSources(output);
      const generatedCpp = generated.code;
      expect(generatedCpp.length).toBeGreaterThan(0);
      expect(generatedCpp).toContain("auto contextProgram = vexa::makeManaged<");
      expect(generatedCpp).not.toContain("auto contextProgram = vexa::toInstance<");
      await validateNativeCppSyntax(generated.syntaxPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cpp command emits native source locations only when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-cpp-source-locations-"));
    const input = join(dir, "input.vx");
    const output = join(dir, "output.cpp");
    try {
      await writeFile(input, 'console.log("debug cpp")', "utf8");
      await runCli(["node", "vexa", "cpp", input, "--out", output, "--native-source-locations"]);

      const generated = await generatedNativeSources(output);
      const outputCode = generated.code;
      expect(outputCode).toContain("VEXA_NATIVE_SOURCE(u\"");
      expect(outputCode).not.toContain("VEXA_NATIVE_SOURCE(runtime,");
      await validateNativeCppSyntax(generated.syntaxPath, { debug: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
