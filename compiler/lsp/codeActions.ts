import type { CodeAction, WorkspaceEdit } from "vscode-languageserver/node.js";

const DEFERRED_EDIT_KIND = "mylang.deferredEdit";

interface DeferredEditData {
  kind: typeof DEFERRED_EDIT_KIND;
  edit: WorkspaceEdit;
  priorData?: unknown;
}

function hasWorkspaceChanges(edit: WorkspaceEdit | undefined): boolean {
  if (!edit) {
    return false;
  }
  if (edit.changes && Object.keys(edit.changes).length > 0) {
    return true;
  }
  if (edit.documentChanges && edit.documentChanges.length > 0) {
    return true;
  }
  return false;
}

function encodeDeferredData(existingData: unknown, edit: WorkspaceEdit): DeferredEditData {
  return {
    kind: DEFERRED_EDIT_KIND,
    edit,
    ...(existingData !== undefined ? { priorData: existingData } : {})
  };
}

function decodeDeferredData(data: unknown): DeferredEditData | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const candidate = data as Partial<DeferredEditData>;
  if (candidate.kind !== DEFERRED_EDIT_KIND || !candidate.edit) {
    return null;
  }
  return candidate as DeferredEditData;
}

export function deferCodeActions(actions: CodeAction[]): CodeAction[] {
  return actions.map((action) => {
    if (!hasWorkspaceChanges(action.edit)) {
      return action;
    }

    const data = encodeDeferredData(action.data, action.edit!);
    const { edit, ...rest } = action;
    return {
      ...rest,
      data
    };
  });
}

export function resolveDeferredCodeAction(action: CodeAction): CodeAction {
  if (hasWorkspaceChanges(action.edit)) {
    return action;
  }

  const data = decodeDeferredData(action.data);
  if (!data) {
    return action;
  }

  return {
    ...action,
    data: data.priorData,
    edit: data.edit
  };
}
