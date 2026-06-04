import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, describe } from "node:test";
import { expect } from "../compiler/expect";
import { Analysis } from "../compiler/analysis/Analysis";
import { Parser } from "../compiler/parser/parser";
import { tokenizeReader } from "../compiler/parser/tokenizer";

describe("Parse Typescript Libraries", () => {
    it("parses testFixtures/moment.d.ts in typescript mode", () => {
        const source = readFileSync(resolve(__dirname, "moment.d.ts"), "utf8");

        const parser = new Parser(tokenizeReader(source), { language: "typescript" });
        const ast = parser.parseFile();

        expect(ast.kind).toBe("Program");
        expect(ast.body[0]?.kind).toBe("FunctionStatement");
        expect((ast.body[0] as { declared?: boolean } | undefined)?.declared).toBe(true);
        expect(parser.tokens.hasMore).toBe(false);
        expect(parser.errors).toEqual([]);
        expect(() => new Analysis(ast)).not.toThrow();
    });

    it("parses testFixtures/typescript-supported.d.ts in typescript mode", () => {
        const source = readFileSync(resolve(__dirname, "typescript-supported.d.ts"), "utf8");

        const parser = new Parser(tokenizeReader(source), { language: "typescript" });
        const ast = parser.parseFile();

        expect(ast.kind).toBe("Program");
        expect(ast.body[0]?.kind).toBe("FunctionStatement");
        expect((ast.body[0] as { declared?: boolean } | undefined)?.declared).toBe(true);
        expect(ast.body[1]?.kind).toBe("NamespaceStatement");
        expect(ast.body[2]?.kind).toBe("ExprStatement");
        expect(parser.tokens.hasMore).toBe(false);
        expect(parser.errors).toEqual([]);
    });

    it("parses testFixtures/PIXI.d.ts in typescript mode", () => {
        const source = readFileSync(resolve(__dirname, "./PIXI.d.ts"), "utf8");

        const parser = new Parser(tokenizeReader(source), { language: "typescript" });
        const ast = parser.parseFile();

        expect(ast.kind).toBe("Program");
        expect(parser.tokens.hasMore).toBe(false);
        expect(parser.errors).toEqual([]);
    });

    it("parses testFixtures/threejs.d.ts in typescript mode", () => {
        const source = readFileSync(resolve(__dirname, "./threejs.d.ts"), "utf8");

        const parser = new Parser(tokenizeReader(source), { language: "typescript" });
        const ast = parser.parseFile();

        expect(ast.kind).toBe("Program");
        expect(parser.tokens.hasMore).toBe(false);
        expect(parser.errors).toEqual([]);
    });

})
