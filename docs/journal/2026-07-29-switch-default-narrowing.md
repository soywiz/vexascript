# Switch default narrowing

Explicit `switch` cases already narrowed a stable discriminant, but `default`
received no type evidence and therefore retained every object-union branch.
The switch visitor now derives the default type by subtracting all literal case
labels from a union discriminant. This reuses normal expression narrowing, so
member validation sees only the remaining discriminated branches.
