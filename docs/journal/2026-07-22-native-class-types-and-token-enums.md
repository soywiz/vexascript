# Native class types and token enums

The compiler's analysis-type hierarchy now uses concrete classes and `instanceof` instead of string discriminators. This keeps the TypeScript implementation directly representable as static C++ classes and exposes more narrowing information to native emission. Typed optional access, contextual receiver callbacks, and typed collection fallbacks were added to the native language smoke while stabilizing the migration.

`TokenType` and `TokenCommentKind` were also converted to numeric `const enum`s. The first native self-host test exposed an important portability trap: an enum member named `EOF` is expanded by the C standard-library macro in generated C++. Renaming it to `END_OF_FILE` fixed the source model without adding a target-specific emitter escape. Future enum migrations should check generated identifiers against common platform macros.

The initial full-suite run also exposed two smoke expectations that had only been added to `expected.native.txt`. The JavaScript sample runner uses `expected.txt`, so behavior shared by both backends must be added to both expected outputs in the same change. Focused native execution alone would not have caught that drift; the full suite did.
