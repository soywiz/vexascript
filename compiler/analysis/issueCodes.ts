export const ANALYSIS_ISSUE_CODES = {
  IMPLEMENTS_MISSING_MEMBER: "IMPLEMENTS_MISSING_MEMBER",
  IMPLEMENTS_INCOMPATIBLE_MEMBER: "IMPLEMENTS_INCOMPATIBLE_MEMBER",
  DUPLICATE_SWITCH_DEFAULT: "DUPLICATE_SWITCH_DEFAULT",
  NOT_ALL_CODE_PATHS_RETURN: "NOT_ALL_CODE_PATHS_RETURN",
  RETURN_VALUE_REQUIRED: "RETURN_VALUE_REQUIRED",
  RETURN_TYPE_MISMATCH: "RETURN_TYPE_MISMATCH"
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

export type AnalysisIssueData =
  | ImplementsMissingMemberIssueData
  | ImplementsIncompatibleMemberIssueData
  | Record<string, unknown>;
