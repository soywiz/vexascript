import { describe, expect, it } from "vitest";
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

    it("returns empty string at eof when reading or peeking", () => {
        const reader = new StrReader("a");

        reader.read();

        expect(reader.peek()).toBe("");
        expect(reader.read()).toBe("");
        expect(reader.eof).toBe(true);
    });

    it("reports source length", () => {
        const reader = new StrReader("mylang");
        expect(reader.length).toBe(6);
    });
});
