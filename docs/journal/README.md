# Engineering Journal

This directory stores short notes about bugs, regressions, and engineering
lessons discovered while completing tasks.

Unprocessed notes stay here until they are reviewed and turned into explicit
follow-up work. After ingestion, move them to `docs/journal/processed/`.

Use it to capture information that should outlive a single task, especially:

- recurring regression patterns
- infrastructure weaknesses
- places where samples exposed a deeper compiler, runtime, or LSP bug
- debugging workflows that were particularly effective or ineffective
- sources of legacy behavior that should eventually be simplified or removed

Each entry should document both:

- the path that ultimately worked
- meaningful lines of investigation that did not work, including why they were
  attempted and what evidence ruled them out

The goal is to make repeated failures visible so the project can improve its
infrastructure, reduce legacy, and prevent future regressions.
