import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { it, describe } from "node:test";
import { expect } from "../compiler/test/expect";
import { Analysis } from "../compiler/analysis/Analysis";
import { Parser } from "../compiler/parser/parser";
import { tokenizeReader } from "../compiler/parser/tokenizer";

async function collectDeclarationFiles(rootDir: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
        .map((entry) => join("parentPath" in entry && typeof entry.parentPath === "string" ? entry.parentPath : rootDir, entry.name))
        .sort();
}

describe("Parse Typescript Libraries", () => {
    it("parses testFixtures/moment.d.ts in typescript mode", async () => {
        const source = await readFile(resolve(import.meta.dirname, "moment.d.ts"), "utf8");

        const parser = new Parser(tokenizeReader(source), { language: "typescript" });
        const ast = parser.parseFile();

        expect(ast.kind).toBe("Program");
        expect(ast.body[0]?.kind).toBe("FunctionStatement");
        expect((ast.body[0] as { declared?: boolean } | undefined)?.declared).toBe(true);
        expect(parser.tokens.hasMore).toBe(false);
        expect(parser.errors).toEqual([]);
        expect(() => new Analysis(ast)).not.toThrow();
    });

    it("parses testFixtures/typescript-supported.d.ts in typescript mode", async () => {
        const source = await readFile(resolve(import.meta.dirname, "typescript-supported.d.ts"), "utf8");

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

    it("parses testFixtures/PIXI.d.ts in typescript mode", async () => {
        const source = await readFile(resolve(import.meta.dirname, "./PIXI.d.ts"), "utf8");

        const parser = new Parser(tokenizeReader(source), { language: "typescript" });
        const ast = parser.parseFile();

        expect(ast.kind).toBe("Program");
        expect(parser.tokens.hasMore).toBe(false);
        expect(parser.errors).toEqual([]);
    });

    it("parses testFixtures/threejs.d.ts in typescript mode", async () => {
        const source = await readFile(resolve(import.meta.dirname, "./threejs.d.ts"), "utf8");

        const parser = new Parser(tokenizeReader(source), { language: "typescript" });
        const ast = parser.parseFile();

        expect(ast.kind).toBe("Program");
        expect(parser.tokens.hasMore).toBe(false);
        expect(parser.errors).toEqual([]);
    });

    it("parses every declaration under testFixtures/@types_typescript without parser errors", async () => {
        const files = await collectDeclarationFiles(resolve(import.meta.dirname, "@types_typescript"));

        for (const file of files) {
            const source = await readFile(file, "utf8");
            const parser = new Parser(tokenizeReader(source, { jsx: false }), { language: "typescript" });
            parser.parseFile();
            expect(parser.tokens.hasMore).toBe(false);
            expect(parser.errors).toEqual([]);
        }
    });

    it("parses every declaration under testFixtures/@types_node without parser errors", async () => {
        const files = await collectDeclarationFiles(resolve(import.meta.dirname, "@types_node"));

        for (const file of files) {
            const source = await readFile(file, "utf8");
            const parser = new Parser(tokenizeReader(source, { jsx: false }), { language: "typescript" });
            parser.parseFile();
            expect(parser.tokens.hasMore).toBe(false);
            expect(parser.errors).toEqual([]);
        }
    });

})
