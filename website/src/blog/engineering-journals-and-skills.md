---
layout: blog-post.njk
title: Engineering journals and repository-local skills
date: 2026-06-21
category: Engineering process
summary: VexaScript keeps failed investigations, regression patterns, and repeatable workflows beside the code so future work starts with accumulated evidence.
tags: blog
permalink: /blog/engineering-journals-and-skills.html
---

VexaScript began keeping an engineering journal on June 20 and turned its first recurring lessons into repository-local agent skills over the following days.

The journal is intentionally different from release notes. Entries preserve the original symptom, the evidence that identified the real boundary, the approaches that looked plausible but failed, and the regression test that now protects the result. This matters in compiler work because the visible failure is often far from its cause: a Pixi delay can be repeated declaration analysis, an LSP error can be lost symbol origin, and a native crash can begin with a dynamic callback whose return type disappeared one generation earlier.

When a journal pattern becomes repeatable work, it can become a task or a skill. The repository now carries focused workflows for creating and breaking samples, managing task documents, ingesting journal lessons, performing subtractive refactors, debugging full LSP infrastructure, and deploying the website safely. The destructive-refactor skill, for example, came from repeatedly seeing a “unification” add a new abstraction while leaving every old branch alive; it explicitly asks future cleanup to delete retired paths and protect external compiler behavior rather than internal scaffolding.

These files are versioned with the implementation, so the process evolves under review and travels with every checkout. They also give automated contributors the same project-specific constraints as human maintainers: asynchronous I/O, browser-compatible compiler modules, full-suite validation, real sample coverage, and guarded deployment.

The practical goal is cumulative engineering. A difficult investigation should make the next related problem cheaper, not merely disappear into a chat transcript or a commit title.
