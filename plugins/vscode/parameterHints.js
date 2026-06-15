function isSingleInsertedComma(change) {
  if (!change || typeof change.text !== "string") {
    return false;
  }
  if (change.text !== ",") {
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
  return isSingleInsertedComma(contentChanges[0]);
}

module.exports = {
  shouldRetriggerParameterHints
};
