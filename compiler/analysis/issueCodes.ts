export const ANALYSIS_ISSUE_CODES = {
  IMPLEMENTS_MISSING_MEMBER: "IMPLEMENTS_MISSING_MEMBER",
  IMPLEMENTS_INCOMPATIBLE_MEMBER: "IMPLEMENTS_INCOMPATIBLE_MEMBER"
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
