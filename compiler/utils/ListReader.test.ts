import { describe, expect, it } from "vitest";
import { ListReader } from "./ListReader";

describe("ListReader", () => {
    it("ListReader", () => {
        const lr = new ListReader([1, 2, 3])
        expect(lr.read()).toBe(1)
        expect(lr.read()).toBe(2)
        expect(lr.read()).toBe(3)
    })
})