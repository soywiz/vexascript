import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "compiler/test/expect";
import { fileExists } from "compiler/utils/fs";

const ARCHITECTURE_MAP_FILE = "docs/file.structure.md";
const architecturePathReferencePattern = /`([^`]+\.(?:ts|js|json|md|my|d\.ts))`/g;
const ignoredProjectDirectories = new Set([".git", "dist", "node_modules"]);

function extractArchitectureMapSection(markdown: string): string {
  const startIndex = markdown.indexOf("## Architecture Map");
  const maintenanceRuleIndex = markdown.indexOf("### Maintenance Rule");
  const endIndex = maintenanceRuleIndex >= 0 ? maintenanceRuleIndex : markdown.length;

  expect(startIndex, `${ARCHITECTURE_MAP_FILE} should contain an Architecture Map section`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `${ARCHITECTURE_MAP_FILE} should contain an Architecture Map body`).toBeGreaterThan(startIndex);

  return markdown.slice(startIndex, endIndex);
}

function extractBacktickedPathReferences(markdown: string): string[] {
  const paths = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = architecturePathReferencePattern.exec(markdown))) {
    const codeSpan = match[1] ?? "";
    for (const part of codeSpan.split(",")) {
      const path = part.trim();
      if (path !== "") {
        paths.add(path);
      }
    }
  }

  return [...paths].sort();
}

async function collectProjectFiles(directory = "."): Promise<string[]> {
  const filePaths: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredProjectDirectories.has(entry.name)) {
        filePaths.push(...await collectProjectFiles(join(directory, entry.name)));
      }
      continue;
    }

    if (entry.isFile()) {
      filePaths.push(join(directory, entry.name).replace(/^\.\//, ""));
    }
  }

  return filePaths;
}

function globToRegExp(pattern: string): RegExp {
  const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");

  return new RegExp(`^${escapedPattern}$`);
}

describe("Architecture Map", () => {
  it("documents architecture paths in AGENTS.md", async () => {
    const architectureMap = await readFile(ARCHITECTURE_MAP_FILE, "utf8");
    const architectureMapSection = extractArchitectureMapSection(architectureMap);
    expect(extractBacktickedPathReferences(architectureMapSection)).not.toEqual([]);
  });

  it("only documents explicit architecture paths that exist", async () => {
    const architectureMap = await readFile(ARCHITECTURE_MAP_FILE, "utf8");
    const architectureMapSection = extractArchitectureMapSection(architectureMap);
    const documentedPaths = extractBacktickedPathReferences(architectureMapSection).filter((path) => !path.includes("*"));

    expect(documentedPaths).not.toEqual([]);
    for (const filePath of documentedPaths) {
      expect(await fileExists(filePath), `${filePath} is documented in AGENTS.md but does not exist`).toBe(true);
    }
  });

  it("only documents architecture globs that match existing files", async () => {
    const architectureMap = await readFile(ARCHITECTURE_MAP_FILE, "utf8");
    const architectureMapSection = extractArchitectureMapSection(architectureMap);
    const projectFiles = await collectProjectFiles();
    const documentedGlobs = extractBacktickedPathReferences(architectureMapSection).filter((path) => path.includes("*"));

    expect(documentedGlobs).not.toEqual([]);
    for (const glob of documentedGlobs) {
      const globPattern = globToRegExp(glob);
      expect(
        projectFiles.some((filePath) => globPattern.test(filePath)),
        `${glob} is documented in AGENTS.md but does not match any existing files`
      ).toBe(true);
    }
  });
});
