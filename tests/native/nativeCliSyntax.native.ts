import { describe, expect, it, join, mkdtemp, readFile, rm, tmpdir, writeFile } from "../../compiler/test/expect";
import { runCli } from "../../cli/cli";
import { validateNativeCppSyntax } from "../../cli/nativeBuild";

describe("native CLI syntax", () => {
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

      const generatedCpp = await readFile(output, "utf8");
      expect(generatedCpp.length).toBeGreaterThan(0);
      expect(generatedCpp).toContain("auto contextProgram = vexa::makeManaged<");
      expect(generatedCpp).not.toContain("auto contextProgram = vexa::toInstance<");
      await validateNativeCppSyntax(output);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cpp command emits native source locations only when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-cli-cpp-source-locations-"));
    const input = join(dir, "input.vx");
    const output = join(dir, "output.cpp");
    try {
      await writeFile(input, "console.log('debug cpp')", "utf8");
      await runCli(["node", "vexa", "cpp", input, "--out", output, "--native-source-locations"]);

      const outputCode = await readFile(output, "utf8");
      expect(outputCode).toContain("VEXA_NATIVE_SOURCE(u\"");
      expect(outputCode).not.toContain("VEXA_NATIVE_SOURCE(runtime,");
      await validateNativeCppSyntax(output, { debug: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
