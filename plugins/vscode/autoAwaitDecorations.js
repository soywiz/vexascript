function currentAutoAwaitDecorations(decorations, requestedVersion, currentVersion) {
  return Array.isArray(decorations) && requestedVersion === currentVersion
    ? decorations
    : undefined;
}

module.exports = { currentAutoAwaitDecorations };
