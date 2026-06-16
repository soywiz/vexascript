function isSimpleInsertion(change) {
  if (!change || typeof change.text !== "string") {
    return false;
  }
  if (change.text.length === 0 || change.text.includes("\n") || change.text.includes("\r")) {
    return false;
  }
  if (typeof change.rangeLength === "number" && change.rangeLength !== 0) {
    return false;
  }
  return true;
}

function shouldRetriggerParameterHints(contentChanges) {
  if (!Array.isArray(contentChanges) || contentChanges.length !== 1) {
    return false;
  }
  return isSimpleInsertion(contentChanges[0]);
}

function selectionStateFromEvent(event) {
  if (!event || !Array.isArray(event.selections) || event.selections.length !== 1) {
    return null;
  }
  const [selection] = event.selections;
  if (!selection || typeof selection.isEmpty !== "boolean" || !selection.isEmpty) {
    return null;
  }
  const active = selection.active ?? selection.start ?? null;
  if (!active || typeof active.line !== "number" || typeof active.character !== "number") {
    return null;
  }
  return {
    line: active.line,
    character: active.character
  };
}

function shouldRetriggerParameterHintsForSelectionChange(event, state = {}) {
  const selectionState = selectionStateFromEvent(event);
  if (!selectionState) {
    return false;
  }
  if (state.parameterHintsArmed !== true) {
    return false;
  }
  if (!state.lastSelection || typeof state.lastSelection.line !== "number") {
    return false;
  }
  if (selectionState.line !== state.lastSelection.line) {
    return false;
  }
  return true;
}

module.exports = {
  shouldRetriggerParameterHints,
  shouldRetriggerParameterHintsForSelectionChange,
  selectionStateFromEvent
};
