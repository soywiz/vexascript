# Web syntax highlighting had two unsynchronised implementations

The website had a TypeScript highlighter used by tests and an equivalent `.mjs` highlighter used by Eleventy. Updating only the TypeScript implementation made focused tests pass while the rendered site still treated `class`, `fun`, and `sync` as identifiers. The production path must be tested through `website/src/syntaxHighlight.mjs` or a generated site page as well.

The shared Monarch tokenizer also kept a `///` line-comment state across newlines because its state rule allowed `\n` inside a greedy character class. Restricting the body to non-newline characters and explicitly popping on line breaks fixes both HTML rendering and Monaco behavior.

When validating this surface, restart the website development server after changing the imported `.mjs` module. Eleventy can keep the old module in memory during watch mode even after it rerenders templates.
