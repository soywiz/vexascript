# Persistent document highlights

## Problem

VS Code painted provisional textual occurrences while a document-highlight
request was pending, then appeared to clear them when the semantic response
arrived. Implicit class-field writes could resolve to a cloned symbol object,
so strict object-identity matching omitted those occurrences. The VexaScript
theme also did not define explicit occurrence colors.

## Change

Reference collection now compares the stable declaration identity of symbols,
not only their object identity. This retains reads, writes, and the declaration
for implicit class fields. The VS Code theme defines visible regular, strong,
and textual occurrence backgrounds so the server's semantic highlight set
stays visible after the provisional highlight is replaced.

## Regression risk

Symbols are considered equivalent only when their declaration node, name, and
declared offset match. Tests cover the declaration, reads, and assignment of an
implicit class field, as well as the theme colors used by VS Code.

## Execution metadata

- Date: 2026-09-02
- Provider: OpenAI
- Model: Unavailable (not exposed by runtime)
