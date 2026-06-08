import {
  type CodeAction,
  type Diagnostic,
  type Range
} from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import type { Program } from "compiler/ast/ast";
import type { Analysis } from "compiler/analysis/Analysis";
import type { ProjectSessionLike } from "compiler/analysis/projectIndex";
import { findDeclarationKeywordReplacementAtPosition } from "./keywordFixes";
import { createAutoImportCodeActions } from "./importFixes";
import { createCallFixCodeActions } from "./callFixes";
import { createFunctionShorthandCodeActions } from "./functionShorthandFixes";
import { createReturnTypeCodeActions } from "./returnTypeFixes";
import { createCreateMemberCodeActions } from "./memberFixes";
import { createStringTemplateCodeActions } from "./stringTemplateFixes";
import { createTrailingLambdaCodeActions } from "./trailingLambdaFixes";
import { createEmptyClassBodyCodeActions } from "./emptyClassBodyFixes";
import { createTypeFixCodeActions } from "./typeFixes";
import { createInterfaceImplementationCodeActions } from "./interfaceImplementationFixes";
import { createThisCodeActions } from "./thisFixes";
import type { SymbolExportProvider } from "./importFixes";

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
  getSessionForFilePath?: (filePath: string) => ProjectSessionLike | null | Promise<ProjectSessionLike | null>;
  getExportedSymbols?: SymbolExportProvider;
  refreshDiagnosticsCommand?: string;
}

export async function collectCodeActions(params: CollectCodeActionsParams): Promise<CodeAction[]> {
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
    ...await createReturnTypeCodeActions({
      uri,
      ast,
      analysis,
      position: range.start,
      options: { uri, sourceRoots, ...crossFile }
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
    ...createEmptyClassBodyCodeActions({
      uri,
      ast,
      text,
      position: range.start
    })
  );

  actions.push(
    ...createThisCodeActions({
      uri,
      ast,
      analysis,
      position: range.start
    })
  );

  actions.push(
    ...await createAutoImportCodeActions({
      uri,
      ast,
      diagnostics,
      sourceRoots,
      ...(params.getExportedSymbols ? { getExportedSymbols: params.getExportedSymbols } : {})
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
    ...await createCreateMemberCodeActions({
      uri,
      ast,
      analysis,
      diagnostics,
      sourceRoots,
      ...crossFile
    })
  );

  actions.push(
    ...await createTypeFixCodeActions({
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
    ...await createInterfaceImplementationCodeActions({
      uri,
      ast,
      diagnostics,
      sourceRoots,
      ...crossFile
    })
  );

  return actions;
}
