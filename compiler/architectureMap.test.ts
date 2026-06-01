import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const architectureMap = readFileSync("AGENTS.md", "utf8");
const architectureMapSection = architectureMap.slice(
  architectureMap.indexOf("## Architecture Map"),
  architectureMap.indexOf("### Maintenance Rule")
);

const trackedArchitectureFiles = [
  "compiler/parser/parser.ts",
  "compiler/parser/tokenizer.ts",
  "compiler/ast/ast.ts",
  "compiler/sourceLocations.ts",
  "compiler/analysis/Analysis.ts",
  "compiler/analysis/Binder.ts",
  "compiler/analysis/TypeChecker.ts",
  "compiler/analysis/typeNames.ts",
  "compiler/analysis/projectIndex.ts",
  "compiler/analysis/model.ts",
  "compiler/analysis/types.ts",
  "compiler/analysis/issueCodes.ts",
  "compiler/runtime/lowering.ts",
  "compiler/runtime/emitter.ts",
  "compiler/runtime/transpile.ts",
  "compiler/runtime/tooling.ts",
  "compiler/runtime/formatter.ts",
  "compiler/pipeline/compile.ts",
  "compiler/cli.ts",
  "compiler/lsp/server.ts",
  "compiler/lsp/projectAnalysis.ts",
  "compiler/lsp/analysisSession.ts",
  "compiler/lsp/completion.ts",
  "compiler/lsp/diagnostics.ts",
  "compiler/lsp/crossFileTypeDiagnostics.ts",
  "compiler/lsp/memberDiagnostics.ts",
  "compiler/lsp/diagnosticCodes.ts",
  "compiler/lsp/navigation.ts",
  "compiler/lsp/crossFileNavigation.ts",
  "compiler/lsp/signatureHelp.ts",
  "compiler/lsp/symbols.ts",
  "compiler/lsp/semanticTokens.ts",
  "compiler/lsp/inlayHints.ts",
  "compiler/lsp/codeActions.ts",
  "compiler/lsp/importFixes.ts",
  "compiler/lsp/typeFixes.ts",
  "compiler/lsp/memberFixes.ts",
  "compiler/lsp/callFixes.ts",
  "compiler/lsp/keywordFixes.ts",
  "compiler/lsp/interfaceImplementationFixes.ts",
  "compiler/lsp/classResolver.ts",
  "compiler/lsp/formatting.ts",
  "plugins/vscode/extension.js",
  "plugins/vscode/syntaxes/mylang.tmLanguage.json",
  "plugins/vscode/package.json",
  "plugins/vscode/language-configuration.json",
  "docs/syntax.md",
  "docs/syntax.pending.md",
  "docs/tasks.pending.md",
  "docs/lsp.services.md",
  "docs/semantic.spec.md",
  "docs/transpilation.design.md",
  "compiler/architectureMap.test.ts",
  "testFixtures/sample.my",
  "testFixtures/typescript-supported.d.ts"
];

function extractBacktickedPaths(markdown: string): string[] {
  const paths = new Set<string>();
  const pathPattern = /`([^`]+\.(?:ts|js|json|md|my|d\.ts))`/g;
  let match: RegExpExecArray | null;

  while ((match = pathPattern.exec(markdown))) {
    const codeSpan = match[1] ?? "";
    for (const part of codeSpan.split(",")) {
      const path = part.trim();
      if (path.includes("*") || path.startsWith("@")) {
        continue;
      }
      paths.add(path);
    }
  }

  return [...paths].sort();
}

describe("Architecture Map", () => {
  it("documents every tracked architecture entrypoint", () => {
    for (const filePath of trackedArchitectureFiles) {
      expect(architectureMap, `${filePath} should be listed in AGENTS.md`).toContain(filePath);
    }
  });

  it("only documents architecture paths that exist", () => {
    const documentedPaths = extractBacktickedPaths(architectureMapSection);

    expect(documentedPaths).not.toEqual([]);
    for (const filePath of documentedPaths) {
      expect(existsSync(filePath), `${filePath} is documented in AGENTS.md but does not exist`).toBe(true);
    }
  });
});
