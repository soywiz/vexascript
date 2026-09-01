# Inherited implicit-member navigation

## Problem

Bare instance-member calls inside a class were correctly bound as implicit
`this` accesses, but cross-file definition navigation only derived receiver
types from extension functions and receiver lambdas. The fallback therefore
selected a declaration-like occurrence in the current file instead of the
inherited member in its base class.

## Change

Implicit-receiver navigation now derives the receiver type from the innermost
enclosing class when no narrower receiver context applies. It then uses the
shared class-member declaration resolver, which follows imported inheritance
chains and preserves the declaring file and exact member range.

## Verification

- A cross-file regression covers a bare `addComponent(...)` call in `Player`
  inherited from `GameObject`.
- TypeScript compilation, the complete cross-file navigation suite, and the
  full 2,937-test suite pass.

## Execution metadata

- Date: 2026-09-01
- Provider: OpenAI
- Model: Codex
