const test = require("node:test");
const assert = require("node:assert/strict");
const { currentAutoAwaitDecorations } = require("./autoAwaitDecorations.js");

test("keeps existing auto-await gutter icons while fresh semantic analysis is unavailable", () => {
  assert.equal(currentAutoAwaitDecorations(null, 2, 2), undefined);
});

test("accepts an empty decoration result only for the requested document version", () => {
  assert.deepEqual(currentAutoAwaitDecorations([], 2, 2), []);
  assert.equal(currentAutoAwaitDecorations([], 2, 3), undefined);
});
