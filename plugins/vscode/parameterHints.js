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

function shouldRetriggerParameterHintsForSelectionChange(event) {
  if (!event || !Array.isArray(event.selections) || event.selections.length !== 1) {
    return false;
  }
  const [selection] = event.selections;
  if (!selection || typeof selection.isEmpty !== "boolean" || !selection.isEmpty) {
    return false;
  }
  if (!event.kind) {
    return true;
  }
  return true;
}

module.exports = {
  shouldRetriggerParameterHints,
  shouldRetriggerParameterHintsForSelectionChange
};
