# Array receiver shorthand and non-null receiver blocks

## Observed problem

The parser already accepted `T[]` in ordinary type annotations, but extension declarations only read the receiver's leading identifier before looking for the member dot. A declaration such as `fun <T> T[].second(): T` therefore stopped at `[]` and reported that a function parenthesis was expected.

The same parser asymmetry affected receiver-block shorthand after a direct non-null assertion. `value!. { ... }` tokenizes `!.` as one operator, while the existing receiver-block path only handled a standalone `.` after the expression. Parenthesizing the asserted expression hid the difference.

## Fix and regression coverage

Array-suffix extension receivers are normalized during parsing to the existing `Array` receiver plus its element type argument. This reuses the established generic extension lookup and emission path instead of adding a second receiver representation. Both extension methods and properties are covered, including semantic resolution against `int[]` values.

The postfix parser now recognizes `!.` followed by a receiver block and creates the same explicit receiver-block call shape as `value! . { ... }`. Parser tests cover the direct syntax and preserve the expression-bodied lambda representation used for a single assignment.

## Lesson

When a syntax form is already supported in type annotations, extension-declaration parsing must either reuse that type parser or normalize its result into the same receiver model. Postfix operators that combine member access with shorthand constructs also need a regression at the tokenized boundary, because punctuation adjacency can select a different token than the spaced form.
