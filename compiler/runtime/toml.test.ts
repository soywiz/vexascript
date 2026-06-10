import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseToml } from "./toml";

test("empty document", () => {
  assert.deepEqual(parseToml(""), {});
});

test("comments and blank lines are ignored", () => {
  assert.deepEqual(parseToml("# just a comment\n\n"), {});
});

test("top-level key-value string", () => {
  const doc = parseToml('name = "vexa"');
  assert.equal((doc[""] as Record<string, string>)["name"], "vexa");
});

test("section with string values", () => {
  const doc = parseToml('[dependencies]\nlodash = "^4.17.21"\naxios = "^1.0.0"');
  assert.deepEqual(doc["dependencies"], { lodash: "^4.17.21", axios: "^1.0.0" });
});

test("section with single-quoted string", () => {
  const doc = parseToml("[dependencies]\nfoo = '1.0.0'");
  assert.deepEqual(doc["dependencies"], { foo: "1.0.0" });
});

test("inline array of strings", () => {
  const doc = parseToml('[section]\nlist = ["a", "b", "c"]');
  assert.deepEqual(doc["section"], { list: ["a", "b", "c"] });
});

test("inline comment stripped", () => {
  const doc = parseToml('[deps]\nfoo = "1.0" # trailing comment');
  assert.deepEqual(doc["deps"], { foo: "1.0" });
});

test("multiple sections", () => {
  const doc = parseToml('[a]\nx = "1"\n[b]\ny = "2"');
  assert.deepEqual(doc["a"], { x: "1" });
  assert.deepEqual(doc["b"], { y: "2" });
});
