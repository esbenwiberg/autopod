# Container-Local Daemon LLM Helpers

## Problem
Several daemon-owned best-effort LLM helpers still call provider APIs directly
from the daemon. PR title/body generation and auto-commit messages are the most
visible examples: when the daemon-side API call is rate-limited or unavailable,
the pod timeline shows template fallback even though the pod/container runtime
often has an authenticated Claude or Codex path available. Existing validation
and some advisory/memory paths already prove that container-local reviewer
execution works; the missing piece is a shared helper path for the daemon's
best-effort helper work.

## Outcome
Daemon-owned best-effort LLM helper tasks prefer live pod or prompt-only
helper-container execution before daemon API, deterministic, or template
fallback.

## Users
Operators running local Docker profiles and hosted sandbox profiles benefit
from fewer daemon-side 429 failures and less fallback prose in PRs. Pod agents
benefit indirectly because daemon-generated metadata, memory ranking, advisory
review, and ask_ai-style helper calls use the same authenticated runtime surface
the pod already uses. Reviewers benefit because final fallback remains visible
without flooding the pod activity timeline with every intermediate helper-stage
miss.

## Success signal
Best-effort daemon helper calls use live pod or prompt-only helper-container
execution before daemon API fallback, helper token usage appears under a
first-class `helper` cost bucket, blocking validation review still behaves as
review, and pod activity appears only when the final user-visible output
degrades to deterministic/template fallback.

## Non-goals
- Do not move git push or PR creation authority into the pod.
- Do not remove daemon API fallback in v1.
- Do not mount or copy the repo workspace into v1 helper containers.
- Do not persist generated PR metadata or add new database columns for helper
  output.
- Do not rewrite blocking validation task-review, deep-review, or pre-submit
  architecture.
- Do not add a new UI surface. Existing activity and cost surfaces consume the
  new backend data.
- Do not make intermediate live-container or helper-container failures visible
  as pod activity.

## Glossary
- **Daemon LLM helper** - daemon-owned LLM work that generates supporting text
  or ranking, such as PR metadata, auto-commit messages, memory selection,
  advisory browser QA, and ask_ai-style responses.
- **Best-effort helper** - helper work that may fall back without failing the
  pod's main validation or merge path.
- **Live pod container** - the primary container already attached to a running
  pod.
- **Prompt-only helper container** - a short-lived container spawned after the
  main pod container is unavailable. It receives only daemon-computed prompt
  context, not a repo mount or workspace copy.
- **Container-local execution** - running Claude/Codex inside a live pod
  container or prompt-only helper container through the container manager.
- **Daemon API fallback** - the existing daemon-side provider SDK/CLI call used
  only after container-local stages are unavailable or fail.
- **Deterministic/template fallback** - non-LLM output such as heuristic commit
  messages, deterministic memory ranking, or template PR title/body content.
- **Final degradation** - the last fallback result the user actually receives.
  This is the only helper fallback stage that belongs in pod activity.

## Reversibility
The shared `helper` phase and cost bucket are a long-lived analytics contract.
If the feature is backed out, keep clients tolerant of stored
`phaseTokenUsage.helper` values, stop recording new helper usage, and route
helper call sites back to their prior daemon/direct fallback behavior. No DB
migration or persisted helper-output table is introduced in v1.
