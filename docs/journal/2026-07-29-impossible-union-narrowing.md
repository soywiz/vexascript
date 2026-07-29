# Impossible union narrowing

Literal equality narrowing previously returned the checked literal whenever a
condition was true. For a value declared as `"ok" | "error"`, checking
`value === "pending"` therefore made the unreachable branch appear to contain
`"pending"` rather than `never`.

The shared narrowing helper now checks whether the literal can be assigned to
at least one member of the original union. It returns `never` when none match,
while retaining the checked literal for compatible unions such as `string |
number`. The regression assigns the unreachable value to `never`, matching
TypeScript's control-flow result.
