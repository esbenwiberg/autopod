# Useful Memory Loop

## Problem

Autopod memory has failed in both directions: early pods generated noisy, low-value suggestions that made the approval queue easy to ignore, and the current behavior often generates or uses no memory at all. The system stores notes, but it does not reliably decide which lessons are worth preserving, inject the right memories at pod start, require agents to account for memory use, or show whether approved memories reduce repeated pain.

## Outcome

Future agent-driven pods receive a top-5 relevant memory briefing before they plan, high-evidence pod outcomes create at most one human-reviewable profile memory candidate, and the Memory workbench plus Analytics card show whether selected memories are being used and reducing repeated validation/fix/escalation pain.

## Users

- **Operator / human reviewer** - reviews candidate memories, edits or rejects weak ones, and watches whether the memory system is helping.
- **Future agent-driven pods** - benefit from relevant approved memories before the first plan, without being flooded by unrelated notes.
- **Daemon** - curates candidates, selects relevant memories, records usage, and computes impact evidence.

## Success signal

For same-profile future agent-driven pods, approved memories that are selected or injected have visible usage evidence (`selected`, `injected`, `read`, `searched`, `plan_reported`, `summary_reported`, `not_reported`) and the Memory analytics surface can compare those pods against repeated-pain proxies: validation failures, PR fix attempts, escalations, quality scores, excess cost, and rework.

## Non-goals

- No vector DB, embeddings, or semantic-search backend in v1.
- No historical backfill. Extraction starts with future pods only.
- No automatic global memory generation. Existing/manual/agent global memories remain supported as a rare escape hatch.
- No auto-disable, inactive/deprecated lifecycle, or pending deactivation candidate for stale/harmful memories in v1.
- No durable auto-approval. Human approval remains required for durable profile/global memories.
- No change to ephemeral pod memory behavior beyond allowing it to be included for downstream series pods when already available.
- No extraction/selection/reporting requirement for interactive workspace, history, or memory-workspace pods.
- No duplicate review/editor controls inside Analytics. Analytics gets a lightweight fleet signal; the Memory workbench owns detailed action and evidence.

## Glossary

- **Durable memory** - an approved `global` or `profile` memory entry that may affect future pods. Content remains markdown, with structured metadata for kind, tags, applies/avoid conditions, confidence, evidence, and impact.
- **Ephemeral pod memory** - a `pod`-scoped memory note. It remains auto-approved, lightweight, scoped to the pod/series, and outside the human durable-memory approval queue.
- **Daemon-curated candidate** - a pending durable memory proposed by the daemon after analyzing pod outcome evidence. In v1 these are profile-scoped only.
- **Update candidate** - a pending proposal to revise an existing memory instead of creating a near-duplicate. Approval increments the target memory version.
- **Lesson potential** - deterministic score deciding whether a pod outcome is worth sending to the reviewer model for candidate extraction.
- **Relevant memory briefing** - the top-5 selected memory section injected into pod system instructions before start, with content and reviewer rationale.
- **Usage evidence** - persisted records that a memory was selected, injected, read, searched, planned for, applied, deemed not applicable, marked stale/harmful, or not reported.
- **Repeated pain** - later pods suffering the same measurable friction: validation failures, PR fix attempts, escalations, low quality, excess cost, or rework.
- **Source evidence** - sanitized snippets and structured signals explaining why a candidate or stale warning exists.

## Reversibility

This feature adds DB tables/columns, shared API types, MCP schemas, and desktop client mirrors. Back-out is additive: stop wiring the recorder/selector/reporting paths, keep legacy memory CRUD/search functioning, and ignore the new tables/columns. Do not delete migration data in a rollback; leave candidate/usage/evidence rows dormant so already-approved legacy memories still load.
