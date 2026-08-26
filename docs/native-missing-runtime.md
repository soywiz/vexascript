# Native generated C++ runtime gaps

This document records ECMAScript and host APIs that are intentionally unavailable when VexaScript generates native C++. It complements the executable coverage modules in `samples/native-language-smoke/standard-library/` and the declaration lock in `compiler/runtime/nativeStandardLibraryCoverage.ts`.

The native smoke covers the declared ECMAScript runtime by family. An API must either execute in that smoke or appear in the unsupported policy with a technical reason. Browser workers and other browser host APIs are outside this pass.

## Unavailable ECMAScript APIs

| API | Reason |
| --- | --- |
| `Function`, `Function.prototype`, `CallableFunction`, and `NewableFunction` reflective members | Generated functions use several concrete C++ representations (`std::function`, templates, generated methods, coroutines, and dynamic callable wrappers). There is not yet one heap `Function` object with JavaScript-compatible identity, prototype, `arguments`, `caller`, `apply`, `bind`, and `call` semantics. Adding only selected methods would make behavior depend on the chosen lowering. |
| `Symbol`, the global symbol registry, and well-known symbols as runtime values | Native object storage currently uses UTF-16 string keys. Supporting symbol identity requires a second property-key representation throughout records, generated classes, descriptors, enumeration, maps, and dynamic dispatch, which changes object layout and every property access path. |
| `Object.getOwnPropertySymbols` | Depends on symbol-key storage. All string-keyed descriptor, prototype, extensibility, sealing, and freezing APIs are available. |
| Accessor descriptors passed to `Object.defineProperty`, `Object.defineProperties`, or `Object.create` | Data descriptors are supported. Getter/setter descriptors require every optimized generated field access to participate in dynamic accessor dispatch and therefore change generated object layout and access lowering. The native runtime rejects accessor descriptors instead of silently treating them as data. |
| `Proxy` | Correct proxy traps must intercept every property read, write, call, construction, deletion, enumeration, descriptor, and prototype operation, including accesses currently emitted as direct C++ fields. This needs a unified dynamic object layout and is intentionally deferred. |
| `Reflect` | The namespace is deferred as one coherent reflection surface. Its property operations have the same direct-field, descriptor, symbol-key, callable, and construction constraints as `Proxy`, `Symbol`, and reflective `Function` values. |
| `eval` | Native executables do not embed the VexaScript parser, compiler, C++ toolchain, or a JavaScript JIT. Evaluating source text at runtime would require a separate execution engine and cannot preserve lexical-scope semantics through ahead-of-time C++ lowering. |
| `WeakRef` | Oilpan weak-reference observation has not been exposed with ECMAScript-compatible liveness and cleanup timing. |
| `FinalizationRegistry` | ECMAScript finalization callbacks require observable GC lifecycle scheduling that the native event loop and Oilpan integration do not currently provide. |

## Host APIs excluded from this pass

Workers are deliberately omitted for now: `Worker`, `SharedWorker`, service workers, worker-global scopes, `postMessage`, structured clone between agents, and related browser worker scheduling. They are host APIs rather than the core ECMAScript runtime and require thread isolation, message serialization, and a per-worker runtime/event loop.

The bundled `es2025.d.ts` intentionally excludes DOM, WebWorker, and ScriptHost declaration libraries. Their absence is therefore not counted as a covered ECMAScript-family exception.

## Compact native internationalization contract

The native `Intl` implementation is intentionally English-only and dependency-free. It does not link ICU, CLDR, an operating-system locale database, or a generated locale-data bundle. This keeps executable size deterministic and avoids a large external data source.

- `en` and `en-*` are the locales reported by `supportedLocalesOf`. Other valid tags may be canonicalized, but formatting, collation, plural rules, display names, lists, relative time, dates, durations, and segmentation use English semantics.
- Locale identifiers are canonicalized with compact BCP 47 casing rules. English maximize/minimize uses the `Latn` script and `US` default region.
- `supportedValuesOf` exposes only values implemented by the compact runtime.
- Display-name data is restricted to the small English set exercised by the native runtime. Unknown codes follow the requested `fallback` behavior.
- Segmentation implements UTF-16-safe grapheme handling for surrogate pairs plus compact English word and sentence boundaries. It does not ship the full Unicode segmentation database.

Every public `Intl` constructor and method declared in the bundled runtime has an executable smoke case, including `Segments.containing`. The limitations above concern locale data breadth, not missing method entry points.

## Compact Unicode normalization

`String.normalize` supports all four forms and performs canonical composition/decomposition for common Latin precomposed characters, plus compact compatibility handling such as non-breaking space and the `fi` ligature. Full Unicode normalization tables are not embedded yet. This is a data-coverage limitation rather than a missing method; unsupported forms still throw as ECMAScript requires.

## Source of truth

- Executable cases: `samples/native-language-smoke/standard-library/*.vx`
- Declaration-to-smoke lock: `compiler/runtime/es2025.test.ts`
- Unsupported diagnostics: `compiler/runtime/nativeStandardLibraryCoverage.ts`
- Native implementations: `native/runtime.cpp`, `native/utf.h`, and `native/bigint.h`

When an API becomes available, remove its unsupported policy entry, add an executable category test, and update this document in the same change.
