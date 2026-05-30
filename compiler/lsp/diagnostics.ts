import {
  type Diagnostic,
  DiagnosticSeverity,
  type Position
} from "vscode-languageserver/node.js";
import { Analysis } from "compiler/analysis/Analysis";
import { Parser } from "compiler/parser/parser";
import { TokenizeError, tokenize, type Token } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";

function fallbackRange() {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 }
  };
}

export function collectDiagnostics(
  text: string,
  positionAt: (offset: number) => Position
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  try {
    const tokens = tokenize(text);
    const parser = new Parser(new ListReader<Token>(tokens));
    const ast = parser.parseFile();

    for (const issue of parser.errors) {
      const token = issue.token;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: token
          ? {
              start: {
                line: token.range.start.line,
                character: token.range.start.column
              },
              end: {
                line: token.range.end.line,
                character: token.range.end.column
              }
            }
          : fallbackRange(),
        message: issue.message,
        source: "mylang-ls"
      });
    }

    try {
      const analysis = new Analysis(ast);
      for (const issue of analysis.getIssues()) {
        const token = issue.node.firstToken;
        if (!token) {
          continue;
        }
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: {
            start: {
              line: token.range.start.line,
              character: token.range.start.column
            },
            end: {
              line: token.range.end.line,
              character: token.range.end.column
            }
          },
          message: issue.message,
          source: "mylang-sema"
        });
      }
    } catch (error) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: fallbackRange(),
        message: error instanceof Error ? error.message : String(error),
        source: "mylang-ls"
      });
    }
  } catch (error) {
    if (error instanceof TokenizeError) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: {
            line: error.range.start.line,
            character: error.range.start.column
          },
          end: {
            line: error.range.end.line,
            character: error.range.end.column
          }
        },
        message: error.message,
        source: "mylang-ls"
      });
    } else {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: fallbackRange(),
        message: error instanceof Error ? error.message : String(error),
        source: "mylang-ls"
      });
    }
  }

  const anyIndex = text.indexOf("any");
  if (anyIndex >= 0) {
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: positionAt(anyIndex),
        end: positionAt(anyIndex + 3)
      },
      message: "MyLang: avoid 'any' when possible.",
      source: "mylang-ls"
    });
  }

  return diagnostics;
}
