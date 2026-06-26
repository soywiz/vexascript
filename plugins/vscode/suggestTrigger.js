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

function shouldTriggerValueSuggestions(contentChanges) {
  if (!Array.isArray(contentChanges) || contentChanges.length !== 1) {
    return false;
  }
  const [change] = contentChanges;
  if (!isSimpleInsertion(change)) {
    return false;
  }
  return /:\s*$/u.test(change.text);
}

function shouldKeepValueSuggestions(contentChanges, state = {}) {
  if (!Array.isArray(contentChanges) || contentChanges.length !== 1) {
    return false;
  }
  if (state.valueSuggestionsArmed !== true) {
    return false;
  }
  const [change] = contentChanges;
  if (!isSimpleInsertion(change)) {
    return false;
  }
  return /^[\t ]+$/u.test(change.text);
}

function shouldTriggerMemberSuggestions(contentChanges, linePrefixAfterChange) {
  if (!Array.isArray(contentChanges) || contentChanges.length !== 1) {
    return false;
  }
  if (typeof linePrefixAfterChange !== "string") {
    return false;
  }
  const [change] = contentChanges;
  if (!isSimpleInsertion(change)) {
    return false;
  }
  if (/:\s*$/u.test(change.text)) {
    return /::\s*$/u.test(linePrefixAfterChange);
  }
  if (!/^[A-Za-z_]$/u.test(change.text)) {
    return false;
  }
  return /(?:\?\.|!\.|\.|::)(?:\s*[A-Za-z_][A-Za-z0-9_]*)$/u.test(linePrefixAfterChange);
}

module.exports = {
  shouldTriggerValueSuggestions,
  shouldKeepValueSuggestions,
  shouldTriggerMemberSuggestions,
};
