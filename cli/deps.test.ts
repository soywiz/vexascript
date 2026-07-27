import { describe, expect, it } from "../compiler/test/expect";
import { packageManagerCommand } from "./deps";

describe("package manager command", () => {
  it("uses the Windows command shim when running on Windows", () => {
    expect(packageManagerCommand("win32")).toBe("pnpm.cmd");
    expect(packageManagerCommand("darwin")).toBe("pnpm");
    expect(packageManagerCommand("linux")).toBe("pnpm");
  });
});
