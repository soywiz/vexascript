# Question Kingdom

A side-scrolling platform game written in [VexaScript](https://vexa.soywiz.com/syntax/ai). It uses PIXI.js 8 for rendering and `@box2d/core` for physics.

This copy is maintained as a VexaScript repository sample. Its local `vexascript` dependency points to the repository root so it exercises the compiler version in the current checkout.

## Run

```bash
pnpm --dir ../.. build
pnpm install
pnpm dev
```

The game code lives in `.vx` modules. Vite compiles them through the official `vexascript/vite` plugin; `pnpm build` creates the production bundle and `pnpm preview` lets you test it locally. Compiler settings are in `vexascript.json`, and the Vite integration is in `vite.config.mjs`, following the [official Vite example](https://github.com/soywiz/vexascript/tree/main/samples/vite).

## Controls

- `A` / `D` or arrow keys: move
- `Shift`: run
- `W`, up arrow, or space: jump (hold to jump higher)
- `S` / down arrow: crouch and walk slowly; underwater, it lets you dive
- Down + jump: drop through a one-way platform
- Underwater, press jump repeatedly to swim upward
- Jump against a wall, then press jump again to launch in the opposite direction
- Hold jump when landing on an enemy to bounce higher
- `P` or `Esc`: pause
- `F2`: toggle between sprites and the Box2D debug view
- `R`: restart during the game; after winning or losing, any physical or virtual key or button works

Standard gamepads are also supported: use the left stick or D-pad to move, `A` to jump, `X`/trigger to run, `Start` to pause, and `Select` to restart. Touchscreens display a translucent D-pad and a jump button.

The turquoise platforms are *one-way*: the character passes through them while moving upward and lands on them while falling. To drop down, hold down and press jump. The character can crouch, move more slowly with a reduced bounding box, and remain crouched under low ceilings. Crouch-jumping works normally on solid ground; down+jump only drops through when standing on a one-way platform. The level includes a horizontal moving platform that slows smoothly to a stop at either end before returning and carries the character standing on it. There is also a floating block enemy: it detects the player below, falls to crush them, and then rises again; its upper face is a safe platform, and jumping on it does not destroy it. The ascent area uses five one-way ramps arranged vertically in a zigzag: first climbing to the right, then to the left, and continuing in alternation. Two are ice ramps that greatly reduce control and braking, so gravity makes the character slide downhill. The deep pool applies buoyancy, drag, and underwater controls: the character sinks slowly and gains height through repeated strokes, Mario-style. Slimes patrol until they reach a wall or ledge, frogs move by hopping, and bees hover while patrolling from side to side; all display an animation when defeated. Hit the `?` blocks from below and collect the floating coins scattered throughout the level; every pickup triggers a small particle emitter. Climb the final tower by alternating wall jumps between its two walls while the camera follows the ascent.

## Art and sound

Sprites, tiles, and sound effects come from [Kenney's New Platformer Pack on OpenGameArt](https://opengameart.org/content/new-platformer-pack), released under CC0. Attribution is not required, but is included to credit the author. At startup, the game parses Kenney's XML files and creates PIXI textures directly from the atlases without loading individual images.

The distribution retains the original `public/assets/kenney/Spritesheets/` folder, containing the eight PNG atlases and their eight XML descriptions from the `kenney_new-platformer-pack-1.0` package.

## Architecture

The game uses Unity-style entity composition and keeps each entity, component, and script in its own VexaScript module:

```text
src/game/
├── core/       GameObject, Component, GameScene, Rigidbody, events, and contacts
├── entities/   Player, enemies, Ground, Platform, Wall, Coin, QuestionBlock, and Goal
├── scripts/    controls, AI, handlers, animations, particles, and one-way behavior
├── systems/    camera and global scene systems
├── render/     background and physics debug rendering
├── ui/         HUD and overlays
└── world/      LevelBuilder and level composition
```

Each entity attaches its components in the constructor. For example, `Enemy` is composed of `Rigidbody`, `EnemyPatrol`, and `EnemyContactHandler`; `Platform` attaches `OneWayPlatformHandler` only when appropriate. `PhysicsContactRouter` translates global Box2D callbacks into `onBeginContact`, `onPreSolve`, and `onPostSolve` events on the components of the relevant `GameObject`.
