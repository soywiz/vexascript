---
name: create-vexascript-samples
description: Create or update runnable VexaScript samples under samples/, including browser samples patterned after samples/preact and Node.js samples patterned after samples/node. Use when adding a new sample, wiring package.json or tsconfig.json for runtime-specific dependencies, defining expected.txt output, or documenting the sample in the repository architecture map.
---

# Create VexaScript Samples

Use this skill when adding or updating runnable examples in `samples/`.

## Choose the sample shape

- Browser sample: follow `samples/preact/` when the sample needs DOM APIs or a served `index.html`.
- Node.js sample: follow `samples/node/` when the sample demonstrates Node built-ins or `@types/node`.

## Required harness contract

- Every runnable sample must live in `samples/<name>/`.
- The sample test harness discovers directories that contain `expected.txt`.
- `main.vx` must run under the Node-based sample harness and print deterministic output that matches `expected.txt`.
- If `package.json` exists and `node_modules` is absent, the harness runs `pnpm install` inside that sample directory.

## Browser sample recipe

Start from `samples/preact/` and keep these files unless the sample has a strong reason not to:

- `main.vx`: deterministic console output for the automated sample harness.
- `html.vx`: browser entrypoint used by `serve` and bundle flows.
- `index.html`: must include `%VEXA_ENTRYPOINT%` in a module script tag.
- `vexascript.json`: set `"entrypoint": "html.vx"`.
- `tsconfig.json`: include `"dom"` in `compilerOptions.lib`.
- `package.json`: add browser dependencies used by the sample.

Browser samples should also be checked in a real browser before handoff.

## Node.js sample recipe

Start from `samples/node/` and keep these files unless the sample is intentionally simpler:

- `main.vx`
- `expected.txt`
- `package.json` when npm packages or `@types/node` are needed
- `tsconfig.json` with `compilerOptions.types: ["node"]` for Node ambient declarations

Prefer async Node APIs in examples. Do not introduce synchronous I/O.

## Repo updates that travel with the sample

- Update `docs/file.structure.md` when a new notable sample or sample-support surface is added.
- If the sample demonstrates new language syntax, update `docs/syntax.md` in the same change.

## Validation

- Run `pnpm test`.
- Run `pnpm cli vexa testFixtures/sample.vx`.
- For browser samples, run the served sample in a real browser and confirm it renders.
