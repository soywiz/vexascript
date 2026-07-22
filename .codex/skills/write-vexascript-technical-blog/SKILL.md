---
name: write-vexascript-technical-blog
description: Write or substantially revise evidence-based VexaScript engineering and milestone posts under website/src/blog. Use when an article must reconstruct repository history, explain compiler/runtime architecture, report benchmarks, turn journal evidence into durable technical prose, or replace superficial promotional copy with detailed subsections, real data tables, failed approaches, and explicit limitations.
---

# Write VexaScript Technical Blog

Produce a useful engineering article whose historical and quantitative claims can be traced to repository evidence. Treat the blog as technical documentation for an informed reader, not as release marketing.

## Establish the evidence base

Before drafting, identify the milestone or technical question and collect primary repository sources:

1. Inspect the relevant `docs/journal/` entries for chronology, measurements, hypotheses, failed paths, and remaining limitations.
2. Use Git author dates, commit identities, and diff statistics for exact historical claims. Do not infer a milestone date from a journal filename alone.
3. Inspect current implementation and tests before describing present support. A historical journal can describe an intermediate boundary that no longer applies.
4. Use task documents when they clarify acceptance criteria or work intentionally left for later.
5. Separate measurements from different compiler generations, optimization flags, machines, or workloads. Label them as separate checkpoints rather than placing them in a misleading comparison.

Never invent a metric to fill a table. If exact data is unavailable, state the qualitative result and the missing measurement plainly.

## Define a technical thesis

Choose one question the article answers, such as why an incremental rebuild still reloads the page, how one FFI declaration lowers to two runtimes, or why Oilpan and mimalloc are complementary. Use the milestone as context, not as the entire thesis.

Write for a reader who wants to understand or reproduce the engineering decision. Explain mechanisms, boundaries, and tradeoffs at the level needed to distinguish the chosen design from plausible alternatives.

## Structure the article

Keep the existing Eleventy frontmatter contract:

```yaml
---
layout: blog-post.njk
title: A factual, specific title
date: YYYY-MM-DD
category: Relevant category
summary: One concrete sentence describing the article
tags: blog
permalink: /blog/stable-slug.html
---
```

Then use this editorial shape:

1. Open with the date, exact milestone, and scope. Include the relevant commit when known.
2. Add three to six descriptive level-two subsections formatted as `## **Subsection title**`.
3. Include at least one Markdown table containing real measurements, mappings, timelines, or design comparisons.
4. Include short source or command examples when they materially clarify the mechanism.
5. Explain at least one rejected approach, failure, or constraint when the evidence contains one.
6. State limitations and distinguish what the result establishes from what it does not establish.
7. End on a concrete architectural or operational lesson, not a promotional slogan.

Prefer paragraphs for causal explanation and tables for exact repeated-field comparisons. Do not pad an article to satisfy length; add useful evidence, mechanisms, and caveats.

## Write from evidence, not milestone rhetoric

Avoid generic claims such as “a major leap,” “game-changing,” “seamless,” or “blazing fast.” Replace them with the mechanism and its measured consequence.

Apply these rules:

- Distinguish measured facts, source-derived facts, and engineering inference.
- Use exact units, flags, runtime versions, and workload descriptions when available.
- Explain why benchmark rows are comparable before calculating a percentage.
- Keep code identifiers and commands in backticks.
- Use past tense for historical work and present tense only for behavior confirmed in current code.
- Name unsafe or incomplete boundaries rather than implying universal support.
- Describe failed investigations and the evidence that ruled them out; this is often the most reusable part of the article.
- Explain how journal notes enabled the reconstruction when the article draws on them: journals retain the sequence and dead ends, Git supplies exact history, and code/tests confirm current behavior.

## Validate content and rendering

Use test-driven content checks when adding a series or enforcing a house style. Update or add a focused test before the posts, then make it pass. For milestone articles, validate the expected title/permalink, bold subsection structure, real table presence, and a substantive-content floor without testing exact prose.

Before handing off:

1. Run the focused website content test.
2. Run `pnpm website:build`.
3. Serve the website and inspect the blog index plus changed posts in a real browser at desktop and mobile widths. Check navigation, tables, code blocks, overflow, and console errors.
4. Run the repository-required full `pnpm test` suite.
5. Run `pnpm cli vexa testFixtures/sample.vx`.
6. If publication was requested, follow the `deploy-vexascript-website` skill after committing and pushing the source branch.

Keep `docs/file.structure.md` current when this workflow or the blog architecture changes. Add a journal entry if the writing or deployment work reveals a recurring evidence, rendering, or release-process failure.
