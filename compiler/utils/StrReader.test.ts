import { describe, it } from "node:test";
import { expect } from "../../vitest";
import { StrReader } from "./StrReader";

describe("StrReader", () => {
    it("reads characters in order", () => {
        const reader = new StrReader("abc");

        expect(reader.read()).toBe("a");
        expect(reader.read()).toBe("b");
        expect(reader.read()).toBe("c");
    });

    it("supports peek without consuming", () => {
        const reader = new StrReader("xyz");

        expect(reader.peek()).toBe("x");
        expect(reader.peek()).toBe("x");
        expect(reader.read()).toBe("x");
        expect(reader.peek()).toBe("y");
    });

    it("supports peekCode and readCode", () => {
        const reader = new StrReader("AZ");

        expect(reader.peekCode()).toBe("A".charCodeAt(0));
        expect(reader.readCode()).toBe("A".charCodeAt(0));
        expect(reader.peekCode()).toBe("Z".charCodeAt(0));
        expect(reader.readCode()).toBe("Z".charCodeAt(0));
    });

    it("tracks eof and hasMore correctly", () => {
        const reader = new StrReader("hi");

        expect(reader.hasMore).toBe(true);
        expect(reader.eof).toBe(false);

        reader.read();
        reader.read();

        expect(reader.hasMore).toBe(false);
        expect(reader.eof).toBe(true);
    });

    it("supports skip with custom count", () => {
        const reader = new StrReader("hello");

        reader.skip(2);
        expect(reader.read()).toBe("l");
        expect(reader.offset).toBe(3);
    });

    it("tracks line and column while reading", () => {
        const reader = new StrReader("a\nbc");

        expect(reader.line).toBe(0);
        expect(reader.column).toBe(0);

        reader.read(); // a
        expect(reader.line).toBe(0);
        expect(reader.column).toBe(1);

        reader.read(); // \n
        expect(reader.line).toBe(1);
        expect(reader.column).toBe(0);

        reader.read(); // b
        expect(reader.line).toBe(1);
        expect(reader.column).toBe(1);
    });

    it("returns empty string at eof when reading or peeking", () => {
        const reader = new StrReader("a");

        reader.read();

        expect(reader.peek()).toBe("");
        expect(reader.read()).toBe("");
        expect(reader.eof).toBe(true);
    });

    it("returns NaN at eof for code readers", () => {
        const reader = new StrReader("a");
        reader.readCode();

        expect(Number.isNaN(reader.peekCode())).toBe(true);
        expect(Number.isNaN(reader.readCode())).toBe(true);
    });

    it("reports source length", () => {
        const reader = new StrReader("mylang");
        expect(reader.length).toBe(6);
    });
});
