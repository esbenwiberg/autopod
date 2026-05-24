# Design - Useful Memory Loop

## Blast radius

### Shared contracts

- `packages/shared/src/types/memory.ts` - extend memory entries and add candidate, evidence, selection, and usage types.
- `packages/shared/src/types/task-summary.ts` - add memory usage reporting to task summaries.
- `packages/shared/src/types/events.ts` - add candidate-created/updated events.
- `packages/shared/src/types/analytics.ts` - add memory analytics response.
- `packages/shared/src/index.ts` - re-export new contracts.
- `packages/shared/src/constants.ts` - retire the old 100-entry memory index usage.

### Daemon storage and orchestration

- `packages/daemon/src/db/migrations/105_memory_learning.sql` - add metadata, candidates, usage events, and indexes. Executors must check the highest migration prefix before creating this file.
- `packages/daemon/src/pods/memory-repository.ts` - preserve CRUD/search and map extended fields.
- `packages/daemon/src/pods/memory-candidate-repository.ts` - new candidate CRUD and approval/rejection flow.
- `packages/daemon/src/pods/memory-usage-repository.ts` - new usage event recorder/query API.
- `packages/daemon/src/pods/memory-candidate-recorder.ts` - background extraction listener.
- `packages/daemon/src/pods/memory-extraction.ts` - lesson potential, reviewer prompt, JSON parsing, sanitization.
- `packages/daemon/src/pods/memory-selector.ts` - deterministic prefilter + reviewer-model ranking.
- `packages/daemon/src/pods/system-instructions-generator.ts` - replace `Available Memory` with `Relevant Memory`.
- `packages/daemon/src/pods/pod-manager.ts` - selection seam before system instructions; not-reported finalization; recorder wiring.
- `packages/daemon/src/api/routes/memory.ts` - candidate/evidence/usage endpoints.
- `packages/daemon/src/api/routes/pods.ts` - `GET /pods/analytics/memory`.
- `packages/daemon/src/api/server.ts` and `packages/daemon/src/index.ts` - dependency wiring.

### Escalation MCP

- `packages/escalation-mcp/src/server.ts` - extend `report_plan` and `report_task_summary` schemas.
- `packages/escalation-mcp/src/tools/report-plan.ts` - forward intended memory use.
- `packages/escalation-mcp/src/tools/report-task-summary.ts` - forward final memory outcomes.
- `packages/escalation-mcp/src/pod-bridge.ts` - bridge contract additions.

### Desktop

- `packages/desktop/Sources/AutopodClient/Types/Memory.swift` - extend mirrors while preserving legacy decode.
- `packages/desktop/Sources/AutopodClient/Types/MemoryAnalyticsResponse.swift` - new analytics mirror.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` - candidate/evidence/analytics calls.
- `packages/desktop/Sources/AutopodClient/Types/EventTypes.swift` - candidate events.
- `packages/desktop/Sources/AutopodDesktop/Stores/MemoryStore.swift` - candidate, evidence, usage, analytics state.
- `packages/desktop/Sources/AutopodUI/Views/Memory/MemoryManagementView.swift` - two-pane workbench.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift` - add `.memory`.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` - card.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` - drill routing.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/MemoryAnalyticsDrillView.swift` - new drill.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` - closure/state wiring.

## Seams

1. **Contracts and schema -> repositories**. Brief 01 owns shared TS contracts and DB shape. Brief 02 consumes them to implement repositories.
2. **Repositories -> daemon extraction**. Brief 03 consumes candidate repositories and outcome metrics to record pending profile candidates.
3. **Repositories -> selection/injection**. Brief 04 consumes memory entries and usage repository to select and inject relevant memory before the pod starts.
4. **Selection -> MCP reporting**. Brief 05 consumes selected/injected memory IDs and extends the plan/summary tool contract.
5. **Usage/candidates -> APIs/analytics**. Brief 06 exposes candidate, evidence, usage, and analytics responses.
6. **API contracts -> desktop store**. Brief 07 mirrors daemon contracts in Swift and wires store/client state.
7. **Desktop store -> workbench/card**. Brief 08 consumes store state and implements the approved UI.

Run order is strictly sequential. Parallelizing the desktop and daemon work would collide on shared contracts and produce misleading UI against missing APIs.

## Contracts

### Durable memory metadata

```ts
export type MemoryKind =
  | 'convention'
  | 'gotcha'
  | 'workflow'
  | 'dependency'
  | 'review_feedback'
  | 'other';

export interface MemorySourceEvidence {
  podId: string;
  signal: string;
  excerpt: string;
  severity?: 'low' | 'medium' | 'high';
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  scope: 'global' | 'profile' | 'pod';
  scopeId: string | null;
  path: string;
  content: string;
  contentSha256: string;
  rationale?: string | null;
  kind?: MemoryKind | null;
  tags?: string[];
  appliesWhen?: string | null;
  avoidWhen?: string | null;
  confidence?: number | null;
  sourceEvidence?: MemorySourceEvidence[];
  impactSummary?: string | null;
  version: number;
  approved: boolean;
  createdByPodId?: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### Candidate contract

```ts
export type MemoryCandidateStatus = 'pending' | 'approved' | 'rejected';
export type MemoryCandidateAction = 'create' | 'update';

export interface MemoryCandidate {
  id: string;
  action: MemoryCandidateAction;
  targetMemoryId?: string | null;
  scope: 'profile';
  scopeId: string;
  path: string;
  content: string;
  rationale: string;
  kind: MemoryKind;
  tags: string[];
  appliesWhen: string | null;
  avoidWhen: string | null;
  confidence: number;
  sourceEvidence: MemorySourceEvidence[];
  impactSummary: string;
  status: MemoryCandidateStatus;
  createdByPodId: string;
  fallbackReason?: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### Usage contract

```ts
export type MemoryUsageKind =
  | 'selected'
  | 'injected'
  | 'read'
  | 'searched'
  | 'plan_reported'
  | 'summary_reported'
  | 'not_reported';

export type MemoryUsageOutcome = 'intended' | 'applied' | 'not_applicable' | 'harmful_stale';

export interface MemoryUsageEvent {
  id: string;
  memoryId: string;
  podId: string;
  kind: MemoryUsageKind;
  outcome?: MemoryUsageOutcome | null;
  reason?: string | null;
  relevanceReason?: string | null;
  createdAt: string;
}
```

### MCP reporting

`report_plan` adds:

```ts
memoryUse?: Array<{
  memoryId: string;
  intendedUse: string;
}>;
```

`report_task_summary` adds:

```ts
memoryOutcomes?: Array<{
  memoryId: string;
  outcome: 'applied' | 'not_applicable' | 'harmful_stale';
  reason: string;
}>;
```

When selected/injected memories exist, both fields are required and validated against that pod's selected memory IDs. The tool call rejects missing/invalid fields so the agent can retry. Pod lifecycle does not fail solely for missing reporting; terminal pods without final usage get `not_reported` rows.

### Memory analytics

```ts
export interface MemoryAnalyticsResponse {
  days: number;
  summary: {
    selectedCount: number;
    injectedCount: number;
    readCount: number;
    searchedCount: number;
    appliedCount: number;
    notApplicableCount: number;
    harmfulStaleCount: number;
    notReportedCount: number;
    candidateCount: number;
    approvedCandidateCount: number;
  };
  impact: {
    cohortSize: number;
    comparisonCohortSize: number;
    qualityDelta: number | null;
    validationFailureDelta: number | null;
    fixAttemptDelta: number | null;
    escalationDelta: number | null;
    costDeltaUsd: number | null;
  };
  topMemories: Array<{
    memoryId: string;
    path: string;
    selectedCount: number;
    injectedCount: number;
    appliedCount: number;
    harmfulStaleCount: number;
    impactSummary?: string | null;
  }>;
}
```

## UX flows

### Memory workbench

Entrypoint: sidebar `Memory`.

States:

- Loading: existing memory loading state can remain minimal.
- Empty: show no memories/candidates plus manual create and Analyze & Fix.
- Candidate selected: detail pane shows proposed create/update, source evidence, confidence, and Approve/Edit/Reject.
- Active memory selected: detail pane shows metadata, content, usage history, impact, and stale/harmful evidence. Humans edit/delete manually.
- Error: show store/API error inline and keep existing loaded rows visible when possible.

Approved wireframe:

```text
+------------------------------------------------------------------------------+
| Memory                                      [Global] [Profile] [Pod] Search  |
+----------------------------------------------+-------------------------------+
| Pending candidates                           | Selected memory / candidate   |
| +------------------------------------------+ | +---------------------------+ |
| | /gotchas/migrations.md        84 daemon  | | | Title/path                 | |
| | source: pod abc123 low quality retry     | | | kind tags confidence        | |
| | would save: future migration pod...      | | | rationale                   | |
| | [Approve] [Edit] [Reject]                | | | content editor/preview      | |
| +------------------------------------------+ | | source pods + signals       | |
|                                              | | [Approve] [Save edit] ...   | |
| Active memories                              | +---------------------------+ |
| +------------------------------------------+ |                               |
| | /conventions/commits.md active           | | Impact                        |
| | last injected: 2 pods ago                | | selected 12 injected 9 read 6 |
| +------------------------------------------+ | applied 3 quality +12 fixes -2|
|                                              | Recent usage                  |
| Analyze & Fix memory workspace              | pod list with outcomes         |
| [Profile picker] [Open Memory Workspace]    |                               |
+----------------------------------------------+-------------------------------+
```

### Analytics Memory card

Entrypoint: sidebar `Analytics`, card grid.

The card headline should summarize memory-loop health, such as applied/not-reported ratio or selected/injected count. Its drill shows fleet-level memory usage counts, candidate approval totals, repeated-pain deltas, and top memories. It must not duplicate candidate approval/edit controls; clicking a memory can navigate the operator to the Memory screen only if existing navigation makes that cheap.

## Reference reading

- `AGENTS.md` - migration numbering, package map, testing commands, and pod lifecycle.
- `packages/shared/src/types/memory.ts` - current minimal memory entry shape.
- `packages/daemon/src/pods/memory-repository.ts` - existing CRUD/search behavior to preserve.
- `packages/daemon/src/api/routes/memory.ts` - current REST route to extend.
- `packages/daemon/src/pods/pod-bridge-impl.ts` - memory tool enforcement and report_plan/report_task_summary storage.
- `packages/escalation-mcp/src/server.ts` - MCP schemas for reporting and memory tools.
- `packages/daemon/src/pods/system-instructions-generator.ts` - old `Available Memory` section and final-step instructions.
- `packages/daemon/src/pods/pod-manager.ts` - approved memories are loaded before system instructions; status events provide failed/review_required extraction hooks.
- `packages/daemon/src/pods/quality-score-recorder.ts` - fail-soft recorder pattern.
- `packages/daemon/src/providers/llm-client.ts` - profile reviewer-model Anthropic client helper.
- `packages/daemon/src/worktrees/pr-description-generator.ts` - strict JSON LLM prompt/parse/fallback pattern.
- `packages/shared/src/sanitize/processor.ts` - `processContent` sanitization/quarantine pipeline.
- `packages/desktop/Sources/AutopodUI/Views/Memory/MemoryManagementView.swift` - current memory UI.
- `packages/desktop/Sources/AutopodDesktop/Stores/MemoryStore.swift` - current desktop memory state.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` - card grid pattern.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` - drill routing pattern.
- `packages/desktop/Package.swift` - Swift test targets.
- `docs/decisions/index.md` - ADR numbering and existing decision set.

## Decisions

- ADR-027: Daemon-curated reviewer-model memory loop (introduced).
