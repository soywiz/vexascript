---
name: deploy-vexascript-website
description: Validate and deploy the VexaScript documentation website and Monaco playground to the repository's web branch. Use when asked to review, test, publish, redeploy, or troubleshoot the VexaScript website, especially the playground, or when asked to push the current release to origin/web.
---

# Deploy the VexaScript Website

Validate the exact commit in the repository before publishing it to `origin/web`. Treat the branch update as a production deployment.

## Preflight

1. Read `AGENTS.md` and preserve unrelated user changes.
2. Run `git status --short --branch`, `git remote -v`, and `git fetch origin main web`.
3. Confirm `origin/web` is an ancestor of the commit to deploy with `git merge-base --is-ancestor origin/web HEAD`. Stop if the update would require a force push or if the deployment target is ambiguous.
4. Install dependencies with `pnpm install --frozen-lockfile` only when dependencies are missing or lockfiles changed.

Do not deploy uncommitted changes. Never force-push the `web` branch.

## Validate the Website

1. Run `pnpm website:build` and require a successful production bundle and Eleventy build.
2. Start the repository server with `pnpm website`. Keep it running while testing.
3. Use a real browser against `http://127.0.0.1:7070/playground`. Smoke-test that:
   - the playground initializes without critical console errors;
   - Monaco, the bundled workspace, runtime declarations, and workers load;
   - running the bundled sample produces its preview or console output.
4. Use the Eleventy server for clean URLs. A basic static server does not rewrite `/playground` to `playground.html` and can produce a misleading 404.
5. Stop the server after browser validation.

Do not add source-inspection tests that pin website copy, template structure, generated HTML, CSS selectors, declarations, or visual layout. The production build and functional playground smoke test are the website acceptance boundary. If the defect is in functional playground/editor or shared compiler logic, reproduce it in a focused behavioral test before changing implementation code.

## Validate the Repository

Run every required gate in the final state:

```bash
pnpm test
pnpm cli vexa testFixtures/sample.vx
pnpm website:build
```

Do not commit, deploy, or report success unless all three commands pass. Recheck `git status --short` and inspect the final diff before committing.

## Deploy

1. Commit the intended changes in English. Include only reviewed files.
2. Record the commit with `git rev-parse HEAD`.
3. Run `pnpm website:deploy`; this executes `git push origin HEAD:web`.
4. Verify the remote branch matches the deployed commit:

```bash
git ls-remote --heads origin web
```

Report the commit, validation results, and remote verification. If the push is rejected, fetch and inspect the divergence; do not force-push.
