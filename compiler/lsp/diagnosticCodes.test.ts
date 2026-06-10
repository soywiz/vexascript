import { describe, it } from "node:test";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { expect } from "../test/expect";
import {
  VEXA_DIAGNOSTIC_CODES,
  parseMissingMemberDiagnostic,
  parseOperatorNotDefinedDiagnostic,
  parseTypeMismatchDiagnostic,
  parseUndefinedVariableDiagnostic,
  parseUnknownTypeDiagnostic
} from "./diagnosticCodes";

function semanticDiagnostic(message: string, code: string | { value: string }): Diagnostic {
  return {
    source: "vexa-sema",
    message,
    code,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 }
    }
  } as Diagnostic;
}

describe("diagnostic code parsing", () => {
  it("parses known semantic diagnostic payloads in one shared place", () => {
    expect(parseUndefinedVariableDiagnostic(semanticDiagnostic(
      "Undefined variable 'missing'",
      VEXA_DIAGNOSTIC_CODES.UNDEFINED_VARIABLE
    ))).toEqual({ name: "missing" });

    expect(parseMissingMemberDiagnostic(semanticDiagnostic(
      "Property 'length' does not exist on type 'Vector<int>'",
      VEXA_DIAGNOSTIC_CODES.MISSING_MEMBER
    ))).toEqual({ memberName: "length", typeName: "Vector<int>" });

    expect(parseUnknownTypeDiagnostic(semanticDiagnostic(
      "Unknown type 'Maybe<string>'. Expected builtin type (int, number, string, boolean, bigint, long, void) or declared class/interface",
      VEXA_DIAGNOSTIC_CODES.UNKNOWN_TYPE
    ))).toEqual({ typeName: "Maybe<string>" });

    expect(parseTypeMismatchDiagnostic(semanticDiagnostic(
      "Type 'string' is not assignable to type 'number'",
      VEXA_DIAGNOSTIC_CODES.TYPE_MISMATCH
    ))).toEqual({ sourceType: "string", targetType: "number" });

    expect(parseOperatorNotDefinedDiagnostic(semanticDiagnostic(
      "Operator '+' is not defined for types 'Point' and 'Point'",
      VEXA_DIAGNOSTIC_CODES.OPERATOR_NOT_DEFINED
    ))).toEqual({ operator: "+", leftType: "Point", rightType: "Point" });
  });

  it("accepts LSP code-description objects and rejects diagnostics from other sources", () => {
    expect(parseUndefinedVariableDiagnostic(semanticDiagnostic(
      "Undefined variable 'missing'",
      { value: VEXA_DIAGNOSTIC_CODES.UNDEFINED_VARIABLE }
    ))).toEqual({ name: "missing" });

    expect(parseUndefinedVariableDiagnostic({
      source: "vexa-ls",
      message: "Undefined variable 'missing'",
      code: VEXA_DIAGNOSTIC_CODES.UNDEFINED_VARIABLE,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 }
      }
    })).toBeNull();
  });
});
