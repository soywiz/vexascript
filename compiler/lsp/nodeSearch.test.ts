import { describe, it } from "node:test";
import type { BinaryExpression, Identifier } from "compiler/ast/ast";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import { expect } from "compiler/test/expect";
import { findBestMatch, findBestMatchAtPosition, findNodeAtPosition, findNodeContainingRange } from "./nodeSearch";
import { nodeRange, type Position } from "./ranges";

function parse(source: string) {
  return parseFile(tokenizeReader(source));
}

function positionOf(source: string, search: string): Position {
  const offset = source.indexOf(search);
  if (offset === -1) {
    throw new Error(`Could not find ${search}`);
  }
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return {
    line: lines.length - 1,
    character: lines[lines.length - 1]!.length
  };
}

function isBinaryExpression(node: import("compiler/ast/ast").Node): node is BinaryExpression {
  return node.kind === "BinaryExpression";
}

function isIdentifier(node: import("compiler/ast/ast").Node): node is Identifier {
  return node.kind === "Identifier";
}

describe("nodeSearch", () => {
  it("finds the smallest matching node at a position by default", () => {
    const source = "let value = prefix + name + suffix";
    const ast = parse(source);

    const match = findNodeAtPosition(ast, positionOf(source, "name"), isIdentifier);

    expect(match?.name).toBe("name");
  });

  it("can prefer the largest matching node at a position", () => {
    const source = "let value = prefix + name + suffix";
    const ast = parse(source);

    const match = findNodeAtPosition(ast, positionOf(source, "name"), isBinaryExpression, "largest");

    expect(match?.kind).toBe("BinaryExpression");
    expect(match ? source.slice(match.firstToken!.range.start.offset, match.lastToken!.range.end.offset) : null)
      .toBe("prefix + name + suffix");
  });

  it("finds the smallest matching node that contains a range", () => {
    const source = "let value = prefix + name + suffix";
    const ast = parse(source);
    const name = findNodeAtPosition(ast, positionOf(source, "name"), isIdentifier);
    const nameRange = name ? nodeRange(name) : null;

    const match = nameRange ? findNodeContainingRange(ast, nameRange, isBinaryExpression) : null;

    expect(match?.kind).toBe("BinaryExpression");
    expect(match ? source.slice(match.firstToken!.range.start.offset, match.lastToken!.range.end.offset) : null)
      .toBe("prefix + name");
  });

  it("ranks matcher-provided candidates by size with ties favoring later matches", () => {
    const source = "let value = prefix + name + suffix";
    const ast = parse(source);

    const match = findBestMatch(ast, (node) => {
      if (!isIdentifier(node)) {
        return null;
      }
      return { size: 1, value: node.name };
    });

    expect(match).toBe("suffix");
  });

  it("only builds results for candidates containing the position and keeps prior matches when a build is discarded", () => {
    const source = "let value = combine(alpha, beta)";
    const ast = parse(source);
    const built: string[] = [];

    const match = findBestMatchAtPosition(ast, positionOf(source, "alpha"), (node) => {
      if (node.kind === "CallExpression") {
        const range = nodeRange(node);
        return range ? { range, build: () => "call" } : null;
      }
      if (!isIdentifier(node)) {
        return null;
      }
      const range = nodeRange(node);
      if (!range) {
        return null;
      }
      return {
        range,
        build: () => {
          built.push(node.name);
          // Discarding the smaller identifier candidate keeps the call match.
          return null;
        }
      };
    });

    expect(match).toBe("call");
    expect(built).toEqual(["alpha"]);
  });

  it("supports several position candidates per node with custom ranking sizes", () => {
    const source = "let value = combine(alpha, beta)";
    const ast = parse(source);

    const match = findBestMatchAtPosition(ast, positionOf(source, "alpha"), (node) => {
      if (node.kind !== "CallExpression") {
        return null;
      }
      const call = node as import("compiler/ast/ast").CallExpression;
      return call.arguments.flatMap((argument, index) => {
        const range = nodeRange(argument);
        return range ? [{ range, size: index, build: () => index }] : [];
      });
    });

    expect(match).toBe(0);
  });
});
