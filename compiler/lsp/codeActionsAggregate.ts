import {
  CodeActionKind,
  type CodeAction,
  type Diagnostic,
  type Range
} from "vscode-languageserver/node.js";
import type { Program } from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";
import type { ProjectSessionLike } from "compiler/analysis/projectIndex";
import { findDeclarationKeywordReplacementAtPosition } from "./keywordFixes";
import { createAutoImportCodeActions } from "./importFixes";
import { createCallFixCodeActions } from "./callFixes";
import { createFunctionShorthandCodeActions } from "./functionShorthandFixes";
import { createCreateMemberCodeActions } from "./memberFixes";
import { createStringTemplateCodeActions } from "./stringTemplateFixes";
import { createTrailingLambdaCodeActions } from "./trailingLambdaFixes";
import { createTypeFixCodeActions } from "./typeFixes";
import { createInterfaceImplementationCodeActions } from "./interfaceImplementationFixes";

/**
 * Shared code-action collection used by both the LSP server and the Monaco
 * in-process providers. Centralising the list of quick-fix producers keeps the
 * editors at parity: any fix added here is offered by VS Code (via LSP) and by
 * the Monaco plugin (via the direct compiler providers) without duplication.
 *
 * The returned actions carry their `edit` inline (they are not deferred). The
 * LSP server wraps them with {@link deferCodeActions} before sending them over
 * the wire; Monaco consumes the inline edits directly.
 */
export interface CollectCodeActionsParams {
  uri: string;
  text: string;
  ast: Program | null;
  analysis: Analysis | null;
  range: Range;
  diagnostics: Diagnostic[];
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ProjectSessionLike | null;
  refreshDiagnosticsCommand?: string;
}

export function collectCodeActions(params: CollectCodeActionsParams): CodeAction[] {
  const { uri, text, ast, analysis, range, diagnostics, sourceRoots } = params;
  if (!ast) {
    return [];
  }

  const crossFile = params.getSessionForFilePath
    ? { getSessionForFilePath: params.getSessionForFilePath }
    : {};

  const actions: CodeAction[] = [];

  const replacement = findDeclarationKeywordReplacementAtPosition(
    ast,
    range.start.line,
    range.start.character
  );
  if (replacement) {
    actions.push({
      title: `Replace '${replacement.from}' with '${replacement.to}'`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [
            {
              range: replacement.range,
              newText: replacement.to
            }
          ]
        }
      }
    });
  }

  actions.push(
    ...createFunctionShorthandCodeActions({
      uri,
      ast,
      text,
      position: range.start
    })
  );

  actions.push(
    ...createStringTemplateCodeActions({
      uri,
      ast,
      text,
      position: range.start
    })
  );

  actions.push(
    ...createTrailingLambdaCodeActions({
      uri,
      ast,
      text,
      position: range.start
    })
  );

  actions.push(
    ...createAutoImportCodeActions({
      uri,
      ast,
      diagnostics,
      sourceRoots
    })
  );

  actions.push(
    ...createCallFixCodeActions({
      uri,
      text,
      ast,
      analysis,
      diagnostics
    })
  );

  actions.push(
    ...createCreateMemberCodeActions({
      uri,
      ast,
      analysis,
      diagnostics,
      sourceRoots,
      ...crossFile
    })
  );

  actions.push(
    ...createTypeFixCodeActions({
      uri,
      ast,
      analysis,
      diagnostics,
      sourceRoots,
      ...crossFile,
      ...(params.refreshDiagnosticsCommand
        ? { commandName: params.refreshDiagnosticsCommand }
        : {})
    })
  );

  actions.push(
    ...createInterfaceImplementationCodeActions({
      uri,
      ast,
      diagnostics,
      sourceRoots,
      ...crossFile
    })
  );

  return actions;
}
