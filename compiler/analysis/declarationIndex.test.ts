import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { bindingIdentifiers } from "../ast/bindingPatterns";
import { parseSource } from "../pipeline/parse";
import { declarationIndexForStatements } from "./declarationIndex";

describe("declarationIndex", () => {
  it("indexes top-level declarations in one pass and caches by statement array", () => {
    const source = `
      export interface TopLevel { value: string }
      export class Box {}
      export type Alias = string
      export enum Direction { Up }
      export const answer = 42
    `;
    const ast = parseSource(source, { language: "typescript" }).ast;
    if (!ast) {
      throw new Error("Expected AST");
    }

    const first = declarationIndexForStatements(ast.body);
    const second = declarationIndexForStatements(ast.body);

    expect(second).toBe(first);
    expect(first.interfaces.map((statement) => statement.name.name)).toEqual(["TopLevel"]);
    expect(first.namespaces).toHaveLength(0);
    expect(first.functions).toHaveLength(0);
    expect(first.classes.map((statement) => statement.name.name)).toEqual(["Box"]);
    expect(first.typeAliases.map((statement) => statement.name.name)).toEqual(["Alias"]);
    expect(first.enums.map((statement) => statement.name.name)).toEqual(["Direction"]);
    expect(first.vars.flatMap((statement) => [...bindingIdentifiers(statement.name)].map((identifier) => identifier.name))).toEqual(["answer"]);
    expect(first.nestedNamespaceDeclarations).toHaveLength(0);
  });
});
