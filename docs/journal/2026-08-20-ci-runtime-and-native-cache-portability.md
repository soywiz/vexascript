# CI runtime and native cache portability

## Symptoms

The main workflow had three independent failures after the native standard
library smoke and Hono type-checking optimizations landed:

- the Node 22 coverage job executed `Math.f16round`, which that host does not
  expose yet;
- the Linux native smoke failed to link the libstdc++
  `_Sp_counted_ptr_inplace<Task<int>::State>` virtual members;
- the isolated compiler self-host failed while emitting the spread argument in
  `emittedStatements.splice(..., ...emittedInitStatements)`.

The ordinary local test suite passed, and macOS linked the native smoke. The
workflow logs and the complete local `pnpm self-host:ci` fixed point were both
required to expose all three platform and host differences.

## Native type-ID cache failure

The self-host regression came from the identity-key optimization for generic
type substitution. `analysisTypeId` stored numeric IDs in a
`WeakMap<object, number>` and detected a missing entry by comparing `get()`
with `undefined`. The native `weakMapGet` helper returns the statically typed
default for a missing primitive value, so a missing number became `0`. Every
analysis type therefore appeared to have ID zero under the native host, and
unrelated substitutions collided in the same cache entries.

The first visible effect was misleading: the corrupted analysis stopped
recognizing an emitter-local receiver as `string[]`, so the C++ emitter missed
its existing `Array.splice` spread path and rejected the `SpreadExpression`.
Replacing that one spread with an insertion loop only exposed the deeper
damage: the next generated compiler contained `string[]` where
`AnalysisType[]` and `FunctionTypeParameter[]` were required.

The durable fix keeps the fast identity cache but checks `WeakMap.has()` before
reading the numeric value. A present entry remains statically typed as a
number, while a missing entry no longer depends on the host representation of
`undefined`.

An attempted general `weakMapGetValue` route was also rejected. Routing every
non-pointer-looking `WeakMap.get()` through a dynamic `Value` preserved the
missing sentinel, but degraded class, array, and weak-set metadata whose
generic result type was not fully recovered at that call site. The first C++
generation then failed on dynamic member access and collection arguments.
Keeping the fix at the numeric cache contract avoids changing unrelated weak
map representations.

## Node and Linux portability

The declaration-locked standard-library program still executes
`Math.f16round` in the native runtime, but skips that call on JavaScript hosts.
This keeps Node 22 in the supported CI matrix without pretending that its V8
version implements every ES2025 API exposed by the native runtime.

The Linux linker failure was specific to the standard-library control block
instantiated for `Task<int>::State` in the single-translation-unit build. Clang
with libstdc++ omitted the `_Sp_counted_ptr_inplace` virtual members. Replacing
`make_shared` with `shared_ptr(new State())` was a useful diagnostic but not a
fix: the same build then omitted the replacement control block's virtual
members, and libc++ reproduced that second failure on macOS.

`Task<T>` and `Task<void>` now use one small intrusive `TaskStateHandle`. Its
atomic reference count preserves the existing shared-state lifetime contract
without depending on a standard-library polymorphic control-block
specialization. The original value-returning sync and async brace-lambda smoke
therefore remains unchanged and continues to exercise the `Task<int>` path
that exposed the regression.

## Validation

The CI-equivalent single-file native suite passes all 50 enabled tests,
including the complete native sample and deterministic sample matrix. The
complete self-host workflow proves both fixed points: the TypeScript and
JavaScript hosts emit identical C++, and two consecutive native hosts emit
byte-identical C++.
