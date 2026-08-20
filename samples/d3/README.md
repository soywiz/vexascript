# D3 sample

This sample exercises the unmodified `d3` package and `@types/d3` declaration
graph through overloaded array helpers, contextual generic callbacks, maps,
callable scale objects, tuple-driven path generation, and deterministic runtime
output.

`html.vx` is a real browser chart. It renders an accessible responsive SVG with
D3 band and linear scales, two axes, a typed data join for the bars, and a line
generator for the trend. Run it with:

```sh
pnpm cli serve samples/d3
```
