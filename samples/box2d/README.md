# Box2D

This sample uses the same `@box2d/core` 0.10.0 package as the platform game.
It creates a static floor and a dynamic box, advances the world for two seconds,
and verifies the resting position.

It also exercises primary-constructor property modifiers, inherited
`Object.constructor` metadata, and contextual typing of an empty
`Array<() => void>` field.
