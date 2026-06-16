import { describe, expect, it } from "../test/expect";
import { cacheProgram } from "./programCache";
import type { Program } from "compiler/ast/ast";
import { globalVfs, setVfs, Vfs } from "compiler/vfs";

describe("runtime program cache", () => {
  it("stores and reloads programs by source path and hash in localStorage", async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
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
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {},
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

      expect(storageState.has("vexa.runtime.program-cache.v2./runtime/runtime.d.ts")).toBe(true);
      expect(storageState.has("vexa.runtime.program-cache.v2./runtime/runtime.d.ts_hash")).toBe(true);
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
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        delete (globalThis as { window?: unknown }).window;
      }
      if (previousDocument) {
        Object.defineProperty(globalThis, "document", previousDocument);
      } else {
        delete (globalThis as { document?: unknown }).document;
      }
    }
  });

  it("uses the bound vfs in Node without touching localStorage", async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const previousVfs = globalVfs.ref;
    const previousBuiltinModule = process.getBuiltinModule;
    const writes = new Map<string, string>();
    let localStorageReads = 0;
    let builtinModuleReads = 0;

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        localStorageReads += 1;
        throw new Error("localStorage should not be touched in Node");
      },
    });

    class FakeVfs extends Vfs {
      override async readFile(path: string): Promise<string> {
        const value = writes.get(path);
        if (!value) {
          throw new Error(`missing ${path}`);
        }
        return value;
      }

      override async writeFile(path: string, data: string | ArrayBufferView): Promise<void> {
        writes.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
      }
    }

    setVfs(new FakeVfs());
    process.getBuiltinModule = ((id: string) => {
      builtinModuleReads += 1;
      return previousBuiltinModule.call(process, id);
    }) as typeof process.getBuiltinModule;

    try {
      const sourceFilePath = "/runtime/node-vfs.d.ts";
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
          body: [{
            kind: "VarStatement",
            declarationKind: "const",
            name: { kind: "Identifier", name: "later" },
            declarations: []
          } as unknown as Program["body"][number]]
        };
      });

      expect(first).toEqual(program);
      expect(second).toEqual(program);
      expect(generateCount).toBe(1);
      expect(localStorageReads).toBe(0);
      expect(builtinModuleReads).toBe(0);
      expect(writes.size).toBe(1);
    } finally {
      setVfs(previousVfs);
      process.getBuiltinModule = previousBuiltinModule;
      if (previousDescriptor) {
        Object.defineProperty(globalThis, "localStorage", previousDescriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });
});
