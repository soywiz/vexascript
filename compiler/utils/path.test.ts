import { assert, test } from "../test/expect";
import {
  basename,
  dirname,
  extname,
  fileURLToPath,
  pathToFileURL,
  relative,
  resolve
} from "./path";

test("dirname, basename, and extname operate on normalized paths", () => {
  assert.equal(dirname("/a/b/c.vx"), "/a/b");
  assert.equal(dirname("a/b"), "a");
  assert.equal(basename("/a/b/c.vx"), "c.vx");
  assert.equal(extname("/a/b/c.vx"), ".vx");
  assert.equal(extname("/a/b/.gitignore"), "");
});

test("resolve normalizes dot segments and absolute roots using strings only", () => {
  assert.equal(resolve("/workspace", "compiler", "..", "runtime", "./dom.d.ts"), "/workspace/runtime/dom.d.ts");
  assert.equal(resolve("/workspace/project", "../shared", "file.vx"), "/workspace/shared/file.vx");
});

test("Windows drive paths remain absolute after slash normalization", () => {
  assert.equal(resolve("D:/workspace", "D:\\repo\\src\\main.vx"), "D:/repo/src/main.vx");
  assert.equal(dirname("D:\\repo\\src\\main.vx"), "D:/repo/src");
  assert.equal(dirname("D:\\main.vx"), "D:/");
  assert.equal(basename("D:\\repo\\src\\main.vx"), "main.vx");
});

test("relative computes sibling and ancestor traversal", () => {
  assert.equal(relative("/workspace/src", "/workspace/src/utils/path.ts"), "utils/path.ts");
  assert.equal(relative("/workspace/src/utils", "/workspace/tests/path.test.ts"), "../../tests/path.test.ts");
  assert.equal(relative("/workspace/src", "/workspace/src"), "");
});

test("file URL helpers round-trip plain file paths", () => {
  const url = pathToFileURL("/workspace/My File.vx");
  assert.equal(url.href, "file:///workspace/My%20File.vx");
  assert.equal(fileURLToPath(url), "/workspace/My File.vx");
  assert.equal(fileURLToPath("file:///workspace/a%20b/c.vx"), "/workspace/a b/c.vx");
});
