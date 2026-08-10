# VexaScript + Vite

This project models an external Vite application. It links the repository package only so the sample can exercise the unpublished local build; a published consumer would use the normal `vexascript` npm version instead.

```bash
pnpm install
pnpm dev
```

`vite.config.mjs` imports `vexascript()` from `vexascript/vite`. Vite owns module resolution, dependency bundling, assets, production builds, and HMR; the plugin transforms each `.vx` module to ESM with a source map.

The transform intentionally does not perform whole-project type checking. Use the VexaScript language server while editing and run the VexaScript CLI in CI when a dedicated semantic check is required.
