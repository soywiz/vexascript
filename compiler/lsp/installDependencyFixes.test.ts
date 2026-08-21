import { describe, expect, it, join, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import { createAnalysisSession } from "./analysisSession";
import { collectModuleNotFoundDiagnostics } from "./crossFileTypeDiagnostics";
import { createInstallDependencyCodeActions } from "./installDependencyFixes";

describe("install dependency quick fixes", () => {
  it("offers npm install when the missing package is declared in package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-install-dependency-"));
    const sourcePath = join(root, "main.vx");
    const source = "import { Scene } from \"three\"\n";
    await writeFile(sourcePath, source, "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({
      dependencies: { three: "^0.180.0" }
    }), "utf8");
    const uri = pathToFileURL(sourcePath).href;
    const session = createAnalysisSession(source);
    const diagnostics = await collectModuleNotFoundDiagnostics({ uri, session });

    const actions = await createInstallDependencyCodeActions({
      uri,
      ast: session.ast!,
      diagnostics,
      commandName: "vexa.installDependencies"
    });

    expect(actions).toEqual([{
      title: "Run 'npm install' for 'three'",
      kind: "quickfix",
      diagnostics,
      command: {
        title: "Run 'npm install' for 'three'",
        command: "vexa.installDependencies",
        arguments: [{ packageRoot: root, packageName: "three" }]
      }
    }]);
  });

  it("does not offer installation for an undeclared package", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-install-dependency-"));
    const sourcePath = join(root, "main.vx");
    const source = "import value from \"not-declared\"\n";
    await writeFile(sourcePath, source, "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({
      dependencies: { three: "^0.180.0" }
    }), "utf8");
    const uri = pathToFileURL(sourcePath).href;
    const session = createAnalysisSession(source);
    const diagnostics = await collectModuleNotFoundDiagnostics({ uri, session });

    const actions = await createInstallDependencyCodeActions({
      uri,
      ast: session.ast!,
      diagnostics,
      commandName: "vexa.installDependencies"
    });

    expect(actions).toEqual([]);
  });
});
