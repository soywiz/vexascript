const DEPRECATED_DIAGNOSTIC_TAG = 2;

function collectDeprecatedDiagnosticRanges(documentUri, diagnostics) {
  if (typeof documentUri !== "string") {
    return [];
  }
  return (diagnostics ?? [])
    .filter((diagnostic) =>
      diagnostic?.range
      && diagnostic.tags?.includes(DEPRECATED_DIAGNOSTIC_TAG)
    )
    .map((diagnostic) => ({
      start: {
        line: diagnostic.range.start.line,
        character: diagnostic.range.start.character
      },
      end: {
        line: diagnostic.range.end.line,
        character: diagnostic.range.end.character
      }
    }));
}

module.exports = {
  DEPRECATED_DIAGNOSTIC_TAG,
  collectDeprecatedDiagnosticRanges
};
