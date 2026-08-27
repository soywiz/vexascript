# Native self-host callback inference regressions

The native Linux and isolated compiler self-hosting jobs regressed together
after a compiler change introduced a recursive local callback and nested two
generic scope helpers. The generated C++ exposed two independent callback
typing gaps that small language fixtures had not exercised.

A recursively initialized local arrow was emitted as `auto name = lambda`,
which is invalid when the lambda calls `name` from its own initializer. The C++
emitter now recognizes a callable that captures its own binding, declares its
`std::function` storage first, and assigns the lambda afterward. The first fix
attempt used only the analyzed function type; on the complete compiler graph,
that represented an explicitly annotated `void` callback as `Undefined`, while
the lambda correctly emitted `void`. Preferring the callable's emitted type
keeps the storage signature and lambda return type identical.

The generic scope failure came from inferring `T` in a parameter shaped like
`() => T`. For a callback returning `OptionalAssignmentTempScopeResult<string[]>`,
the inference path read only `NamedType.name`, discarded its type arguments,
and produced the bare C++ class template. Mapping the complete analyzed return
type preserves the nested specialization and pointer representation before it
is reused for the function template argument, callback return, and conversion.

The Linux native job also set a skip variable that guarded only the explicit
self-compilation test. The CLI syntax test and the native-CLI fixture/Pixi
bundle test still compiled `cli/cli.ts`, duplicating work owned by the isolated
self-hosting runner. The job-level skip now covers every test that builds the
compiler CLI; the remaining Linux suite continues to validate native language,
runtime, packaging, and module behavior without another compiler self-host.

Focused emitter tests cover recursive local callback storage and generic
callback-result template inference. When a large self-host fails again, keep a
small emission regression for the C++ shape as well as the complete compiler
syntax/self-host validation: either layer alone can miss the other failure
mode.
