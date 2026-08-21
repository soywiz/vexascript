# Journal prompt provenance

## Context

Journal entries preserve technical conclusions, failed investigation paths, and
regression lessons, but they did not previously preserve the user prompts that
defined why an entry was created or what it was expected to capture. That made
it harder to distinguish the original request from conclusions developed during
the work.

## Decision

`AGENTS.md` now requires every new journal entry to include a `Prompts` section.
That section records, verbatim and in chronological order, the user prompts that
explicitly requested the journal work or materially defined its contents. The
rule begins with the prompt that introduced the requirement, so its provenance
is not lost while establishing the policy.

Prompts should be treated as historical source material. Their original
language and wording must be preserved even when the surrounding journal entry
is written in English.

## Investigation notes

No technical dead ends occurred. The only ambiguity was whether the introducing
prompt should merely be covered by future policy or recorded immediately. The
explicit phrase "including this same prompt" resolved that ambiguity in favor
of recording it in this first entry.

## Prompts

1. `añade desde este mismo momento una cláusula donde indicas el/los prompts que se especificaron como part del journal incluyendo este mismo prompt`
2. `y crea entrada en el journal`
