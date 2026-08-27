# Native CLI second-generation regressions

## Context

Compiling `cli/cli.ts` to a native executable was not a sufficient self-hosting check. The first executable linked successfully, but asking it to compile and link `cli/cli.ts` again exposed C++ emission and runtime gaps that the Node-hosted compiler did not reveal.

## Failures found

- String spread had no UTF-16-aware native `appendAll` overload.
- `String.prototype.codePointAt` was neither typed nor emitted through the native runtime.
- `&&=` and `||=` were emitted as unsupported C++ compound operators instead of using the shared assignment helper with short-circuiting.
- A recursive local inference lambda could not name itself after C++ lowering.
- Dynamic arithmetic could initialize a statically numeric local without conversion.
- Match binding lowering constructed a mixed inferred array instead of an explicit `Statement[]`.
- A local callback declared as returning `string | undefined` was boxed from stale inferred analysis as `std::function<Undefined(...)>`, although its emitted lambda returned `Value`.

## Investigation notes

Changing union flattening to preserve source order was necessary to replace the recursive local lambda, but it did not fix the callback failure. Preserved second-generation C++ showed that the lambda itself correctly returned `vexa::Value`; only the `makeFunction` template arguments had degraded to `vexa::Undefined`. The durable fix was to make callback boxing prefer the already selected local C++ callable signature and explicit return annotation over a less precise analysis type.

## Regression strategy

The native language smoke sample now exercises logical assignment, Unicode string spread, `codePointAt`, typed match captures, and optional string callback returns. Focused emitter tests cover each lowering, while the native CLI smoke test remains the essential fixed-point check: build the CLI natively, use that binary to build the CLI again, execute the second binary, and then compile representative FFI and bundle workloads.

The lesson is to keep both levels. Fast generated-C++ assertions explain individual failures, but only the second native generation detects drift between the Node-hosted and native-hosted compiler paths.
