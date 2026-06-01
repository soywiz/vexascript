import type { Diagnostic } from "vscode-languageserver/node.js";

export const MYLANG_DIAGNOSTIC_CODES = {
  PARSER_ERROR: "MYL1000",
  TOKENIZE_ERROR: "MYL1001",
  FATAL_ERROR: "MYL1002",
  SEMANTIC_ERROR: "MYL2000",
  UNDEFINED_VARIABLE: "MYL2001",
  TYPE_MISMATCH: "MYL2002",
  UNKNOWN_TYPE: "MYL2003",
  MISSING_MEMBER: "MYL2004",
  CALL_TOO_FEW_ARGUMENTS: "MYL2005",
  CALL_TOO_MANY_ARGUMENTS: "MYL2006",
  CALL_UNEXPECTED_ARGUMENT: "MYL2007",
  CALL_ARGUMENT_TYPE_MISMATCH: "MYL2008",
  READONLY_REASSIGNMENT: "MYL2009",
  STYLE_AVOID_ANY: "MYL3001"
} as const;

export type MyLangDiagnosticCode =
  (typeof MYLANG_DIAGNOSTIC_CODES)[keyof typeof MYLANG_DIAGNOSTIC_CODES];

export type CallDiagnosticKind =
  | "tooFewArguments"
  | "tooManyArguments"
  | "unexpectedArgument"
  | "argumentTypeMismatch";

export const UNDEFINED_VARIABLE_PATTERN = /^Undefined variable '([A-Za-z_][A-Za-z0-9_]*)'$/;
export const TYPE_MISMATCH_PATTERN = /^Type '(.+)' is not assignable to type '(.+)'$/;
export const MISSING_MEMBER_PATTERN = /^Property '([A-Za-z_][A-Za-z0-9_]*)' does not exist on type '(.+)'$/;
export const CALL_TOO_FEW_ARGUMENTS_PATTERN = /^Expected at least [0-9]+ argument\(s\), but got [0-9]+$/;
export const CALL_TOO_MANY_ARGUMENTS_PATTERN = /^Expected at most [0-9]+ argument\(s\), but got [0-9]+$/;
export const CALL_UNEXPECTED_ARGUMENT_PATTERN = /^Unexpected argument [0-9]+; function expects at most [0-9]+ argument\(s\)$/;
export const CALL_ARGUMENT_TYPE_MISMATCH_PATTERN = /^Argument [0-9]+ of type '.+' is not assignable to parameter '.+' of type '.+'$/;
export const UNKNOWN_TYPE_PATTERN = /^Unknown type '.+'. Expected builtin type \(int, number, string, boolean, bigint, long, void\) or declared class\/interface(?:\/type parameter)?$/;
export const READONLY_REASSIGNMENT_PATTERN = /^Cannot assign to '([A-Za-z_][A-Za-z0-9_]*)' because it is a constant$/;

function diagnosticCodeToString(diagnostic: Diagnostic): string | null {
  const value = diagnostic.code;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (value && typeof value === "object" && "value" in value) {
    const codeValue = (value as { value?: unknown }).value;
    if (typeof codeValue === "string" || typeof codeValue === "number") {
      return String(codeValue);
    }
  }
  return null;
}

export function diagnosticHasCode(diagnostic: Diagnostic, code: MyLangDiagnosticCode): boolean {
  return diagnosticCodeToString(diagnostic) === code;
}

export function classifySemanticDiagnosticMessage(message: string): MyLangDiagnosticCode | null {
  if (UNDEFINED_VARIABLE_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.UNDEFINED_VARIABLE;
  }
  if (TYPE_MISMATCH_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.TYPE_MISMATCH;
  }
  if (UNKNOWN_TYPE_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.UNKNOWN_TYPE;
  }
  if (MISSING_MEMBER_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.MISSING_MEMBER;
  }
  if (CALL_TOO_FEW_ARGUMENTS_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS;
  }
  if (CALL_TOO_MANY_ARGUMENTS_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS;
  }
  if (CALL_UNEXPECTED_ARGUMENT_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT;
  }
  if (CALL_ARGUMENT_TYPE_MISMATCH_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.CALL_ARGUMENT_TYPE_MISMATCH;
  }
  if (READONLY_REASSIGNMENT_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.READONLY_REASSIGNMENT;
  }
  return null;
}

export function isUndefinedVariableDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "mylang-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.UNDEFINED_VARIABLE) ||
    UNDEFINED_VARIABLE_PATTERN.test(diagnostic.message)
  );
}

export function isMissingMemberDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "mylang-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.MISSING_MEMBER) ||
    MISSING_MEMBER_PATTERN.test(diagnostic.message)
  );
}

export function isTypeMismatchDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "mylang-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.TYPE_MISMATCH) ||
    TYPE_MISMATCH_PATTERN.test(diagnostic.message)
  );
}

function callDiagnosticKindFromMessage(message: string): CallDiagnosticKind | null {
  if (CALL_TOO_FEW_ARGUMENTS_PATTERN.test(message)) {
    return "tooFewArguments";
  }
  if (CALL_TOO_MANY_ARGUMENTS_PATTERN.test(message)) {
    return "tooManyArguments";
  }
  if (CALL_UNEXPECTED_ARGUMENT_PATTERN.test(message)) {
    return "unexpectedArgument";
  }
  if (CALL_ARGUMENT_TYPE_MISMATCH_PATTERN.test(message)) {
    return "argumentTypeMismatch";
  }
  return null;
}

export function getCallDiagnosticKind(diagnostic: Diagnostic): CallDiagnosticKind | null {
  if (diagnostic.source !== "mylang-sema") {
    return null;
  }
  if (diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS)) {
    return "tooFewArguments";
  }
  if (diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS)) {
    return "tooManyArguments";
  }
  if (diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT)) {
    return "unexpectedArgument";
  }
  if (diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.CALL_ARGUMENT_TYPE_MISMATCH)) {
    return "argumentTypeMismatch";
  }
  return callDiagnosticKindFromMessage(diagnostic.message);
}
