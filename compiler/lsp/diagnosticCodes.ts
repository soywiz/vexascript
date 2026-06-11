import type { Diagnostic } from "vscode-languageserver/node.js";
import {
  VEXA_DIAGNOSTIC_CODES,
  UNDEFINED_VARIABLE_PATTERN,
  TYPE_MISMATCH_PATTERN,
  MISSING_MEMBER_PATTERN,
  UNKNOWN_TYPE_PATTERN,
  OPERATOR_NOT_DEFINED_PATTERN,
  callDiagnosticKindFromMessage,
  type CallDiagnosticKind,
  type VexaScriptDiagnosticCode
} from "compiler/diagnosticCodes";

export {
  VEXA_DIAGNOSTIC_CODES,
  UNDEFINED_VARIABLE_PATTERN,
  TYPE_MISMATCH_PATTERN,
  MISSING_MEMBER_PATTERN,
  CALL_TOO_FEW_ARGUMENTS_PATTERN,
  CALL_TOO_MANY_ARGUMENTS_PATTERN,
  CALL_UNEXPECTED_ARGUMENT_PATTERN,
  CALL_ARGUMENT_TYPE_MISMATCH_PATTERN,
  UNKNOWN_TYPE_PATTERN,
  READONLY_REASSIGNMENT_PATTERN,
  IMPLEMENTS_MISSING_MEMBER_PATTERN,
  IMPLEMENTS_INCOMPATIBLE_MEMBER_PATTERN,
  OPERATOR_NOT_DEFINED_PATTERN,
  NULLABLE_MEMBER_ACCESS_PATTERN,
  classifySemanticDiagnosticMessage,
  mapAnalysisIssueCodeToDiagnosticCode,
  type CallDiagnosticKind,
  type VexaScriptDiagnosticCode
} from "compiler/diagnosticCodes";

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

export function diagnosticHasCode(diagnostic: Diagnostic, code: VexaScriptDiagnosticCode): boolean {
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

export function isUndefinedVariableDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "vexa-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.UNDEFINED_VARIABLE) ||
    UNDEFINED_VARIABLE_PATTERN.test(diagnostic.message)
  );
}

export function isMissingMemberDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "vexa-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.MISSING_MEMBER) ||
    MISSING_MEMBER_PATTERN.test(diagnostic.message)
  );
}

export function isUnknownTypeDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "vexa-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.UNKNOWN_TYPE) ||
    UNKNOWN_TYPE_PATTERN.test(diagnostic.message)
  );
}

export function isOperatorNotDefinedDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "vexa-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.OPERATOR_NOT_DEFINED) ||
    OPERATOR_NOT_DEFINED_PATTERN.test(diagnostic.message)
  );
}

export function isTypeMismatchDiagnostic(diagnostic: Diagnostic): boolean {
  if (diagnostic.source !== "vexa-sema") {
    return false;
  }
  return (
    diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.TYPE_MISMATCH) ||
    TYPE_MISMATCH_PATTERN.test(diagnostic.message)
  );
}

export function getCallDiagnosticKind(diagnostic: Diagnostic): CallDiagnosticKind | null {
  if (diagnostic.source !== "vexa-sema") {
    return null;
  }
  if (diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS)) {
    return "tooFewArguments";
  }
  if (diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.CALL_TOO_MANY_ARGUMENTS)) {
    return "tooManyArguments";
  }
  if (diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.CALL_UNEXPECTED_ARGUMENT)) {
    return "unexpectedArgument";
  }
  if (diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.CALL_ARGUMENT_TYPE_MISMATCH)) {
    return "argumentTypeMismatch";
  }
  return callDiagnosticKindFromMessage(diagnostic.message);
}
