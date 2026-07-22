---
layout: blog-post.njk
title: Engineering journals and repository-local skills
date: 2026-06-21
category: Engineering process
summary: How VexaScript turns debugging evidence into versioned OpenAI Codex skills, actionable tasks, and regression checks.
tags: blog
permalink: /blog/engineering-journals-and-skills.html
---

VexaScript added its engineering-journal convention on June 20, 2026, in commit `cf5b329b`. The initial change covered five files with 140 insertions and 9 deletions. The repository later began encoding repeated workflows as OpenAI Codex skills: actual versioned `SKILL.md` packages under `.codex/skills`, not a vague instruction to “use AI carefully.”

At the time of this article, the repository contains 46 journal entries, 17 active task documents, 14 completed task documents, and eight repo-local skills. Those numbers are a snapshot, not a productivity score. Their value is in the transitions between them: an investigation preserves evidence, recurring evidence becomes a scoped task or workflow, and the resulting implementation is protected by tests.

## **A journal records the causal path**

Release notes answer “what changed?” A useful engineering journal answers “why did the observed symptom come from this boundary, and what evidence ruled out the alternatives?” Compiler failures frequently cross several layers before becoming visible. A slow Pixi reload may originate in repeated declaration analysis; a native C++ error may have been introduced one self-hosting generation earlier; a Monaco diagnostic may depend on virtual filesystem and LSP session state rather than the parser alone.

VexaScript journal entries therefore preserve:

| Evidence | Why it is retained |
|---|---|
| Original command and symptom | Gives the next investigation a reproducible starting point |
| Phase timings, stack traces, or generated output | Locates the failure at a concrete boundary |
| Hypotheses attempted | Prevents an attractive dead end from being repeated |
| Evidence that rejected each hypothesis | Separates a failed experiment from an unexplored idea |
| Root cause and architectural constraint | Makes the lesson usable outside the exact reproducer |
| Minimal regression test | Converts the lesson into an executable invariant |
| Remaining follow-up work | Avoids presenting a partial fix as a finished architecture |

The failed paths matter. If direct unaligned pointer casts were considered for `DataView`, the journal should preserve why alignment and aliasing made that unsafe, and why fixed-size `memcpy` still optimizes to register loads. Recording only the final implementation would force the next contributor to repeat that reasoning.

## **What an OpenAI Codex skill is in this repository**

A Codex skill is a directory whose `SKILL.md` contains YAML frontmatter and operational instructions. Its `name` and `description` determine when the skill applies. Optional `agents/openai.yaml` metadata supplies the user-facing display name, short description, and an invocation prompt. Skills can also carry scripts, references, and reusable assets when the workflow needs them.

The distinction from a generic prompt is concrete:

| Property | One-off chat instruction | Repo-local Codex skill |
|---|---|---|
| Location | Conversation context | `.codex/skills/<name>/SKILL.md` |
| Versioning | Usually ephemeral | Reviewed and committed beside the code |
| Triggering | User must restate it | Description identifies matching work |
| Project knowledge | Reconstructed each time | Encodes paths, commands, and invariants |
| Validation | Informal | Can require scripts, tests, builds, and artifacts |
| Evolution | Lost after the task | Updated when forward use exposes a gap |

This makes a skill closer to an executable runbook than to a persona. It does not replace engineering judgment. It tells Codex which evidence to gather, which repository contracts must survive, which validation is mandatory, and how to leave the result in a form another contributor can inspect.

## **The current skills encode distinct failure modes**

The repository does not use one enormous “work on VexaScript” skill. Each package has a narrow trigger and a durable output.

| Skill | Trigger | Procedure and invariant |
|---|---|---|
| `break-vexascript-with-samples` | Stress a compiler or LSP feature with realistic code | Reduce failures to minimal automated tests; do not hide bugs by weakening samples |
| `create-vexascript-samples` | Add or update runnable samples | Follow browser/Node sample structure, expected output, and architecture documentation |
| `deploy-vexascript-website` | Publish or troubleshoot the site | Verify branch ancestry, build, exercise a real browser, run the full suite, and deploy without force |
| `destructive-negative-net-refactor` | Simplify duplicated compiler architecture | Delete retired paths and converge on external compiler behavior instead of adding compatibility layers |
| `ingest-vexascript-journal` | Mine accumulated journal entries | Turn recurring lessons into actionable task documents, then move processed notes rather than deleting history |
| `manage-vexascript-tasks` | Create or close task documents | Preserve task format and move genuinely completed work to the completed area |
| `vexascript-lsp-infra-debugging` | Diagnose editor/LSP behavior | Reproduce the full workspace/session path instead of testing an isolated parser and declaring success |
| `write-vexascript-technical-blog` | Write milestone or engineering articles | Derive claims from commits, journals, code, and measurements; include caveats and validate the rendered site |

The subtractive-refactor skill is a useful example of provenance. Repeated cleanups had introduced a “shared” abstraction but left the old branches active. Net code grew and the same behavior still had multiple places to drift. The journal captured that pattern; the skill now asks future work to identify the external contract, remove superseded implementations, and treat additive compatibility scaffolding as a warning.

## **Journals, tasks, and skills form a pipeline**

The artifacts have different lifetimes and should not be collapsed into one folder:

```text
observed failure
    -> journal: evidence, dead ends, root cause
    -> ingestion: recurring lesson and bounded follow-up
    -> active task: acceptance criteria and remaining work
    -> implementation: tests, code, documentation
    -> completed task: durable record of delivered scope
    -> skill update: repeatable method for the next occurrence
```

The `ingest-vexascript-journal` skill performs the middle step deliberately. It does not turn every note into bureaucracy. It looks for repeated architectural risks or missing regression coverage, creates actionable task documents, and moves fully processed journal entries to `docs/journal/processed/`. The source evidence remains available, while the active journal directory continues to mean “not yet fully mined.”

The first task-management skill work landed on June 19 in commit `52d7bc24`, covering eight files with 373 insertions and 5 deletions. The journal convention followed a day later. Their dates show that the process grew from actual repository maintenance rather than being imposed as a documentation taxonomy after the fact.

## **Validation is part of the workflow, not a closing sentence**

Skills are useful only if their instructions change outcomes. VexaScript's repository policy requires a focused test while developing, the complete `pnpm test` suite before handoff, and `pnpm cli vexa testFixtures/sample.vx` as a compiler smoke test. Website changes additionally require a production build and a real-browser check. Syntax work updates `docs/syntax.md`; new architectural modules update `docs/file.structure.md`.

Those requirements are intentionally stored where Codex reads them during the task. A blog-writing skill, for example, requires exact commit dates and statistics from Git, real tables rather than invented metrics, explicit separation of incomparable benchmark checkpoints, and browser validation of rendered Markdown. The resulting prose can be reviewed against primary repository evidence.

## **The journal is also the source material for detailed articles**

Writing the journal while the work is happening makes later technical communication substantially more accurate. Git preserves the final diff and commit date, but it rarely explains why an apparently reasonable implementation was abandoned, which measurement changed the direction of the work, or whether two benchmark numbers came from comparable compiler generations. A chat transcript may contain those facts, but it is not a durable, searchable part of the repository.

The milestone articles on this site were reconstructed from journal entries together with Git and current code. The journal supplied the sequence and the negative evidence; Git supplied exact dates, commit identities, and change statistics; tests and source confirmed what remains true today.

| Article evidence | Best source | Example preserved detail |
|---|---|---|
| Chronology and investigation branches | `docs/journal/` entry written during the work | why source/include-only mimalloc packaging failed before the CMake files were restored |
| Exact historical boundary | Git commit and author date | which commit first produced the native backend or self-hosted successfully |
| Quantitative claim | recorded benchmark command and environment | 4.08 s versus 3.28 s using the same `-O1` object |
| Current behavior | implementation and automated tests | which FFI result and parameter types are actually supported now |
| Remaining limitation | journal follow-up and current task | why Pixi uses a full browser reload despite incremental compilation |

Without the journal, a retrospective post tends to collapse into a shallow list of features or a polished success story. With it, the article can explain the failed paths, constraints, and intermediate measurements that make the final design useful to another engineer. This is a practical secondary return on journaling: the work produces its own high-quality source material for future documentation and blog posts.

## **The objective is cheaper recurrence**

Journaling is not valuable because the repository contains many Markdown files, and a skill is not valuable because it mentions automation. The test is whether the second occurrence of a problem starts further ahead than the first.

When a Linux GCC internal compiler error appeared in generated coroutine syntax, the useful record included the compiler version, the isolated generated method, why the source was valid, and why Clang was selected only for syntax validation while GCC remained covered by focused runtime tests. The next toolchain failure can begin from those distinctions instead of rediscovering them.

That is the operating principle: preserve causal evidence, extract reusable procedure, keep it versioned with the system it governs, and make every claimed fix executable through tests or reproducible measurements.
