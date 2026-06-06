# Pending Tasks

This document tracks the current technical backlog for MyLang.

## High Priority

## Semantic Analysis

All current high-priority semantic analysis backlog items are implemented.

## Transpilation and Runtime

- Cross-file extension members (operators and named methods) resolve to their
  receiver-mangled standalone functions only when the local module graph is
  bundled (`bundleModuleGraph`), which strips local imports. When emitting a
  single module to real ES modules, the source-level import (e.g.
  `import { operator+ }` / `import { distance }`) is not yet rewritten to the
  mangled export name, so non-bundled cross-file usage would not link. Extension
  properties already rewrite their imported name; methods/operators should get
  the same treatment if non-bundled ESM output becomes a target.
