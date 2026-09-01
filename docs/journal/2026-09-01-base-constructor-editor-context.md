# Base-constructor editor context

## Problem

The analyzer already checked `extends Base(...)` as a constructor invocation,
but the LSP only recognized ordinary call and `new` AST nodes. Consequently,
signature help and named-argument completion were absent inside the heritage
argument list, while definition on `Base` navigated to the class declaration
instead of an explicit constructor.

## Change

The parser now retains the heritage argument list's closing parenthesis as
non-enumerable source metadata. `baseConstructorInvocation.ts` turns the class
heritage representation into one shared editor context consumed by signature
help, argument completion, hover, and definition. Explicit constructors are the
navigation target; primary constructors continue to use the class declaration.

## Verification

- Regression tests cover signature help, named-argument completion, and
  cross-file constructor navigation.
- TypeScript compilation, the full test suite, self-host verification, and the
  CLI fixture are run before integration.

## Execution metadata

- Date: 2026-09-01
- Provider: OpenAI
- Model: Codex
