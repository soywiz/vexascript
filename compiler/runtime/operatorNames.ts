import type { OverloadableOperator } from "compiler/ast/ast";

/**
 * Replaces every run of non-identifier characters with `$` so a symbol or type
 * name can be embedded inside a JavaScript identifier (a mangled runtime name).
 */
export function sanitizeManglePart(text: string): string {
  const normalized = text.replace(/[^A-Za-z0-9]+/g, "$").replace(/^\$+|\$+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

/**
 * Single source of truth mapping each overloadable operator to the base of its
 * mangled runtime method name.
 *
 * Both the emitter (which emits the operator definitions and their call sites)
 * and the implicit `.vx` export planner read from here through
 * {@link operatorBaseRuntimeName}. They MUST agree: when a module defines
 * `fun Point.operator*(...)`, the emitter emits `Point$$operator$star$$Point`
 * and the implicit export plan re-exports it under the same name, so a call
 * from another module resolves. A divergence here is a latent
 * "exported under one name, called under another" bug.
 *
 * Operators not listed fall back to `operator$<sanitized symbol>` (e.g.
 * `in` -> `operator$in`).
 */
export const OPERATOR_METHOD_NAMES: Partial<Record<OverloadableOperator, string>> = {
  "+": "operator$plus",
  "-": "operator$minus",
  "*": "operator$star",
  "/": "operator$slash",
  "%": "operator$percent",
  "**": "operator$power",
  "<<": "operator$shiftLeft",
  ">>": "operator$shiftRight",
  ">>>": "operator$unsignedShiftRight",
  "<": "operator$less",
  ">": "operator$greater",
  "<=": "operator$lessEqual",
  ">=": "operator$greaterEqual",
  "<=>": "operator$spaceship",
  "==": "operator$equals",
  "!=": "operator$notEquals",
  "===": "operator$strictEquals",
  "!==": "operator$strictNotEquals",
  "&": "operator$bitAnd",
  "|": "operator$bitOr",
  "^": "operator$bitXor",
  "||": "operator$logicalOr",
  "&&": "operator$logicalAnd",
  "??": "operator$nullish",
  "[]": "operator$get",
  "[]=": "operator$set"
};

/**
 * Base of the mangled runtime name for an overloadable operator, shared by the
 * emitter and the implicit export planner so both always agree.
 */
export function operatorBaseRuntimeName(operator: OverloadableOperator): string {
  return OPERATOR_METHOD_NAMES[operator] ?? `operator$${sanitizeManglePart(operator)}`;
}
