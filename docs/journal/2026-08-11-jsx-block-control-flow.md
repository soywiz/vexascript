# JSX block markers should reuse expression control flow

Adding Svelte-style `{#for}` and `{#if}` children exposed two boundaries. The
parser did not need parallel loop and conditional AST families: JSX blocks can
lower to the existing `ArrayComprehension` and `ConditionalExpression` nodes,
with fragments used only when a branch contains multiple children. That keeps
iterator scoping, expression type analysis, traversal, and JavaScript emission
on the same paths as ordinary VexaScript control-flow expressions.

The tokenizer did need one JSX-specific distinction. At the start of a normal
expression container, `/` may begin a regular-expression literal. At the start
of `{/if}` or `{/for}`, the same character is marker punctuation. Treating the
closing marker as ordinary code first produced an “unterminated regular
expression literal” error far away from the opening block. The durable rule is
to tokenize an initial slash followed by an identifier as punctuation only
while scanning a JSX expression container; the parser then validates the exact
closing marker.

The first lowering also wrapped every loop body and conditional branch in a
fragment. Runtime output showed nested fragments around single elements. The
final path unwraps a sole JSX element, fragment, or expression container and
creates a fragment only for zero, text-only, or multiple children. Running the
real sample was useful here because parser and emitter assertions alone proved
correctness but did not make the redundant runtime tree obvious.

The component “not called” symptom was separate from parsing. Classic JSX emits
`React.createElement(MyComponent, props)` and intentionally leaves invocation
to the renderer. A minimal object-building factory therefore has to recognize
function tags, attach its variadic children to props, and invoke the component
itself when eager behavior is desired. Compiler lowering should not bypass the
configured factory, because doing so would break React/Preact lifecycle and
hook semantics.

Making the eager factory faithful to the user reproduction also exposed an
independent checker mismatch: `{ ...args, children }` was rejected when
`args: any`. The emitter already produced valid JavaScript, and TypeScript
permits this dynamic spread. The object-literal inference path now treats
`any` like `unknown`/`object`: it cannot contribute statically known properties,
but it is a valid spread operand. Known primitives remain diagnosed, with both
behaviors covered together so the compatibility fix does not erase the useful
error.

LSP block completion exposed another recovery boundary. While the user is
typing `{#`, `{:`, or `{/`, parsing may legitimately produce no AST. The old
completion handler immediately fell back to ordinary keywords in that state,
so an AST-based completion strategy could never offer the snippet needed to
finish the syntax. JSX block-marker completion therefore runs from the source
text before semantic completion and is also used by the no-AST fallback in the
stdio server and Monaco worker. Tests must cover the public completion entry
point with a genuinely incomplete marker rather than completing a valid AST
around an artificial cursor.

Multi-word markers such as `{:else if}` also cannot rely on the editor's
default “current word” replacement range. After `{:else i`, replacing only
`i` duplicates the already typed `else`. The completion items use an explicit
LSP text edit from immediately after the marker punctuation through the cursor;
Monaco consumes the same edit text and range as VS Code. This preserves one
completion model across both clients.

Snippet indentation must remain relative to the line containing the marker.
The first implementation embedded the line's existing leading whitespace into
every inserted newline. VS Code and Monaco already rebase multiline completion
text onto the indentation of the edited line, so the client added that base a
second time and pushed `{/for}` and `{/if}` too far to the right. The LSP now
sends only the relative two-space body indent and an unindented closing marker.
A real Monaco insertion check compares the rendered leading columns: the
opening and closing markers stay aligned while the placeholder body is exactly
one indentation level deeper.
