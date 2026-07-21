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
3. Use a real browser against `http://127.0.0.1:7070/`. Validate at minimum:
   - the home page and primary navigation;
   - `/playground` initialization without console errors;
   - Monaco editor, workspace files, runtime declarations, and workers loading successfully;
   - switching workspace files and using Back/Forward;
   - clearing and running the sample, with the canvas and console output returning;
   - the narrow viewport workspace drawer and the desktop workbench layout;
   - no failed browser requests for pages, bundles, workers, declarations, fonts, or preview blobs.
4. Use the Eleventy server for clean URLs. A basic static server does not rewrite `/playground` to `playground.html` and can produce a misleading 404.
5. Stop the server after browser validation.

If a defect appears, reproduce it in a focused automated test before changing implementation code. Fix it, rerun the focused test, and repeat the browser flow.

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
