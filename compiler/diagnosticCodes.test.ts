import { ANALYSIS_ISSUE_CODES } from "compiler/analysis/issueCodes";
import { describe, expect, it } from "./test/expect";
import {
  VEXA_DIAGNOSTIC_CODES,
  callDiagnosticKindFromMessage,
  classifySemanticDiagnosticMessage,
  mapAnalysisIssueCodeToDiagnosticCode
} from "./diagnosticCodes";

describe("shared diagnostic codes", () => {
  it("classifies semantic diagnostic messages without LSP dependencies", () => {
    expect(classifySemanticDiagnosticMessage("Undefined variable 'missing'"))
      .toBe(VEXA_DIAGNOSTIC_CODES.UNDEFINED_VARIABLE);
    expect(classifySemanticDiagnosticMessage("Type 'string' is not assignable to type 'int'"))
      .toBe(VEXA_DIAGNOSTIC_CODES.TYPE_MISMATCH);
    expect(classifySemanticDiagnosticMessage("Property 'len' does not exist on type 'Vector'"))
      .toBe(VEXA_DIAGNOSTIC_CODES.MISSING_MEMBER);
    expect(classifySemanticDiagnosticMessage("Expected at least 2 argument(s), but got 1"))
      .toBe(VEXA_DIAGNOSTIC_CODES.CALL_TOO_FEW_ARGUMENTS);
    expect(classifySemanticDiagnosticMessage("Some unrelated message")).toBe(null);
  });

  it("maps analysis issue codes to diagnostic codes", () => {
    expect(mapAnalysisIssueCodeToDiagnosticCode(ANALYSIS_ISSUE_CODES.RETURN_TYPE_MISMATCH))
      .toBe(VEXA_DIAGNOSTIC_CODES.RETURN_TYPE_MISMATCH);
    expect(mapAnalysisIssueCodeToDiagnosticCode(ANALYSIS_ISSUE_CODES.DUPLICATE_SWITCH_DEFAULT))
      .toBe(VEXA_DIAGNOSTIC_CODES.DUPLICATE_SWITCH_DEFAULT);
    expect(mapAnalysisIssueCodeToDiagnosticCode(undefined)).toBe(null);
  });

  it("classifies call diagnostic kinds from raw messages", () => {
    expect(callDiagnosticKindFromMessage("Expected at most 1 argument(s), but got 3"))
      .toBe("tooManyArguments");
    expect(callDiagnosticKindFromMessage(
      "Argument 1 of type 'string' is not assignable to parameter 'count' of type 'int'"
    )).toBe("argumentTypeMismatch");
    expect(callDiagnosticKindFromMessage("Some unrelated message")).toBe(null);
  });
});
