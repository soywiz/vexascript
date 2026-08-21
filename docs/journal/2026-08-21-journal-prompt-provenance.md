# Journal prompt provenance

## Context

Journal entries preserve technical conclusions, failed investigation paths, and
regression lessons, but they did not previously preserve the user prompts that
defined why an entry was created or what it was expected to capture. That made
it harder to distinguish the original request from conclusions developed during
the work.

## Decision

`AGENTS.md` now requires every new journal entry to include an
`Execution metadata` section identifying the AI model and provider used for the
task, plus a `Prompts` section. The latter records, verbatim and in chronological
order, the user prompts that explicitly requested the journal work or materially
defined its contents. The rule begins with the prompt that introduced the
requirement, so its provenance is not lost while establishing the policy.

The model and provider must be obtained automatically from the execution context
or runtime metadata. Journal work must never require the user to identify the
model. When the runtime does not expose an exact identifier, the entry must say
that the metadata is unavailable instead of guessing or asking the user.

Prompts should be treated as historical source material. Their original
language and wording must be preserved without translation. The surrounding
journal prose remains in English under the repository's language policy.

## Investigation notes

No technical dead ends occurred. The only ambiguity was whether the introducing
prompt should merely be covered by future policy or recorded immediately. The
explicit phrase "including this same prompt" resolved that ambiguity in favor
of recording it in this first entry.

The initial investigation checked the process environment and the Codex task
metadata APIs. They exposed the current thread identifier and task state, but
not a dedicated active-model field. Asking the user for the missing identifier
would make provenance incomplete unless the user already knew internal runtime
configuration, so the durable policy now forbids that dependency. Agents must
use execution metadata when available and record an unavailable value when it
is not, without interrupting the task.

## Execution metadata

- Model: GPT-5.6 Sol
- Provider: OpenAI

## Prompts

1. `añade desde este mismo momento una cláusula donde indicas el/los prompts que se especificaron como part del journal incluyendo este mismo prompt`
2. `y crea entrada en el journal`
3. `y indica también el modelo y proveedor usado para realizar la tarea`
4. `estás bajo OpenAI GPT 5.6 Sol. No puedes obtener ese 5.6 Sol?`
5. `bueno, pero no quiero que el usuario tenga que proporcionarlo`
6. `también quiero que las instrucciones, aunque se den en español, que las traduzcas al inglés`
7.

   ````text
   borra ```This requirement starts with, and explicitly includes, the prompt that introduced it: `añade desde este mismo momento una cláusula donde indicas el/los prompts que se especificaron como part del journal incluyendo este mismo prompt`.``` del agents
   ````
8. `de momento mejor no traduzcamos los prompts`
