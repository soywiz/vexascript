import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { it } from "vitest";
import { describe } from "vitest";
import { Parser } from "../compiler/parser/parser";
import { tokenizeReader } from "../compiler/parser/tokenizer";

describe("Parse Typescript Libraries", () => {
    it("parses testFixtures/moment.d.ts in typescript mode", () => {
        const source = readFileSync(resolve(__dirname, "moment.d.ts"), "utf8");

        const parser = new Parser(tokenizeReader(source), { language: "typescript" });
        const ast = parser.parseFile();

        //console.log(JSON.stringify(ast));

        expect(ast.kind).toBe("Program");
        expect(parser.tokens.hasMore).toBe(false);
    });

})