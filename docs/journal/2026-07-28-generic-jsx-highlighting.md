# Generic declarations misclassified as JSX

The portable Monarch tokenizer treated `<T>` in a generic receiver declaration
such as `fun <T> T.apply(...)` as the start of a JSX element. Because no closing
`</T>` followed, the tokenizer remained in its JSX children state and left the
rest of the code block without normal keyword highlighting.

The fix belongs in the shared portable tokenizer rather than in the website
renderer. Declaration keywords followed by `<` now enter a dedicated recursive
type-parameter state before the JSX rules are considered. The state supports
nested generic arguments and returns to normal code highlighting after the
outer `>`, while genuine JSX continues through the existing JSX states.

The original screenshot was important because checking only the `<T>` token
would have missed the larger failure: the persistent JSX state corrupted every
following line. The regression test therefore verifies both that `<T>` is not a
tag and that later `class`, `var`, and `val` tokens retain their keyword
classes.
