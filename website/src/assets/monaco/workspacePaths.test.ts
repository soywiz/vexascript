import { describe, expect, it } from "../../../../compiler/test/expect";
import {
  normalizeWorkspacePath,
  workspacePathBasename,
  workspacePathDirname,
  workspacePathToUri
} from "./workspacePaths";

describe("workspace path helpers", () => {
  it("forces a leading slash and collapses duplicate slashes", () => {
    expect(normalizeWorkspacePath("main.vx")).toBe("/main.vx");
    expect(normalizeWorkspacePath(" //src//util.vx ")).toBe("/src/util.vx");
    expect(normalizeWorkspacePath("src\\nested\\file.vx")).toBe("/src/nested/file.vx");
  });

  it("keeps dot segments verbatim instead of resolving them", () => {
    expect(normalizeWorkspacePath("/src/../main.vx")).toBe("/src/../main.vx");
  });

  it("computes dirname and basename on normalized paths", () => {
    expect(workspacePathDirname("/src/nested/file.vx")).toBe("/src/nested");
    expect(workspacePathDirname("/main.vx")).toBe("/");
    expect(workspacePathDirname("main.vx")).toBe("/");
    expect(workspacePathBasename("/src/nested/file.vx")).toBe("file.vx");
    expect(workspacePathBasename("main.vx")).toBe("main.vx");
  });

  it("builds file URIs from workspace paths", () => {
    expect(workspacePathToUri("main.vx")).toBe("file:///main.vx");
    expect(workspacePathToUri("/src//util.vx")).toBe("file:///src/util.vx");
  });
});
