import { describe, expect, it, join, readFile, readdir } from "./test/expect";
import * as ts from "typescript";

// Directories containing shared (browser-compatible) code where top-level await is forbidden.
// CLI entry points and build scripts are intentionally excluded — they are Node-only.
const SCANNED_DIRS = ["compiler", "website/src", "plugins"];
const IGNORED_DIR_NAMES = new Set(["node_modules"]);

// Node-only adapter files inside compiler/ that are allowed to use top-level await.
// These files set up Node.js-specific runtime hosts and use top-level await intentionally
// to block module resolution until declarations are loaded — a pattern only viable in Node.js.
const KNOWN_NODE_ONLY_ADAPTERS = new Set([
  "compiler/runtime/ecmascriptDeclarations.ts",
]);

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const filePaths: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return filePaths;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIR_NAMES.has(entry.name)) {
        filePaths.push(...await collectTypeScriptFiles(entryPath));
      }
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      filePaths.push(entryPath);
    }
  }
  return filePaths;
}

function findTopLevelAwaitLines(source: string, filePath: string): number[] {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const lines: number[] = [];

  function visitTopLevel(node: ts.Node): void {
    // Function-like nodes create their own async scope — don't descend into them
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      return;
    }

    if (ts.isAwaitExpression(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      lines.push(line + 1);
      return;
    }

    ts.forEachChild(node, visitTopLevel);
  }

  ts.forEachChild(sourceFile, visitTopLevel);
  return lines;
}

describe("no top-level awaits", () => {
  it("shared source files must not use top-level await", async () => {
    const violations: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const filePath of await collectTypeScriptFiles(dir)) {
        if (KNOWN_NODE_ONLY_ADAPTERS.has(filePath.replace(/\\/g, "/"))) {
          continue;
        }
        const source = await readFile(filePath, "utf8");
        for (const line of findTopLevelAwaitLines(source, filePath)) {
          violations.push(`${filePath}:${line}`);
        }
      }
    }

    expect(
      violations,
      `Top-level awaits found in shared code (forbidden — breaks browser compatibility):\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });
});
