# Nullish collection iterables in native self-hosting

The C++ self-host failed at runtime with `MYL1002: VexaScript value is not a
compatible map` while compiling `cli/cli.ts`. The reported `import` location
was only the most recent native source marker. The actual failure came from a
compiler expression shaped like `new Map(existingMap ?? [])`.

The C++ emitter had a broad inference shortcut that assigned the left operand's
native type to every `value ?? []` expression. That is valid when the left side
is an optional native array, because the empty literal should use the same array
storage. It is not valid for other iterables: the expression above can produce
either a native map or an array of entries. Treating the fallback as a map
generated a runtime conversion from `ArrayObject` to `MapObject`, which failed
only when the fallback branch was selected by the self-hosted compiler.

Clearing the outer `Map` constructor's contextual result type while emitting
its iterable was explored first. The generated C++ did not change, showing that
the incorrect type came from the nullish-expression inference shortcut rather
than leaked constructor context. Restricting that shortcut to actual native
array types lets heterogeneous iterable fallbacks use the existing dynamic
`Value` path while preserving efficient native arrays for `optionalArray ?? []`.

A focused C++ emitter regression now covers the heterogeneous map-or-array
case. Large native self-host failures should continue to be reduced to emitted
C++ shape tests: source locations attached to runtime conversion errors can be
far removed from the expression that selected the incompatible representation.
