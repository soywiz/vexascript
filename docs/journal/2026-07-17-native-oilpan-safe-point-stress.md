# Native Oilpan Stress Requires Source Safe Points

## Context

The first native GC-stress implementation forced an Oilpan collection from
`Runtime::make` and `Runtime::string`, immediately before managed allocations.
This looked like the strongest possible stress mode, but it allowed a collection
to occur while another argument in the same C++ expression was still only an
intermediate raw pointer. C++ argument evaluation does not guarantee that such a
pointer has already been spilled to the conservatively scanned stack.

The native language smoke exposed this after the array callback section while
constructing a `Map` from a managed map object and a managed entries array in one
expression. The map could be collected between evaluating those two arguments,
eventually producing `std::bad_variant_access`.

## Resolution

Generated C++ now emits GC-stress safe points between source statements. At that
boundary, the previous statement has completed and managed results assigned to
source locals are visible to Oilpan's conservative stack scan. The release build
keeps the same calls as compile-time no-ops, while `VEXA_NATIVE_GC_STRESS=1`
forces a collection after each small batch of safe points.

## Ruled-out paths

- Collecting before or after every allocation is not safe while generated C++
  contains nested managed allocations in one expression. A temporary persistent
  root inside `Runtime::make` would stop protecting the raw pointer as soon as
  `make` returned, before the enclosing expression necessarily completed.
- Combining forced conservative collections with AddressSanitizer on macOS
  trapped inside the Oilpan/ASan stack machinery before user output, including
  with ASan's use-after-return fake stack disabled. The ordinary sanitized smoke
  and the forced-GC smoke therefore remain separate, complementary commands.

## Regression prevention

`pnpm test:native:stress` executes the complete native smoke with forced safe-point
collections. `pnpm test:native:sanitized` independently exercises the same smoke
under AddressSanitizer and UndefinedBehaviorSanitizer.
