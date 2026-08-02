# `operator/` Monaco bracket-color regression

The playground showed top-level import braces in different bracket-pair colors. The compiler accepted the source, so the mismatch was isolated to the editor syntax path rather than parsing or semantic analysis.

The shared regular-expression highlighting pattern treated the slash in `operator/` as the start of a regexp literal. In the playground import

```vexa
import { TimeSpan, operator+, operator/ } from "./time.vx"
```

the false match consumed `/ } from "./`, hiding the closing brace from Monaco. Bracket-pair colorization consequently marked the opening brace as unmatched and treated the next import as nested.

The first attempted fix added a negative lookbehind to the regexp pattern so a slash following `operator` could not start a literal. A focused JavaScript regexp test passed, but the real browser still showed the unmatched brace. That test had evaluated the pattern against the complete line; Monarch evaluates a rule against the remaining line fragment, so the regexp could not see `operator` behind the current slash. The browser check was essential evidence that the apparent unit-level fix did not match the editor infrastructure.

The durable fix recognizes the complete `operator/` name before the identifier or regexp rules run. The same operator-name pattern now feeds Monaco, the generated VS Code grammar, and the legacy CodeMirror mode. A focused Monarch-order regression verifies that the first rule selected at `operator/` consumes the complete name, while the existing literal tests continue to cover valid regexps.

The useful diagnostic lesson is that incorrect bracket colors can be downstream evidence of an earlier token-classification error. When balanced source receives unmatched or nested bracket colors, inspect tokens between the opening and closing delimiters before changing bracket configuration or theme colors.
