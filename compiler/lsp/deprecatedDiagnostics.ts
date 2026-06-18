import type { Diagnostic } from "vscode-languageserver/node.js";
import type { ResolveContext } from "./crossFileContext";
import { VEXA_DIAGNOSTIC_CODES } from "./diagnosticCodes";
import { DiagnosticSeverity } from "./diagnosticSeverity";
import { collectDeprecatedMemberRanges } from "./deprecatedSemanticTokens";

const DiagnosticTag = {
  Deprecated: 2
} as const;

export async function collectDeprecatedDiagnostics(
  context: Omit<ResolveContext, "line" | "character">
): Promise<Diagnostic[]> {
  return (await collectDeprecatedMemberRanges(context)).map((member): Diagnostic => ({
    code: VEXA_DIAGNOSTIC_CODES.STYLE_DEPRECATED_MEMBER,
    severity: DiagnosticSeverity.Warning,
    range: {
      start: {
        line: member.range.start.line,
        character: member.range.start.column
      },
      end: {
        line: member.range.end.line,
        character: member.range.end.column
      }
    },
    message: `Member '${member.memberName}' is deprecated.`,
    source: "vexa-ls",
    tags: [DiagnosticTag.Deprecated]
  }));
}
