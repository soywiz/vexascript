import { resolve } from "../compiler/utils/path";
import { selfHostCompiler } from "../cli/selfHost";

async function main(): Promise<void> {
  const outputDir = resolve(process.cwd(), process.argv[2] ?? ".self-host");
  const result = await selfHostCompiler({ outputDir, roundTrips: 3 });
  console.log(`Self-hosting reached a fixed point after ${result.outputPaths.length} roundtrips.`);
  console.log(`SHA-256: ${result.sha256}`);
  for (const outputPath of result.outputPaths) {
    console.log(outputPath);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
