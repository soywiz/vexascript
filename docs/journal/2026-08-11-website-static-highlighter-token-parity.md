# Website static highlighter token parity

## Symptom

Regular-expression literals were colored in Monaco but rendered as plain text
inside the website's server-generated code blocks.

## Root cause

The portable Monarch language already emitted the shared `regexp` token, but
the website's HTML token-to-class mapping did not recognize it. Unknown tokens
deliberately fall back to unwrapped text, so the shared lexer behavior was
correct while the static presentation silently diverged.

The initial focused fix exposed a deeper infrastructure problem: tests imported
`syntaxHighlight.ts`, while Eleventy imported a separate
`syntaxHighlight.mjs`. The TypeScript path passed its regression test without
changing the generated website because production still executed the other
copy.

## Resolution

The duplicate TypeScript implementation was removed. Tests, TypeScript website
helpers, and Eleventy now all import the same `syntaxHighlight.mjs` runtime,
with `syntaxHighlight.d.mts` providing its TypeScript contract. That renderer
maps `regexp` to `token-regexp`, and the website CSS uses Monaco's base regexp
color for that class. The static renderer further splits delimiters, escaped
characters, character classes, regex operators, and flags into the same
semantic color categories exposed by Monaco. Focused renderer tests cover both
the complete literal and escaped sequences.

When adding a portable syntax token, verify both the editor theme and the
static HTML token mapping. Sharing tokenization alone does not guarantee visual
parity when each rendering surface owns its token-to-style mapping.
