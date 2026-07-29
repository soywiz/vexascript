# Native self-host callback contracts

The native self-host test failed while compiling the second-generation C++ CLI.
The regular TypeScript suite and the first native compilation succeeded, but
the native compiler inferred `Null` for the switch-case mapper and homogeneous
enum-pointer arrays for heterogeneous `[string, enum]` map entries. Clang then
reported unrelated-looking `toString(Null)`, `isInstance(Null)`, and invalid
pointer-to-string conversion errors.

The failing Actions run was not the regression boundary. Actions history showed
the same map-entry errors beginning at `378389bf`, while `9d9385e2` was the last
green run. Reverting only the latest compound-narrowing change and trying both
sequential and literal-only narrowing variants preserved the native failure,
which ruled out the visible head commit as the cause.

The durable fix makes the compiler's internal callback contracts explicit at
the three self-host-sensitive sites:

- switch-case mapping returns `AnalysisType | null`;
- enum member entries return `[string, EnumMember]`;
- emitter enum entries return `[string, EnumStatement]`.

These annotations make the first-generation C++ use `AnalysisType*` and dynamic
`Value` tuples instead of relying on contextual generic inference while the
compiler is compiling itself. The focused native self-host test is essential:
ordinary analysis and emitter tests cannot detect a semantic divergence that
appears only when the native compiler runs the same source a second time.
