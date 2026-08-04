# Do not offer `this.` fixes on declaration identifiers

## Symptom

The LSP offered `Add 'this.'` when the cursor was on a class member
declaration. The same quick-fix must remain absent from local declarations;
those identifiers are bindings, not implicit instance-member references.

## Investigation

The quick-fix intentionally uses the analysis symbol table because class
members are exposed as implicit-receiver symbols at their use-sites. However,
the visible-symbol fallback in `Analysis.getSymbolAt` also returns that symbol
when the cursor is on its declaration identifier. A local declaration usually
resolves to its own local symbol, so the existing local regression appeared
correct even though the declaration/use distinction was not explicit in the
quick-fix.

## Resolution

`findImplicitReceiverIdentifierAtPosition` now rejects a match when the
resolved symbol's declaration node is the identifier under the cursor. This
keeps the existing fix for real unqualified member references while excluding
class fields and any other declaration-backed implicit-receiver symbols.

## Regression coverage

LSP quick-fix tests cover an unqualified instance-member use, a class member
declaration, and a local declaration.
