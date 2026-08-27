# Native Dynamic Smoke And Type Alias Recursion

## What failed

The complete native language smoke initially failed to compile because top-level
generator, Promise, destructuring, timer, and dynamic callable values were each
lowered through unrelated inferred C++ types. Once it compiled, runtime execution
showed that converting a generated class which also implemented an enumerable
interface could replace the object with a structural record snapshot. A pointer
returned where `vexa::Value` was expected could also select the non-explicit
boolean constructor, losing the referenced array.

The full suite then exposed an independent stack overflow while loading Zod.
Recursive type aliases were guarded only while their target text was parsed; the
guard was removed before recursively expanding the substituted target.

## Useful evidence

The single executable smoke made the native failures cheap to order: each run
printed all successful semantics before the next failure. This distinguished
compile-time representation errors from identity loss and dynamic dispatch
errors without relying on generated-code string assertions.

V8 profiling also showed that repeated type-text parsing and C++ declared-type
mapping dominated Node-side native emission. Bounded immutable caches reduced
the 44-module compiler transpile from roughly 42.5 seconds to roughly 15.5
seconds.

## Dead ends

Adding a declared-type cache keyed by a `WeakMap` was fast under Node but made
the compiler source itself unsupported by the native backend because the key was
typed as `object`. A simple per-emission string-keyed map preserved the speedup
and remained self-host compatible.

Treating an awaited Promise according only to the analyzer's broad result type
also left actual arrays and generator results assigned to incompatible globals.
The emitted native operation's concrete result must be unwrapped before choosing
the storage representation.

## Durable rules

* Preserve a generated dynamic object's identity before considering structural
  enumerable adaptation.
* Dynamic pointer overloads must prevent accidental pointer-to-boolean
  conversions.
* Keep recursive alias guards active through substituted-target expansion.
* Validate C++ semantics by compiling and running the complete smoke; reserve
  unit tests for target-independent analysis behavior and instrumentation.
