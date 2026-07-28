# Website validation stops at the build and playground

Website tests had accumulated assertions that read Nunjucks templates, Markdown, CSS, and build scripts as text. They pinned headings, sample cards, article length, selectors, exact declarations, and implementation wiring without exercising the rendered site. Small editorial or visual changes therefore broke the repository test suite even when the production build and playground remained healthy.

These tests did not provide a durable contract. They duplicated checks already performed by the Eleventy/esbuild production build, and visual assertions over CSS source could not establish that the layout worked in a browser. A runtime program-cache case in `compiler/website.test.ts` was also redundant with the stronger canonical coverage in `compiler/runtime/programCache.test.ts`.

The website acceptance boundary is now:

1. `pnpm website:build` must succeed.
2. The real `/playground` must initialize in a browser and run the bundled sample.
3. Functional playground/editor and shared compiler behavior may retain focused automated tests.

Do not add automated tests merely to prove that website prose, sections, cards, template fragments, generated HTML, selectors, declarations, or visual styles exist. Review editorial content directly and let the build catch structural compilation failures.
