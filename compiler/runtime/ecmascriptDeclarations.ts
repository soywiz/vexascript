import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Program } from "compiler/ast/ast";
import { Parser } from "compiler/parser/parser";
import { tokenize } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";

export const ECMASCRIPT_RUNTIME_DECLARATION_FILE_NAME = "ecmascript.d.my";

interface CachedRuntimeProgram {
  filePath: string;
  mtimeMs: number;
  program: Program;
  nodes: WeakSet<object>;
}

let cachedRuntimeProgram: CachedRuntimeProgram | null = null;

function currentDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function getEcmaScriptRuntimeDeclarationFilePath(): string {
  const bundledPath = resolve(currentDirectory(), ECMASCRIPT_RUNTIME_DECLARATION_FILE_NAME);
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return resolve(process.cwd(), "compiler", "runtime", ECMASCRIPT_RUNTIME_DECLARATION_FILE_NAME);
}

function collectNodes(root: Program): WeakSet<object> {
  const nodes = new WeakSet<object>();
  const seen = new WeakSet<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) {
      return;
    }
    seen.add(objectValue);

    if (typeof objectValue["kind"] === "string") {
      nodes.add(objectValue);
    }

    for (const child of Object.values(objectValue)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          visit(item);
        }
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  };

  visit(root);
  return nodes;
}

function parseRuntimeProgram(filePath: string): Program {
  const source = readFileSync(filePath, "utf8");
  const tokens = tokenize(source);
  const parser = new Parser(new ListReader(tokens));
  const program = parser.parseFile();
  if (parser.errors.length > 0) {
    throw new Error(
      `Embedded ECMAScript runtime declarations must parse without errors: ${parser.errors
        .map((issue) => issue.message)
        .join("; ")}`
    );
  }
  return program;
}

export function getEcmaScriptRuntimeProgram(): Program {
  const filePath = getEcmaScriptRuntimeDeclarationFilePath();
  const mtimeMs = statSync(filePath).mtimeMs;
  if (
    cachedRuntimeProgram &&
    cachedRuntimeProgram.filePath === filePath &&
    cachedRuntimeProgram.mtimeMs === mtimeMs
  ) {
    return cachedRuntimeProgram.program;
  }

  const program = parseRuntimeProgram(filePath);
  cachedRuntimeProgram = {
    filePath,
    mtimeMs,
    program,
    nodes: collectNodes(program)
  };
  return program;
}

export function isEcmaScriptRuntimeNode(node: Node): boolean {
  const program = getEcmaScriptRuntimeProgram();
  return cachedRuntimeProgram?.program === program && cachedRuntimeProgram.nodes.has(node) === true;
}
