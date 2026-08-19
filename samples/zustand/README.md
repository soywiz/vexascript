# Zustand compatibility sample

This sample uses the published Zustand 5.0.15 package without patches or local
declaration overrides. It exercises the vanilla store API through its documented
curried generic factory and keeps the inferred store type across a local module
boundary.

The covered surfaces are:

- the `zustand/vanilla` package export and named `createStore` import;
- `createStore<CounterState>()(...)` curried generic inference;
- contextual parameter types for the state creator and functional `set` calls;
- partial object updates, action calls, subscriptions, and unsubscribe behavior;
- `getState`, `setState`, and `subscribe` member typing after a cross-file import;
- deterministic runtime state and transition output.

React bindings and middleware mutator tuples are intentionally left for the next
coverage increment after the core curried factory remains structurally typed.
