---
name: manage-vexascript-tasks
description: Create, update, complete, or close VexaScript task documents under docs/tasks and docs/tasks/completed, using the repository's task format and status conventions. Use when adding follow-up work, refining task scope, or moving finished tasks into completed.
---

# Manage VexaScript Tasks

Use this skill when working with task documents in `docs/tasks/` and `docs/tasks/completed/`.

## Task layout

* Active task documents live in `docs/tasks/`.
* Completed task documents live in `docs/tasks/completed/`.
* Keep all task content in English.

## Standard task shape

Follow the repository's existing task style:

* Title as an H1.
* `## Status` with checklist items such as `* [ ] Active` or `* [x] Completed`.
* Short sections with explicit headings such as:
  * `## Context`
  * `## Goal`
  * `## Scope`
  * `## Acceptance Criteria`
  * `## Tests`
  * `## Related Files`

Prefer concrete bullet lists over long prose.

## When creating a new task

* Put it in `docs/tasks/<slug>.md`.
* Use a short hyphen-case filename that matches the task topic.
* Capture the problem, the intended outcome, and the boundaries of the work.
* Write acceptance criteria that can be verified.
* Add test or validation steps whenever the task affects behavior.

## When updating an active task

* Keep the original goal intact unless the requirements truly changed.
* Tighten vague scope into explicit checklist items.
* Add newly discovered risks, blockers, or follow-up constraints directly to the task.
* Link related tasks when work splits into multiple tracks.

## When closing a completed task

* Move the document from `docs/tasks/` to `docs/tasks/completed/`.
* Update `## Status` to mark completion clearly.
* Remove stale wording that still describes the task as pending.
* Keep the task readable as historical context for future agents.

## Consistency rules

* Do not invent a new task format if an existing one already fits.
* Prefer updating an existing task when it already owns the work instead of creating duplicates.
* If a new task introduces a meaningful new repo surface, update `docs/file.structure.md` in the same change.
* Keep task docs concise but specific enough that another agent could execute them without guessing.
