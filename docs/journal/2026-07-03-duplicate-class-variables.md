# Duplicate class variables need group-level diagnostics

## Context

Class fields with the same name used the generic binder declaration path. That
path only reported the later declaration, which made the editor show one error
even though every field in the duplicate group was ambiguous.

## What worked

The fix adds a class-field-specific pass in the binder before class members are
declared into the implicit receiver scope. It groups non-computed
`ClassFieldMember` names and emits `DUPLICATE_CLASS_VARIABLE` on every field in
groups of two or more. The generic duplicate-declaration path skips those same
field-name nodes afterward so users do not see both the old and new errors.

The LSP quick fix is diagnostic-driven and deletes the whole class field line,
including indentation and annotations retained in the member range.

## Dead ends avoided

Reusing the generic `Duplicate declaration` diagnostic would not satisfy the
editor behavior because it only fires for later declarations and has no stable
code specific enough for a remove-field quick fix. Layering a quick fix on that
message would also risk offering field deletion for unrelated local-variable
duplicates.
