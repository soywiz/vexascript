/**
 * Shared cache/loader plumbing for embedded runtime declaration programs
 * (ECMAScript and DOM). Centralizes the parse-with-error-check, the node
 * membership index, and the concurrency contract: concurrent callers share a
 * single in-flight load, and a failed load is cleared so a later call can
 * retry instead of caching the rejection forever.
 */
import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { parseSource } from "compiler/pipeline/parse";

export interface CachedDeclarationProgram {
  program: Program;
  nodes: WeakSet<object>;
}

/** Indexes every node of a parsed program for fast membership checks. */
export function collectProgramNodes(root: Program): WeakSet<object> {
  const nodes = new WeakSet<object>();
  walkAst(root, (node) => {
    nodes.add(node);
  });
  return nodes;
}

/** Parses embedded TypeScript declaration sources, throwing when any issue is found. */
export function parseDeclarationProgram(source: string, description: string): Program {
  const parsed = parseSource(source, { language: "typescript" });
  const errors = [
    ...parsed.parserIssues.map((issue) => issue.message),
    ...(parsed.tokenizeError ? [parsed.tokenizeError.message] : []),
    ...(parsed.fatalError ? [parsed.fatalError] : [])
  ];
  if (!parsed.ast || errors.length > 0) {
    throw new Error(`${description} must parse without errors: ${errors.join("; ")}`);
  }
  return parsed.ast;
}

export class DeclarationProgramCache<T extends CachedDeclarationProgram> {
  private cached: T | null = null;
  private pending: Promise<T> | null = null;

  constructor(private readonly load: () => Promise<T>) {}

  /** Returns the loaded entry without triggering a load. */
  get(): T | null {
    return this.cached;
  }

  async ensure(): Promise<T> {
    if (this.cached) {
      return this.cached;
    }

    if (!this.pending) {
      this.pending = this.load();
    }
    try {
      this.cached = await this.pending;
    } catch (error) {
      this.pending = null;
      throw error;
    }

    return this.cached;
  }

  /** True when the node belongs to the loaded declaration program. */
  hasNode(node: Node): boolean {
    return this.cached?.nodes.has(node) === true;
  }
}
