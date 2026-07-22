# Native emitter allocation profile

Sampling the O1 self-hosted compiler showed that C++ emission remained the
largest phase after semantic analysis. The recurring costs were small UTF-16
allocations and copies, string-keyed hash-table lookups, `Value` destruction,
and persistent-handle bookkeeping rather than one isolated algorithm.

The largest improvement in this iteration came from preserving JavaScript
collection copy semantics without eagerly duplicating native storage. Copies of
statically typed `Map` and `Set` instances now share immutable storage and
detach on the first mutation. The native smoke test mutates both source and copy
independently so future storage changes cannot accidentally introduce shared
mutation or eager-copy regressions.

Several smaller changes compound on hot emitter paths:

- state-restoration `try/finally` blocks were removed where an exception aborts
  the complete emission anyway;
- disabled source-location emission no longer allocates empty preamble arrays;
- callback helpers retain their concrete callable type instead of erasing it to
  `std::function` in generated C++.

On the same compiler input, the native O1 wall time fell from roughly 4.25
seconds to a median near 3.63 seconds. A phase profile measured approximately
1.64 seconds in C++ emission and 1.38 seconds in merged semantic analysis. The
current Node process took roughly 4.03 seconds for the same operation, so the
native compiler became faster but did not yet reach the 25% lead target.

Two attempted shortcuts did not provide valid improvements:

- replacing exact-size `Array.join` assembly with repeated `std::u16string +=`
  made emission slower because the builder repeatedly reallocated and copied;
- loading mimalloc through `DYLD_INSERT_LIBRARIES` reported no intercepted
  allocations, so it did not measure the allocator used by the C++ containers.
  A valid allocator comparison must link mimalloc into the same O1 object.

Enabling Apple's nano allocator reduced the median to about 3.34 seconds. A
subsequent controlled test compiled the generated compiler once to an O1 object
and linked that exact object with either the system allocator or mimalloc 3.4.3.
Alternating three hot runs produced stable medians of 4.08 seconds and 3.28
seconds respectively, a 19.6% reduction. Every generated C++ output was
byte-identical.

Native executable builds now package the checksum-verified upstream mimalloc
3.4.3 source archive, compile its override object once in the existing temporary
dependency cache, and link it before Oilpan. Sanitizer builds intentionally omit
the override. This keeps the optimization reproducible across supported native
platforms rather than depending on Homebrew or dynamic-library injection.

For the same generated compiler translation unit, O3 compilation took 129.9
seconds versus 108.0 seconds at O1. Three hot O3+mimalloc executions had a 3.08
second median; three freshly measured Node executions had a 4.14 second median.
O3 therefore made native generation 25.6% faster than Node for this checkpoint.
The O3 compiler remained self-consistent across its repeated outputs, although
its output still differs from the current Node compiler around native conversion
simplification. Cross-runtime byte parity remains separate follow-up work.
