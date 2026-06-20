---
name: ingest-vexascript-journal
description: Review VexaScript engineering journal notes under docs/journal/, convert recurring problems and architectural lessons into actionable task documents under docs/tasks/, and then move fully processed journal entries into docs/journal/processed/. Use when mining journal history for follow-up architecture work, regression-prevention work, cleanup tasks, or infrastructure improvements.
---

# Ingest VexaScript Journal

Use this skill when turning engineering journal notes into concrete follow-up work.

## Goal

Convert journal knowledge into explicit, trackable tasks that improve the
compiler, runtime, LSP, tooling, or workflow architecture.

## Inputs and outputs

- Unprocessed journal notes live in `docs/journal/`.
- Processed journal notes live in `docs/journal/processed/`.
- New follow-up work should be written to `docs/tasks/`.
- If a task is immediately completed as part of the same change, move it to
  `docs/tasks/completed/`.

## What to extract from a journal note

Look for information that can become durable engineering work:

- recurring bug patterns
- brittle infrastructure or layering problems
- missing regression coverage
- repeated dead ends that suggest confusing architecture
- cleanup opportunities where one area repeatedly needs special handling
- places where a broad sample exposed a missing smaller test or missing helper

Prefer tasks that improve the system for future work, not just one past bug.

## Required reading shape

When processing a journal entry, capture all of these:

- what ultimately worked
- what failed repeatedly
- which investigation branches were explored without success
- why those failed branches looked plausible at the time
- what architectural improvement would make those branches less likely in the
  future

Do not ignore the failed investigation paths. They often point directly to the
next cleanup or unification task.

## Task creation workflow

1. Read one or more unprocessed journal entries in `docs/journal/`.
2. Check whether the same follow-up already exists in `docs/tasks/` or
   `docs/tasks/completed/`.
3. If the work is already tracked, update that task instead of duplicating it.
4. If the work is new, create a concise task document in `docs/tasks/`.
5. Make the task actionable:
   - clear problem statement
   - explicit scope boundaries
   - acceptance criteria
   - test or validation expectations
6. Only move the journal note into `docs/journal/processed/` after its
   actionable follow-up has been created, linked, or explicitly deemed already
   covered.

## When a journal note should stay unprocessed

Leave a journal note in `docs/journal/` if:

- its follow-up is still unclear
- it needs more than one task and you have not split them yet
- you suspect duplication but have not verified it
- the note still contains live debugging context needed by ongoing work

## Processed-note expectations

Before moving a note to `docs/journal/processed/`, make sure:

- the relevant task documents exist or were updated
- the note still reads clearly as historical context
- the note mentions the resulting task(s) when helpful

## Consistency rules

- Keep everything in English.
- Do not delete journal notes after processing; move them to
  `docs/journal/processed/`.
- Do not create vague meta-tasks like "improve architecture" without concrete
  acceptance criteria.
- Prefer a few high-signal tasks over many speculative ones.
- If this introduces or formalizes a new repository workflow, update
  `docs/file.structure.md` and the relevant docs in the same change.
