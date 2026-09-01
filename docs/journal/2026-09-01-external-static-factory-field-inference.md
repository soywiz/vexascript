# External static factory field inference

## Symptom

An imported VexaScript class exposed a field initialized with an external
static factory call:

```vexa
class Scene {
  readonly world = World.Create()
}
```

Definition navigation from `scene.world.Destroy()` reached the correct
declarations, but semantic analysis typed `world` as `unknown` and reported the
instance method as missing.

## Cause and fix

Cross-file class member collection uses a deliberately lightweight initializer
inference path. It already recognized direct class construction such as
`Point(0)`, but did not inspect member calls such as `World.Create()`. Symbol
navigation therefore remained correct while the independently collected field
type lost the factory return annotation.

The lightweight path now resolves a static member through the same named class
member map and extracts its declared callable return type. This preserves
overload unions through the existing `ReturnType` utility logic and avoids a
parallel representation of external method signatures.

## Investigation note

The working go-to-definition initially suggested that imported package symbol
resolution itself might be incomplete. A minimal two-class regression showed
that direct calls on an imported `World` were already typed correctly; only a
factory result stored in a field of another imported class became `unknown`.
That distinction localized the defect to cross-file initializer inference.

## Execution metadata

- Model: Unavailable (not exposed by runtime)
- Provider: Unavailable (not exposed by runtime)
