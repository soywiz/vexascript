import { describe, it } from "node:test";
import { expect } from "compiler/test/expect";
import type { Node, Program } from "compiler/ast/ast";
import {
  collectProgramNodes,
  DeclarationProgramCache,
  parseDeclarationProgram
} from "./declarationProgramCache";

function fakeProgram(): Program {
  const literal: Node = { kind: "IntLiteral" };
  return { kind: "Program", body: [literal] } as unknown as Program;
}

describe("DeclarationProgramCache", () => {
  it("shares a single in-flight load across concurrent callers", async () => {
    let loads = 0;
    const cache = new DeclarationProgramCache(async () => {
      loads += 1;
      const program = fakeProgram();
      return { program, nodes: collectProgramNodes(program) };
    });

    const [first, second] = await Promise.all([cache.ensure(), cache.ensure()]);
    const third = await cache.ensure();

    expect(loads).toBe(1);
    expect(first).toBe(second);
    expect(third).toBe(first);
  });

  it("retries after a failed load instead of caching the rejection", async () => {
    let loads = 0;
    const cache = new DeclarationProgramCache(async () => {
      loads += 1;
      if (loads === 1) {
        throw new Error("declaration source unavailable");
      }
      const program = fakeProgram();
      return { program, nodes: collectProgramNodes(program) };
    });

    await expect(cache.ensure()).rejects.toThrow("declaration source unavailable");
    const loaded = await cache.ensure();

    expect(loads).toBe(2);
    expect(loaded.program.kind).toBe("Program");
  });

  it("answers node membership only after the program is loaded", async () => {
    const program = fakeProgram();
    const cache = new DeclarationProgramCache(async () => ({
      program,
      nodes: collectProgramNodes(program)
    }));
    const programNode = program.body[0] as Node;

    expect(cache.get()).toBe(null);
    expect(cache.hasNode(programNode)).toBe(false);

    await cache.ensure();

    expect(cache.get()?.program).toBe(program);
    expect(cache.hasNode(programNode)).toBe(true);
    expect(cache.hasNode({ kind: "Identifier" })).toBe(false);
  });
});

describe("parseDeclarationProgram", () => {
  it("parses valid TypeScript declaration sources", () => {
    const program = parseDeclarationProgram("declare const answer: number;", "Test declarations");

    expect(program.kind).toBe("Program");
    expect(program.body.length).toBeGreaterThan(0);
  });

  it("throws with the provided description when the source does not parse", () => {
    expect(() => parseDeclarationProgram("declare const = ;", "Test declarations"))
      .toThrow(/Test declarations must parse without errors/);
  });
});
