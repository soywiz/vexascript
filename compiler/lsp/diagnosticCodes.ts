import type { Diagnostic } from "vscode-languageserver/node.js";
import { ANALYSIS_ISSUE_CODES, type AnalysisIssueCode } from "compiler/analysis/issueCodes";

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
  IMPLEMENTS_MISSING_MEMBER: "MYL2010",
  IMPLEMENTS_INCOMPATIBLE_MEMBER: "MYL2011",
  DUPLICATE_SWITCH_DEFAULT: "MYL2012",
  NOT_ALL_CODE_PATHS_RETURN: "MYL2013",
  RETURN_VALUE_REQUIRED: "MYL2014",
  RETURN_TYPE_MISMATCH: "MYL2015",
  YIELD_OUTSIDE_GENERATOR: "MYL2016",
  OPERATOR_NOT_DEFINED: "MYL2017",
  SWITCH_CASE_FALLTHROUGH: "MYL2018",
  NULLABLE_MEMBER_ACCESS: "MYL2019",
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
export const UNKNOWN_TYPE_PATTERN = /^Unknown type '(.+?)'\. Expected builtin type \(int, number, string, boolean, bigint, long, void\) or declared class\/interface(?:\/type parameter)?$/;
export const READONLY_REASSIGNMENT_PATTERN = /^Cannot assign to '([A-Za-z_][A-Za-z0-9_]*)' because it is a constant$/;
export const IMPLEMENTS_MISSING_MEMBER_PATTERN = /^Class '([^']+)' incorrectly implements interface '([^']+)'\. Property '([^']+)' is missing$/;
export const IMPLEMENTS_INCOMPATIBLE_MEMBER_PATTERN = /^Class '([^']+)' incorrectly implements interface '([^']+)'\. Property '([^']+)' is of type '(.+)' but expected '(.+)'$/;
export const OPERATOR_NOT_DEFINED_PATTERN = /^Operator '(.+)' is not defined for types '(.+)' and '(.+)'$/;
export const NULLABLE_MEMBER_ACCESS_PATTERN =
  /^Object is possibly 'null' or 'undefined'\. Use optional access '\?\.' or a non-null assertion '!'$/;

export interface UndefinedVariableDiagnosticMatch {
  name: string;
}

export interface TypeMismatchDiagnosticMatch {
  sourceType: string;
  targetType: string;
}

export interface MissingMemberDiagnosticMatch {
  memberName: string;
  typeName: string;
}

export interface UnknownTypeDiagnosticMatch {
  typeName: string;
}

export interface OperatorNotDefinedDiagnosticMatch {
  operator: string;
  leftType: string;
  rightType: string;
}

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

function stringCapture(match: RegExpExecArray, index: number): string | null {
  const value = match[index];
  return value && value.length > 0 ? value : null;
}

export function parseUndefinedVariableDiagnostic(
  diagnostic: Diagnostic
): UndefinedVariableDiagnosticMatch | null {
  if (!isUndefinedVariableDiagnostic(diagnostic)) {
    return null;
  }
  const match = UNDEFINED_VARIABLE_PATTERN.exec(diagnostic.message);
  const name = match ? stringCapture(match, 1) : null;
  return name ? { name } : null;
}

export function parseTypeMismatchDiagnostic(
  diagnostic: Diagnostic
): TypeMismatchDiagnosticMatch | null {
  if (!isTypeMismatchDiagnostic(diagnostic)) {
    return null;
  }
  const match = TYPE_MISMATCH_PATTERN.exec(diagnostic.message);
  const sourceType = match ? stringCapture(match, 1) : null;
  const targetType = match ? stringCapture(match, 2) : null;
  return sourceType && targetType ? { sourceType, targetType } : null;
}

export function parseMissingMemberDiagnostic(
  diagnostic: Diagnostic
): MissingMemberDiagnosticMatch | null {
  if (!isMissingMemberDiagnostic(diagnostic)) {
    return null;
  }
  const match = MISSING_MEMBER_PATTERN.exec(diagnostic.message);
  const memberName = match ? stringCapture(match, 1) : null;
  const typeName = match ? stringCapture(match, 2) : null;
  return memberName && typeName ? { memberName, typeName } : null;
}

export function parseUnknownTypeDiagnostic(
  diagnostic: Diagnostic
): UnknownTypeDiagnosticMatch | null {
  if (!isUnknownTypeDiagnostic(diagnostic)) {
    return null;
  }
  const match = UNKNOWN_TYPE_PATTERN.exec(diagnostic.message);
  const typeName = match ? stringCapture(match, 1) : null;
  return typeName ? { typeName } : null;
}

export function parseOperatorNotDefinedDiagnostic(
  diagnostic: Diagnostic
): OperatorNotDefinedDiagnosticMatch | null {
  if (!isOperatorNotDefinedDiagnostic(diagnostic)) {
    return null;
  }
  const match = OPERATOR_NOT_DEFINED_PATTERN.exec(diagnostic.message);
  const operator = match ? stringCapture(match, 1) : null;
  const leftType = match ? stringCapture(match, 2) : null;
  const rightType = match ? stringCapture(match, 3) : null;
  return operator && leftType && rightType ? { operator, leftType, rightType } : null;
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
  if (IMPLEMENTS_MISSING_MEMBER_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.IMPLEMENTS_MISSING_MEMBER;
  }
  if (IMPLEMENTS_INCOMPATIBLE_MEMBER_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.IMPLEMENTS_INCOMPATIBLE_MEMBER;
  }
  if (OPERATOR_NOT_DEFINED_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.OPERATOR_NOT_DEFINED;
  }
  if (NULLABLE_MEMBER_ACCESS_PATTERN.test(message)) {
    return MYLANG_DIAGNOSTIC_CODES.NULLABLE_MEMBER_ACCESS;
  }
  return null;
}

export function mapAnalysisIssueCodeToDiagnosticCode(
  issueCode: AnalysisIssueCode | undefined
): MyLangDiagnosticCode | null {
  if (!issueCode) {
    return null;
  }
  switch (issueCode) {
    case ANALYSIS_ISSUE_CODES.IMPLEMENTS_MISSING_MEMBER:
      return MYLANG_DIAGNOSTIC_CODES.IMPLEMENTS_MISSING_MEMBER;
    case ANALYSIS_ISSUE_CODES.IMPLEMENTS_INCOMPATIBLE_MEMBER:
      return MYLANG_DIAGNOSTIC_CODES.IMPLEMENTS_INCOMPATIBLE_MEMBER;
    case ANALYSIS_ISSUE_CODES.DUPLICATE_SWITCH_DEFAULT:
      return MYLANG_DIAGNOSTIC_CODES.DUPLICATE_SWITCH_DEFAULT;
    case ANALYSIS_ISSUE_CODES.SWITCH_CASE_FALLTHROUGH:
      return MYLANG_DIAGNOSTIC_CODES.SWITCH_CASE_FALLTHROUGH;
    case ANALYSIS_ISSUE_CODES.NOT_ALL_CODE_PATHS_RETURN:
      return MYLANG_DIAGNOSTIC_CODES.NOT_ALL_CODE_PATHS_RETURN;
    case ANALYSIS_ISSUE_CODES.RETURN_VALUE_REQUIRED:
      return MYLANG_DIAGNOSTIC_CODES.RETURN_VALUE_REQUIRED;
    case ANALYSIS_ISSUE_CODES.RETURN_TYPE_MISMATCH:
      return MYLANG_DIAGNOSTIC_CODES.RETURN_TYPE_MISMATCH;
    case ANALYSIS_ISSUE_CODES.YIELD_OUTSIDE_GENERATOR:
      return MYLANG_DIAGNOSTIC_CODES.YIELD_OUTSIDE_GENERATOR;
    default:
      return null;
  }
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

export function isUnknownTypeDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "mylang-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.UNKNOWN_TYPE) ||
    UNKNOWN_TYPE_PATTERN.test(diagnostic.message)
  );
}

export function isOperatorNotDefinedDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "mylang-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, MYLANG_DIAGNOSTIC_CODES.OPERATOR_NOT_DEFINED) ||
    OPERATOR_NOT_DEFINED_PATTERN.test(diagnostic.message)
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
