# `is` and `instanceof` equivalence

The public syntax-differences page described `is` as merely similar to
`instanceof` and as having an additional smart-cast integration. That wording
was misleading: the analyzer already sends both operators through the same
flow-narrowing path, and the JavaScript emitter lowers `is` to `instanceof`.

The intended language contract is that `is` is the shorter spelling of
`instanceof`. Both operators perform the same runtime check and provide the
same smart-cast behavior in true and false branches. The documentation now
states that contract directly, the website sample demonstrates both forms,
and the transpiler test verifies that both spellings emit the same JavaScript
check.
