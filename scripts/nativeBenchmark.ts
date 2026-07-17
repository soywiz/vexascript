import { formatNativeBenchmarkMarkdown, runNativeBenchmark } from "../cli/nativeBenchmark";

runNativeBenchmark()
  .then((result) => console.log(formatNativeBenchmarkMarkdown(result)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
