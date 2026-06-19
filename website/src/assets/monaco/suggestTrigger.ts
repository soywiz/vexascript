export interface SimpleContentChangeLike {
  text?: string;
  rangeLength?: number;
}

function isSimpleInsertion(change: SimpleContentChangeLike | undefined): boolean {
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

export function shouldTriggerValueSuggestions(contentChanges: readonly SimpleContentChangeLike[]): boolean {
  if (contentChanges.length !== 1) {
    return false;
  }
  const [change] = contentChanges;
  if (!isSimpleInsertion(change)) {
    return false;
  }
  return /:\s*$/u.test(change.text!);
}

export function shouldKeepValueSuggestions(
  contentChanges: readonly SimpleContentChangeLike[],
  armed: boolean
): boolean {
  if (!armed || contentChanges.length !== 1) {
    return false;
  }
  const [change] = contentChanges;
  if (!isSimpleInsertion(change)) {
    return false;
  }
  return /^[\t ]+$/u.test(change.text!);
}
