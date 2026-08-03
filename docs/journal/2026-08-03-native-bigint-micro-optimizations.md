# Native bigint micro-optimizations and measurement quality

## Investigation

The native bigint benchmark uses the same VexaScript workload for the C++ and
Node.js backends. The C++ implementation already had a linear path for
single-limb division, but multiplication by a single-limb value still created
a full product vector, and `/` and `%` always constructed a quotient/remainder
pair even when only one result was requested. String parsing also multiplied
the magnitude once per input digit.

The benchmark itself ran five complete processes per backend, but the reported
instrumented operation timings came from only the last process. That made the
bigint comparison too sensitive to scheduling and clock noise.

## Resolution

`BigInt::operator*=` now uses the existing in-place small-multiplier primitive
when the right operand has one limb. Single-limb `/` and `%` now divide in
place and return only the requested result. Parsing batches digits into values
that fit one 32-bit limb (nine decimal, seven hexadecimal, ten octal, or 31
binary digits per batch). Multi-limb division remains on the dependency-free
general path.

The native benchmark now reports medians for each instrumented metric across
five runs on both backends. On the 2026-08-03 darwin/arm64 run, the bigint
workload measured 0.07 ms natively versus 0.05 ms in Node.js. This workload is
small enough that native bigint remains about 1.4x slower; the complete native
workload was 8.65 ms versus 45.25 ms for Node.js because startup and the other
runtime workloads dominate the end-to-end result.

The focused native bigint test covers decimal, hexadecimal, octal, and binary
parsing, signed single-limb division and remainder, large multiplication, and
the multi-limb division fallback.
