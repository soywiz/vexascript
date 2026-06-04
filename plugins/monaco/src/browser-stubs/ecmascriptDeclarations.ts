/**
 * Browser-compatible replacement for compiler/runtime/ecmascriptDeclarations.ts.
 * Instead of reading the .d.my file from disk at runtime, it is inlined via
 * Vite's ?raw import so the worker bundle is fully self-contained.
 */

import rawSource from "../../../../compiler/runtime/ecmascript.d.my?raw";
import { parseSource } from "compiler/pipeline/parse";
import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";

export const ECMASCRIPT_RUNTIME_DECLARATION_FILE_NAME = "ecmascript.d.my";

let cachedProgram: Program | null = null;
let cachedNodes: WeakSet<object> | null = null;

function collectNodes(root: Program): WeakSet<object> {
  const nodes = new WeakSet<object>();
  walkAst(root, (node) => nodes.add(node));
  return nodes;
}

export function getEcmaScriptRuntimeDeclarationFilePath(): string {
  return ECMASCRIPT_RUNTIME_DECLARATION_FILE_NAME;
}

export function getEcmaScriptRuntimeProgram(): Program {
  if (cachedProgram) return cachedProgram;
  const parsed = parseSource(rawSource);
  if (!parsed.ast) {
    const errors = [
      ...(parsed.parserIssues ?? []).map((i) => i.message),
      ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
      ...(parsed.fatalError ? [parsed.fatalError] : []),
    ];
    throw new Error(
      `ECMAScript declarations failed to parse: ${errors.join("; ")}`
    );
  }
  cachedProgram = parsed.ast;
  cachedNodes = collectNodes(cachedProgram);
  return cachedProgram;
}

export function isEcmaScriptRuntimeNode(node: Node): boolean {
  if (!cachedProgram || !cachedNodes) return false;
  return cachedNodes.has(node);
}
