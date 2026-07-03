export const ANALYSIS_ISSUE_CODES = {
  IMPLEMENTS_MISSING_MEMBER: "IMPLEMENTS_MISSING_MEMBER",
  IMPLEMENTS_INCOMPATIBLE_MEMBER: "IMPLEMENTS_INCOMPATIBLE_MEMBER",
  ABSTRACT_MEMBER_NOT_IMPLEMENTED: "ABSTRACT_MEMBER_NOT_IMPLEMENTED",
  ABSTRACT_MEMBER_SIGNATURE_MISMATCH: "ABSTRACT_MEMBER_SIGNATURE_MISMATCH",
  OVERRIDE_INCOMPATIBLE_MEMBER: "OVERRIDE_INCOMPATIBLE_MEMBER",
  MISSING_OVERRIDE_MODIFIER: "MISSING_OVERRIDE_MODIFIER",
  DUPLICATE_SWITCH_DEFAULT: "DUPLICATE_SWITCH_DEFAULT",
  SWITCH_CASE_FALLTHROUGH: "SWITCH_CASE_FALLTHROUGH",
  NOT_ALL_CODE_PATHS_RETURN: "NOT_ALL_CODE_PATHS_RETURN",
  RETURN_VALUE_REQUIRED: "RETURN_VALUE_REQUIRED",
  RETURN_TYPE_MISMATCH: "RETURN_TYPE_MISMATCH",
  YIELD_OUTSIDE_GENERATOR: "YIELD_OUTSIDE_GENERATOR",
  AWAIT_OUTSIDE_ASYNC: "AWAIT_OUTSIDE_ASYNC",
  GO_OUTSIDE_SYNC: "GO_OUTSIDE_SYNC",
  OPERATOR_NOT_DEFINED: "OPERATOR_NOT_DEFINED",
  TYPE_NOT_CALLABLE: "TYPE_NOT_CALLABLE",
  TYPE_NOT_CONSTRUCTABLE: "TYPE_NOT_CONSTRUCTABLE",
  OPERATOR_NOT_APPLICABLE: "OPERATOR_NOT_APPLICABLE",
  MISSING_PARAMETER_TYPE: "MISSING_PARAMETER_TYPE",
  DUPLICATE_CLASS_VARIABLE: "DUPLICATE_CLASS_VARIABLE"
} as const;

export type AnalysisIssueCode =
  (typeof ANALYSIS_ISSUE_CODES)[keyof typeof ANALYSIS_ISSUE_CODES];

export interface ImplementsMissingMemberIssueData {
  className: string;
  interfaceName: string;
  memberName: string;
}

export interface ImplementsIncompatibleMemberIssueData {
  className: string;
  interfaceName: string;
  memberName: string;
  actualType: string;
  expectedType: string;
}

export interface AbstractMemberNotImplementedIssueData {
  className: string;
  baseClassName: string;
  memberName: string;
}

export interface OverrideIncompatibleMemberIssueData {
  className: string;
  baseClassName: string;
  memberName: string;
  expectedType: string;
}

export interface AbstractMemberSignatureMismatchIssueData {
  className: string;
  baseClassName: string;
  memberName: string;
  expectedType: string;
}

export type AnalysisIssueData =
  | ImplementsMissingMemberIssueData
  | ImplementsIncompatibleMemberIssueData
  | AbstractMemberNotImplementedIssueData
  | OverrideIncompatibleMemberIssueData
  | AbstractMemberSignatureMismatchIssueData
  | Record<string, unknown>;
