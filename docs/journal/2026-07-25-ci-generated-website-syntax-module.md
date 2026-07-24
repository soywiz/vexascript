# Website tests must prepare generated syntax modules

The root `pnpm test` command discovers `website/src/siteContent.test.ts` without running the website build first. The test also imports Eleventy's `.mjs` highlighter, which depends on the generated `website/src/generated/vexa-monarch-language.mjs` module. That generated file is intentionally ignored and therefore is absent from a clean CI checkout, causing the Linux test job to fail before the assertions run.

The test now prepares the generated syntax module immediately before dynamically importing the Eleventy highlighter. This preserves coverage of the production `.mjs` path while making the test self-contained and keeping website build generation as the single source of the generated content.
