# Imported and local extension methods with the same name

## Symptom

A module could import an extension method and declare a different extension with the same source name:

```vexa
import { addTo } from "./extensions.vx"

fun Object3D.addTo(other: Object3D) {
  other.add(this)
}
```

The local declaration replaced the imported `addTo` signature in receiver-lambda scopes. Calls on the imported receiver were then checked against the local `Object3D` signature. Once that semantic problem was fixed, browser validation exposed a second collision: emission imported both receiver-mangled names from `extensions.vx` and then declared the local `Object3D$$addTo$$Object3D` binding again, producing invalid JavaScript.

## Root causes

Receiver-lambda symbol injection looked up the shared source name in the parent scope. That scope can only retain one `addTo` symbol, so it discarded the receiver-specific distinction already represented by `extensionMethodsByReceiver`.

The emitter also populated `importedExtensionRuntimeNames` while scanning every statement in its combined context program. Because that context contained external and local declarations, local extension runtime names lost their provenance and were emitted as imports.

## Fix

The checker now injects the function type stored under the active receiver directly. Imported extension declarations retain their analyzed function type when it is unambiguous, while receiver-specific declarations remain separate even when their source names match.

Transpilation now builds runtime metadata for ambient and external declarations as a seed, then scans only the local program into the local runtime context. Local extension methods still participate in receiver-based call lowering, but only names from the external seed can become imported extension bindings.

## Investigation notes

The first reduced checker reproduction used empty classes. VexaScript's structural typing made those receivers compatible, so the incorrect signature did not produce a diagnostic. Adding receiver-specific properties made the classes structurally distinct and exposed the bug reliably.

Semantic and bundle-diagnostic tests passed after the checker correction, but they did not parse or execute the generated JavaScript. The real browser smoke test caught the duplicate binding. Inspecting the generated CommonJS bundle showed that call lowering was already receiver-specific; only the import list mixed local and external runtime names. This ruled out changing runtime mangling or extension-call selection.

## Regression coverage

- The LSP regression opens a real three-file project and verifies that imported and local `addTo` methods both type-check inside receiver blocks.
- The emitter regression verifies that the external receiver-mangled name is imported, the local receiver-mangled function is declared locally, and both call sites use the appropriate binding.
- The Three.js sample exercises the exact imported DOM extension plus local `Object3D` extension in a browser bundle.

The broader lesson is to keep receiver identity and declaration provenance in their dedicated data structures. A shared source-level method name is not a safe source of truth for either signature selection or runtime import ownership.
