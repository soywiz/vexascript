# Monaco semantic token color drift

Monaco rendered VexaScript regular-expression literals with the string color, while matcher keywords and arrow/comparison operators appeared unhighlighted. The portable Monarch grammar and Monaco theme already had a regular-expression rule and color, so the first suspected layer was not the cause.

The decisive check was the rendered editor DOM: semantic tokens had overlaid the lexical `regexp` token as `string`, and the semantic classifier did not include VexaScript's matcher keywords or all of its arrow operators. The durable fix was to give regular expressions their own semantic token type, reuse the canonical control-keyword list, and extend the shared operator set. The browser smoke test then confirmed that the semantic classes and final computed colors were distinct.

A follow-up visual check showed that the complete regexp was still represented by one semantic range, so the grammar could not color escapes, character classes, anchors, quantifiers, delimiters, or flags independently. The fix keeps the tokenizer's complete regexp token for parsing, but emits ordered semantic subranges for those parts and gives each subrange a Monaco theme color. This preserves the parser contract while allowing the editor to layer precise regexp highlighting.
