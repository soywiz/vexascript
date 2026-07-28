# Website tests must prepare generated syntax modules

Superseded on 2026-07-28: the source-inspection test described below was removed when website validation was narrowed to a successful production build and a functional playground smoke test. See `2026-07-28-website-validation-boundary.md`. The original incident remains here as historical context for why source-coupled website tests carried hidden setup costs.

The root `pnpm test` command discovers `website/src/siteContent.test.ts` without running the website build first. The test also imports Eleventy's `.mjs` highlighter, which depends on the generated `website/src/generated/vexa-monarch-language.mjs` module. That generated file is intentionally ignored and therefore is absent from a clean CI checkout, causing the Linux test job to fail before the assertions run.

The test now prepares the generated syntax module immediately before dynamically importing the Eleventy highlighter. This preserves coverage of the production `.mjs` path while making the test self-contained and keeping website build generation as the single source of the generated content.
