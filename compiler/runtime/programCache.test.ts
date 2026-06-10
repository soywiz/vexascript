import { describe, it } from "node:test";
import { expect } from "../test/expect";
import { cacheProgram } from "./programCache";
import type { Program } from "compiler/ast/ast";

describe("runtime program cache", () => {
  it("stores and reloads programs by source path and hash in localStorage", async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storageState = new Map<string, string>();
    const fakeStorage = {
      getItem(key: string): string | null {
        return storageState.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        storageState.set(key, value);
      },
    };

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: fakeStorage,
    });

    try {
      const sourceFilePath = "/runtime/runtime.d.ts";
      const program: Program = {
        kind: "Program",
        body: [
          {
            kind: "VarStatement",
            declarationKind: "const",
            name: { kind: "Identifier", name: "answer" },
            declarations: []
          } as unknown as Program["body"][number]
        ]
      };
      let generateCount = 0;

      const first = await cacheProgram(sourceFilePath, "hash-a", async () => {
        generateCount += 1;
        return program;
      });
      const second = await cacheProgram(sourceFilePath, "hash-a", async () => {
        generateCount += 1;
        return {
          ...program,
          body: [],
        };
      });
      const third = await cacheProgram(sourceFilePath, "hash-b", async () => {
        generateCount += 1;
        return {
          ...program,
          body: [],
        };
      });

      expect(storageState.has("vexa.runtime.program-cache.v1./runtime/runtime.d.ts")).toBe(true);
      expect(storageState.has("vexa.runtime.program-cache.v1./runtime/runtime.d.ts_hash")).toBe(true);
      expect(first).toEqual(program);
      expect(second).toEqual(program);
      expect(third.body).toEqual([]);
      expect(generateCount).toBe(2);
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(globalThis, "localStorage", previousDescriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });

  it("falls back to in-memory storage when localStorage is unavailable", async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    delete (globalThis as { localStorage?: unknown }).localStorage;

    try {
      const sourceFilePath = "/runtime/fallback.d.ts";
      const program: Program = {
        kind: "Program",
        body: []
      };
      let generateCount = 0;

      const first = await cacheProgram(sourceFilePath, "hash-a", async () => {
        generateCount += 1;
        return program;
      });
      const second = await cacheProgram(sourceFilePath, "hash-a", async () => {
        generateCount += 1;
        return {
          ...program,
          body: [
            {
              kind: "VarStatement",
              declarationKind: "const",
              name: { kind: "Identifier", name: "later" },
              declarations: []
            } as unknown as Program["body"][number]
          ]
        };
      });

      expect(first).toEqual(program);
      expect(second).toEqual(program);
      expect(generateCount).toBe(1);
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(globalThis, "localStorage", previousDescriptor);
      }
    }
  });
});
