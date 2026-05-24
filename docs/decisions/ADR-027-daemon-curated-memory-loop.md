# ADR-027: Daemon-curated reviewer-model memory loop

## Status

Proposed

## Context

Autopod's memory system has oscillated between two bad states. When agents were encouraged to suggest memories directly, the approval queue filled with trivia and noisy notes. After tightening the bar, useful durable memories stopped appearing and pods often received no actionable memory before starting.

The existing implementation has the storage and tools for `global`, `profile`, and `pod` memories, but it lacks four things:

- daemon-side judgment about which pod outcomes are worth turning into durable candidates;
- before-start selection of the few memories that fit the current task;
- required usage evidence showing whether selected memories were used;
- impact evidence showing whether memories reduce repeated validation, fix, escalation, quality, cost, or rework pain.

## Decision

Durable memory creation and selection are daemon-curated.

For future agent-driven pods only, a background recorder listens to outcome events, computes lesson potential, and calls the pod profile's reviewer model only when evidence crosses threshold. It records at most one durable profile candidate per pod outcome. Durable candidates remain pending until human approval. If a candidate overlaps an existing memory, the daemon proposes an update candidate; approval increments the existing memory version.

Before a pod starts, the daemon selects at most five relevant approved memories using deterministic prefiltering plus reviewer-model ranking. These are injected into system instructions as `Relevant Memory`, including content and the reviewer's reason the memory is relevant now. The old 100-entry `Available Memory` index is removed from the prompt. Non-selected memories remain reachable through memory tools.

Usage reporting is required at the MCP tool boundary: when selected/injected memories exist, `report_plan` must state intended use and `report_task_summary` must report `applied`, `not_applicable`, or `harmful_stale` with a reason. Missing/invalid tool payloads reject so the agent can retry. Pod lifecycle remains fail-soft; if the pod ends without final reporting, the daemon records `not_reported` evidence.

V1 uses evidence panels and analytics rather than automatic memory disabling. Stale/harmful reports are surfaced for human review, and humans can edit/delete manually.

## Consequences

**Easier**

- The approval queue becomes evidence-driven instead of agent-whim-driven.
- Relevant memories influence the first plan, not only mid-run tool searches.
- Memory usage becomes measurable through selected/injected/read/searched/plan/summary/not-reported events.
- Existing memory scopes remain compatible; pod-scoped ephemeral notes keep their lightweight behavior.

**Harder**

- The daemon now owns several new contracts: candidates, usage events, memory analytics, and reporting schemas.
- The best extraction/selection path depends on reviewer-model availability. Fail-soft fallback reasons must be visible so "memory was unavailable" does not look like "memory was irrelevant."
- Desktop memory UI becomes a real workbench instead of a simple list.

**Committed to**

- Human approval for durable memories remains mandatory.
- Daemon-generated durable candidates are profile-scoped in v1. Existing global memories remain supported, but the daemon does not auto-generate globals.
- No embeddings/vector DB in v1; use deterministic prefiltering plus reviewer-model ranking.
- No historical backfill; extraction starts with future pods.
- No auto-disable or deprecated state for stale memories in v1.

## Alternatives rejected

- **Agent-only `memory_suggest`.** This was the original noisy path. Agents can still create pod-scoped notes and can still suggest durable memories manually, but durable learning cannot depend on them noticing and self-filtering perfectly.
- **Vector DB / embeddings in v1.** Adds operational complexity before we have usage evidence proving the simpler selection loop is insufficient.
- **Auto-generate global memories.** Global scope has the highest blast radius. V1 keeps global creation manual/rare.
- **Auto-disable stale memories.** Staleness is judgment-heavy. V1 surfaces evidence and lets a human edit/delete.
- **Inject every approved memory as an index.** This produced broad prompt clutter without ensuring the right memories were used at the right time.

## References

- `specs/useful-memory-loop/`
- `packages/daemon/src/pods/memory-repository.ts`
- `packages/daemon/src/pods/system-instructions-generator.ts`
- `packages/daemon/src/pods/quality-score-recorder.ts`
- `packages/daemon/src/providers/llm-client.ts`
- `packages/escalation-mcp/src/server.ts`
