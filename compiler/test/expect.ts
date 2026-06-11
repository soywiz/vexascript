// Local expect adapter: re-exports node:test and wraps node:assert as expect().
// Tests import from "../../expect" which resolves here via the scripts/resolver.mjs hook.
import "../localVfs";
import { describe, it, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

export { describe, it, test, beforeEach, afterEach };
export { before as beforeAll, after as afterAll };

// ─── expect ──────────────────────────────────────────────────────────────────

export function expect(actual: unknown, message?: string) {
  return makeExpect(actual, false, message);
}

expect.arrayContaining = (arr: unknown[]) => ({ __type: "arrayContaining", arr });
expect.objectContaining = (obj: object) => ({ __type: "objectContaining", obj });
expect.stringContaining = (s: string) => ({ __type: "stringContaining", s });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
expect.any = (ctor: abstract new (...a: any[]) => unknown) => ({ __type: "any", ctor });

function makeExpect(actual: unknown, negated: boolean, message?: string) {
  function fail(msg: string): never {
    throw new Error(message ? `${message}\n${msg}` : msg);
  }
  return {
    get not() { return makeExpect(actual, !negated, message); },

    get rejects() {
      return {
        async toThrow(msg?: string | RegExp) {
          let threw = false, error: unknown;
          try { await actual; } catch (e) { threw = true; error = e; }
          if (negated ? threw : !threw)
            throw new Error(`Expected promise to ${negated ? "not " : ""}reject`);
          if (!negated && msg != null) checkThrowMsg(error, msg);
        },
      };
    },

    toBe(expected: unknown) {
      const ok = actual === expected;
      if (negated ? ok : !ok) fail(`Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to be ${JSON.stringify(expected)}`);
    },
    toEqual(expected: unknown) {
      const eq = expectDeepEqual(actual, expected);
      if (negated ? eq : !eq) {
        // Use assert for nice diff output
        negated
          ? assert.notDeepStrictEqual(actual, expected as never)
          : assert.deepStrictEqual(normalizeUndefined(actual), normalizeUndefined(expected));
      }
    },
    toStrictEqual(expected: unknown) {
      negated
        ? assert.notDeepStrictEqual(actual, expected as never)
        : assert.deepStrictEqual(actual, expected);
    },
    toContain(item: unknown) {
      const has = Array.isArray(actual)
        ? (actual as unknown[]).includes(item)
        : String(actual).includes(String(item));
      if (negated ? has : !has)
        throw new Error(`Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to contain ${JSON.stringify(item)}`);
    },
    toContainEqual(item: unknown) {
      const has = Array.isArray(actual) && (actual as unknown[]).some(x => deepEqual(x, item));
      if (negated ? has : !has)
        throw new Error(`Expected array to ${negated ? "not " : ""}contain equal ${JSON.stringify(item)}`);
    },
    toBeTruthy() {
      if (negated ? !!actual : !actual)
        throw new Error(`Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to be truthy`);
    },
    toBeFalsy() {
      if (negated ? !actual : !!actual)
        throw new Error(`Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to be falsy`);
    },
    toBeDefined() {
      if (negated ? actual !== undefined : actual === undefined)
        throw new Error(`Expected value to ${negated ? "not " : ""}be defined`);
    },
    toBeUndefined() {
      if (negated ? actual === undefined : actual !== undefined)
        throw new Error(`Expected ${JSON.stringify(actual)} to ${negated ? "not " : ""}be undefined`);
    },
    toBeNull() {
      if (negated ? actual === null : actual !== null)
        throw new Error(`Expected ${JSON.stringify(actual)} to ${negated ? "not " : ""}be null`);
    },
    toBeGreaterThan(n: number) {
      if (negated ? (actual as number) > n : (actual as number) <= n)
        fail(`Expected ${actual} to ${negated ? "not " : ""}be > ${n}`);
    },
    toBeGreaterThanOrEqual(n: number) {
      if (negated ? (actual as number) >= n : (actual as number) < n)
        fail(`Expected ${actual} to ${negated ? "not " : ""}be >= ${n}`);
    },
    toBeLessThan(n: number) {
      if (negated ? (actual as number) < n : (actual as number) >= n)
        throw new Error(`Expected ${actual} to ${negated ? "not " : ""}be < ${n}`);
    },
    toBeLessThanOrEqual(n: number) {
      if (negated ? (actual as number) <= n : (actual as number) > n)
        throw new Error(`Expected ${actual} to ${negated ? "not " : ""}be <= ${n}`);
    },
    toHaveLength(n: number) {
      const len = (actual as unknown[]).length;
      if (len !== n)
        throw new Error(`Expected length ${n}, got ${len}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toBeInstanceOf(cls: abstract new (...a: any[]) => unknown) {
      if (negated ? actual instanceof cls : !(actual instanceof cls))
        fail(`Expected value to ${negated ? "not " : ""}be instance of ${cls.name}`);
    },
    toBeNaN() {
      if (negated ? isNaN(actual as number) : !isNaN(actual as number))
        throw new Error(`Expected ${actual} to ${negated ? "not " : ""}be NaN`);
    },
    toHaveProperty(keyPath: string | string[], value?: unknown) {
      const keys = Array.isArray(keyPath) ? keyPath : keyPath.split(".");
      let obj: unknown = actual;
      for (const k of keys) {
        if (obj == null || !(k in Object(obj))) {
          if (!negated) throw new Error(`Expected object to have property "${keys.join(".")}"`);
          return;
        }
        obj = (obj as Record<string, unknown>)[k];
      }
      if (arguments.length > 1 && !deepEqual(obj, value)) {
        if (!negated) throw new Error(`Expected property "${keys.join(".")}" to equal ${JSON.stringify(value)}, got ${JSON.stringify(obj)}`);
        return;
      }
      if (negated) throw new Error(`Expected object to not have property "${keys.join(".")}"`);
    },
    toMatchObject(expected: object) {
      const ok = matchObject(actual, expected);
      if (negated ? ok : !ok)
        throw new Error(`\nActual:\n${JSON.stringify(actual, null, 2)}\nExpected to ${negated ? "not " : ""}match:\n${JSON.stringify(expected, null, 2)}`);
    },
    toThrow(msg?: string | RegExp) {
      if (typeof actual !== "function") throw new Error("toThrow requires a function");
      let threw = false, error: unknown;
      try { (actual as () => void)(); } catch (e) { threw = true; error = e; }
      if (negated ? threw : !threw)
        throw new Error(`Expected function to ${negated ? "not " : ""}throw`);
      if (!negated && msg != null) checkThrowMsg(error, msg);
    },
    toHaveBeenCalled() {
      const count = (actual as SpyFn).mock.calls.length;
      if (negated ? count > 0 : count === 0)
        throw new Error(`Expected spy to ${negated ? "not have" : "have"} been called`);
    },
    toHaveBeenCalledTimes(n: number) {
      const count = (actual as SpyFn).mock.calls.length;
      if (count !== n)
        throw new Error(`Expected spy to be called ${n} times, was called ${count} times`);
    },
    toHaveBeenCalledWith(...args: unknown[]) {
      const found = (actual as SpyFn).mock.calls.some(c => deepEqual(c, args));
      if (negated ? found : !found)
        throw new Error(`Expected spy to ${negated ? "not have" : "have"} been called with ${JSON.stringify(args)}`);
    },
  };
}

/** Strip undefined-valued keys recursively, matching expect toEqual behavior */
function normalizeUndefined(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(normalizeUndefined);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as object)) {
    if (v !== undefined) out[k] = normalizeUndefined(v);
  }
  return out;
}

/** vitest-compatible deep equality: undefined properties in objects are treated as absent */
function expectDeepEqual(a: unknown, b: unknown): boolean {
  if (b && typeof b === "object") {
    const bTyped = b as { __type?: string; arr?: unknown[]; obj?: object };
    if (bTyped.__type === "arrayContaining") {
      return Array.isArray(a) && bTyped.arr!.every(item => (a as unknown[]).some(x => expectDeepEqual(x, item)));
    }
    if (bTyped.__type === "objectContaining") {
      return matchObject(a, bTyped.obj!);
    }
  }
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    return a.every((v, i) => expectDeepEqual(v, bArr[i]));
  }
  // Objects: skip undefined-valued keys
  const aKeys = Object.keys(a as object).filter(k => (a as Record<string, unknown>)[k] !== undefined);
  const bKeys = Object.keys(b as object).filter(k => (b as Record<string, unknown>)[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k =>
    (b as Record<string, unknown>)[k] !== undefined &&
    expectDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

function checkThrowMsg(error: unknown, msg: string | RegExp) {
  const errMsg = (error instanceof Error) ? error.message : String(error);
  const ok = msg instanceof RegExp ? msg.test(errMsg) : errMsg.includes(String(msg));
  if (!ok) throw new Error(`Expected error "${errMsg}" to match "${msg}"`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (b && typeof b === "object") {
    const bTyped = b as { __type?: string; arr?: unknown[]; obj?: object };
    if (bTyped.__type === "arrayContaining") {
      return Array.isArray(a) && bTyped.arr!.every(item => (a as unknown[]).some(x => deepEqual(x, item)));
    }
    if (bTyped.__type === "objectContaining") {
      return matchObject(a, bTyped.obj!);
    }
    if (bTyped.__type === "stringContaining") {
      return typeof a === "string" && a.includes(bTyped.obj as unknown as string);
    }
  }
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
}


function matchObject(actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) return actual === expected;
  if (typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected))
    return Array.isArray(actual) && expected.every((v, i) => matchObject((actual as unknown[])[i], v));
  if (typeof actual !== "object" || actual === null) return false;
  return Object.keys(expected as object).every(k =>
    matchObject((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k])
  );
}

// ─── vi ──────────────────────────────────────────────────────────────────────

type SpyFn = { mock: { calls: unknown[][] } };
const _spies: Array<{ obj: Record<string, unknown>; key: string; orig: unknown }> = [];

export const vi = {
  spyOn<T extends object, K extends keyof T>(obj: T, key: K) {
    const orig = obj[key];
    const calls: unknown[][] = [];
    let impl: ((...a: unknown[]) => unknown) | null = null;

    function spy(this: unknown, ...args: unknown[]) {
      calls.push(args);
      const fn = impl ?? orig;
      return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown).apply(this, args) : undefined;
    }
    spy.mock = { calls };
    spy.mockImplementation = (fn: (...a: unknown[]) => unknown) => { impl = fn; return spy; };
    spy.mockRestore = () => { obj[key] = orig as T[K]; };

    obj[key] = spy as unknown as T[K];
    _spies.push({ obj: obj as Record<string, unknown>, key: String(key), orig });
    return spy;
  },

  restoreAllMocks() {
    for (const { obj, key, orig } of _spies) obj[key] = orig;
    _spies.length = 0;
  },

  fn<T extends (...args: unknown[]) => unknown>(impl?: T) {
    const calls: unknown[][] = [];
    function mockFn(this: unknown, ...args: unknown[]) {
      calls.push(args);
      return impl ? impl.apply(this, args) : undefined;
    }
    mockFn.mock = { calls };
    mockFn.mockImplementation = (fn: T) => { impl = fn; return mockFn; };
    mockFn.mockRestore = () => {};
    return mockFn;
  },
};
