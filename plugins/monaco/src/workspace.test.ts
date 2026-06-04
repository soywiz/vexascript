import { describe, it } from "node:test";
import { expect } from "../../../compiler/test/expect";
import {
  persistWorkspaceContent,
  resolveWorkspaceContent,
  WORKSPACE_STORAGE_KEY,
  type StorageLike,
} from "./workspace";

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("monaco static workspace", () => {
  it("uses bundled content when storage is empty", () => {
    expect(resolveWorkspaceContent("default", new MemoryStorage())).toBe("default");
  });

  it("prefers stored content over bundled content", () => {
    const storage = new MemoryStorage();
    persistWorkspaceContent("saved", storage);

    expect(resolveWorkspaceContent("default", storage)).toBe("saved");
    expect(storage.getItem(WORKSPACE_STORAGE_KEY)).toBe("saved");
  });
});
