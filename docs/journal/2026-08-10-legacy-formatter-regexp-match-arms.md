# Legacy formatter regular-expression match arms

Formatting the website playground corrupted the regular-expression match arm `/^user-[0-9]+$/i` into spaced division and operator tokens. The starter document contains template literals, so `formatSource` deliberately bypassed the AST formatter and sent the whole file through the legacy token formatter. Existing formatter coverage for regular-expression match arms exercised only the AST path and therefore gave false confidence.

The useful dead end was testing a compact match expression whose regular expression immediately followed `{`. That happened to pass because `{` already allowed a regular-expression literal in the legacy tokenizer. The real playground shape placed another match arm before the regular expression, so the previous significant token no longer permitted one.

The durable fix was to reuse the parser tokenizer's existing lookahead for regular-expression match arms in the legacy formatter instead of adding another independent rule. Regression coverage must include a template literal before a later regular-expression arm so it exercises the same fallback path as the playground. Browser verification should format the complete starter document because isolated formatter examples can select a different implementation path.
