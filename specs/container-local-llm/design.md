# Design - Container-Local Daemon LLM Helpers

## Blast radius
- Shared cost contracts: `packages/shared/src/types/pod.ts`.
- Generic helper plumbing: `packages/daemon/src/providers/container-first-llm-helper.ts`,
  `packages/daemon/src/validation/container-reviewer-runner.ts`,
  `packages/daemon/src/validation/review-codex-runner.ts`.
- Helper-container provisioning: `packages/daemon/src/pods/helper-container-runner.ts`,
  `packages/daemon/src/pods/pod-manager.ts`,
  `packages/daemon/src/interfaces/container-manager.ts`,
  `packages/daemon/src/containers/sandbox-container-manager.ts`.
- PR and commit helpers: `packages/daemon/src/worktrees/pr-description-generator.ts`,
  `packages/daemon/src/worktrees/auto-commit-message.ts`,
  `packages/daemon/src/worktrees/pr-manager.ts`,
  `packages/daemon/src/worktrees/ado-pr-manager.ts`.
- Existing best-effort helpers: `packages/daemon/src/providers/memory-reviewer.ts`,
  `packages/daemon/src/validation/advisory-browser-qa-runner.ts`,
  `packages/daemon/src/pods/pod-bridge-impl.ts`.
- Validation preservation: `packages/daemon/src/validation/local-validation-engine.ts`,
  `packages/daemon/src/validation/pre-submit-review.ts`,
  `packages/daemon/src/validation/review-tool-runner.ts`.
- Cost and activity attribution: `packages/daemon/src/pods/cost-aggregation.ts`,
  `packages/daemon/src/pods/pod-cost-breakdown.ts`,
  `packages/daemon/src/pods/pod-manager.ts`.

## Seams
- Shared helper contract -> helper-container runner. Brief 01 owns the typed
  helper task/result contract and stage ordering. Brief 02 owns how the
  `helper_container` stage is provisioned for local and sandbox targets.
- Helper contract -> PR/commit call sites. Brief 03 consumes the shared helper
  for PR title, PR narrative, and auto-commit messages while keeping daemon
  git/PR authority.
- Helper contract -> existing helper call sites. Brief 04 consumes the shared
  helper for memory, advisory, and MCP ask_ai/browser-script paths where their
  current behavior allows it.
- Best-effort helpers -> blocking validation review. Brief 05 proves validation
  review remains a separate blocking validation path and keeps `review`
  attribution.
- Helper task results -> token/activity surfaces. Brief 06 owns the `helper`
  phase, cost bucket, token accumulation, and final-degradation-only pod
  activity semantics.

## Contracts
The shared helper contract is intentionally prompt-only. The caller computes all
repo-specific context, then passes a prompt plus fallback callbacks.

```ts
export type HelperLlmStage =
  | 'live_container'
  | 'helper_container'
  | 'daemon_api'
  | 'deterministic_fallback';

export interface HelperLlmTask {
  podId: string;
  profile: Profile;
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs: number;
  allowHelperContainer: boolean;
  liveContainer?: {
    containerId: string | null | undefined;
    containerManager: ContainerManager;
    env?: Record<string, string>;
  };
  fallback: () => Promise<HelperLlmResult>;
}

export interface HelperLlmResult {
  ok: boolean;
  stage: HelperLlmStage;
  text: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
  usedFallback: boolean;
  fallbackReason?: string;
  fallbackDetail?: string;
  stageFailures?: Array<{ stage: HelperLlmStage; reason: string }>;
}
```

The prompt-only helper-container runner consumes the daemon-computed prompt and
must not read the repo.

```ts
export interface HelperContainerRunConfig {
  podId: string;
  executionTarget: ExecutionTarget;
  image: string;
  profile: Profile;
  model: string;
  prompt: string;
  env?: Record<string, string>;
  timeoutMs: number;
}
```

`PhaseTokenUsage` gains one harness-side phase:

```ts
export type PhaseTokenUsage = Partial<
  Record<
    | 'agent_initial'
    | `agent_rework_${number}`
    | 'review'
    | 'plan_eval'
    | 'advisory'
    | 'helper',
    { inputTokens: number; outputTokens: number; cachedInputTokens?: number; costUsd?: number }
  >
>;

export type PodCostBucket =
  | 'work'
  | 'rework'
  | 'validation'
  | 'advisory'
  | 'helper'
  | 'unattributed';
```

Fallback visibility contract:
- live-container and helper-container misses are structured logs with
  `stageFailures`;
- daemon API fallback is allowed and may return valid helper output;
- pod activity is emitted only when the final output is deterministic/template
  fallback, matching current PR metadata and memory deterministic fallback
  behavior.

Validation boundary contract:
- blocking task review, deep review, and pre-submit review are not migrated to
  `helper` in this feature;
- MAX/container task review and pre-submit review keep their existing live-pod
  container hooks;
- validation token usage remains under `review`, `plan_eval`, or `advisory` as
  it does today.

## Reference reading
- `AGENTS.md` - monorepo package map, Autopod validation conventions, and
  Docker/sandbox gotchas.
- `docs/decisions/ADR-001-distributed-runners-thin-runner.md` - daemon remains
  authoritative for worktrees, git operations, and PRs.
- `docs/decisions/ADR-016-phase-token-per-attempt-taxonomy.md` - adding a phase
  bucket is a shared analytics contract.
- `docs/decisions/ADR-027-daemon-curated-memory-loop.md` - memory selection is
  daemon-curated and fail-soft.
- `docs/decisions/ADR-031-azure-container-apps-sandboxes-backend.md` - sandbox
  uses the `ContainerManager` contract but cannot rely on Docker bind mounts.
- `docs/conventions/convention-001-autopod-self-required-facts.md` - Autopod
  self facts must be durable and Linux-compatible.
- `packages/daemon/src/validation/container-reviewer-runner.ts` - existing live
  pod Claude/Codex reviewer runner.
- `packages/daemon/src/runtimes/run-claude-cli.ts` - Claude CLI JSON token/cost
  parsing pattern.
- `packages/daemon/src/validation/review-codex-runner.ts` - Codex JSON event
  token parsing pattern.
- `packages/daemon/src/worktrees/pr-description-generator.ts` - current PR
  title/body daemon API fallback logic.
- `packages/daemon/src/worktrees/auto-commit-message.ts` - current auto-commit
  daemon API fallback logic.
- `packages/daemon/src/providers/memory-reviewer.ts` - existing container-first
  memory reviewer wrapper.
- `packages/daemon/src/validation/advisory-browser-qa-runner.ts` - existing
  advisory container/direct fallback and token usage logic.
- `packages/daemon/src/pods/pod-manager.ts` - PR creation timing, reviewer exec
  env, credential injection, token accumulation, and activity emission.
- `packages/daemon/src/pods/cost-aggregation.ts` and
  `packages/daemon/src/pods/pod-cost-breakdown.ts` - cost segment handling.

## Decisions
- ADR-032: Prompt-only helper containers for daemon LLM helpers (introduced).
- ADR-001: Distributed runners, thin runner (existing).
- ADR-016: Per-attempt phase token taxonomy (existing).
- ADR-027: Daemon-curated reviewer-model memory loop (existing).
- ADR-031: Azure Container Apps Sandboxes backend (existing).
