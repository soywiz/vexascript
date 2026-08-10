# Static banner assets require explicit Eleventy passthroughs

## Problem

The website source contained `website/src/assets/banner.jpg`, and the layout
already referenced the public `/banner.jpg` URL for social previews, but
`pnpm website` did not serve the image.

## Investigation

The source file was present and a direct request initially failed because the
development server was not running. Inspecting the generated site then showed
that Eleventy copied the generated bundle, stylesheets, and favicons only; it
did not copy arbitrary files from `src/assets`. The issue was therefore not
the JPEG bytes, URL casing, or the development server's clean-URL behavior.

## Resolution

Move root-level published files into `website/src/public` and register that
directory with one `config.addPassthroughCopy` mapping in
`website/eleventy.config.mjs`. The production build now creates
`website/_site/banner.jpg`, and the local server returns `200 OK` with
`Content-Type: image/jpeg`. Browser validation rendered the 1200x630 image
successfully.

## Regression risk

Root-level static files under `website/src/assets` are not automatically
published by the current Eleventy configuration. New files intended for a
public URL belong in `website/src/public`; generated bundles and website
source modules remain under `website/src/assets`.
