# `operator/` Monaco bracket-color regression

The playground showed top-level import braces in different bracket-pair colors. The compiler accepted the source, so the mismatch was isolated to the editor syntax path rather than parsing or semantic analysis.

The shared regular-expression highlighting pattern treated the slash in `operator/` as the start of a regexp literal. In the playground import

```vexa
import { TimeSpan, operator+, operator/ } from "./time.vx"
```

the false match consumed `/ } from "./`, hiding the closing brace from Monaco. Bracket-pair colorization consequently marked the opening brace as unmatched and treated the next import as nested.

The fix excludes a slash immediately following the operator-name prefix from regexp-literal matching. Keeping that guard in the shared syntax generator fixes Monaco, the generated VS Code grammar, and the legacy CodeMirror mode together. A focused Monarch-rule regression now starts matching at the `operator/` slash and verifies that it cannot produce a regexp token, while the existing literal tests continue to cover valid regexps.

The useful diagnostic lesson is that incorrect bracket colors can be downstream evidence of an earlier token-classification error. When balanced source receives unmatched or nested bracket colors, inspect tokens between the opening and closing delimiters before changing bracket configuration or theme colors.
