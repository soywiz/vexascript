# AGENTS

## Project context

- MyLang is a language derived from TypeScript.

## Testing policy

- We follow TDD (Test-Driven Development).
- Every new feature must include tests in the same change.
- The official test suite runs with Vitest.
- Minimum acceptance criterion: a feature is not considered complete without automated tests validating its behavior.

## Language policy

- All code and documentation must be written in English.

## Documentation policy

- Supported language syntax documentation lives in `docs/syntax.md`.
- Pending TypeScript syntax roadmap lives in `docs/syntax.pending.md`.
- Every time new language syntax support is added, `docs/syntax.md` must be updated in the same change.
- Every time a pending syntax item is implemented, `docs/syntax.pending.md` must be updated in the same change (remove or mark the implemented item).
- Every time new missing syntax is identified, `docs/syntax.pending.md` must be updated in the same change.

## Commands

- Run tests once: `pnpm test`
- Run tests in watch mode: `pnpm test:watch`
