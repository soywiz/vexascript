import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { compileSource } from "compiler/pipeline/compile";
import type { Analysis } from "compiler/analysis/Analysis";
import type { Program } from "compiler/ast/ast";

export interface ProjectSessionLike {
  ast: Program | null;
  analysis: Analysis | null;
}

export interface ProjectContext {
  sourceRoots?: string[];
  getSessionForFilePath?: (filePath: string) => ProjectSessionLike | null;
}

export function scanProjectMyFiles(sourceRoots: string[]): string[] {
  const files: string[] = [];
  const stack = [...sourceRoots];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".my") {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function getProjectSessionForFilePath(
  filePath: string,
  context: ProjectContext
): ProjectSessionLike | null {
  if (context.getSessionForFilePath) {
    const provided = context.getSessionForFilePath(filePath);
    if (provided) {
      return provided;
    }
  }

  if (!existsSync(filePath)) {
    return null;
  }

  const source = readFileSync(filePath, "utf8");
  const compiled = compileSource(source);
  return {
    ast: compiled.ast,
    analysis: compiled.analysis
  };
}

