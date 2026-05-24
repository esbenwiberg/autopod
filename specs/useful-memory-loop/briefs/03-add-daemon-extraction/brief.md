---
title: "Add daemon memory extraction recorder"
touches:
  - packages/daemon/src/pods/memory-candidate-recorder.ts
  - packages/daemon/src/pods/memory-extraction.ts
  - packages/daemon/src/pods/memory-candidate-recorder.test.ts
  - packages/daemon/src/pods/memory-extraction.test.ts
  - packages/daemon/src/index.ts
  - packages/daemon/src/providers/llm-client.ts
  - packages/daemon/src/pods/quality-score-recorder.ts
does_not_touch:
  - packages/daemon/src/pods/system-instructions-generator.ts
  - packages/escalation-mcp/
  - packages/desktop/
---

## Task

Add daemon-curated durable memory extraction. It should listen in the background, never block pod completion, and behave like `QualityScoreRecorder`: idempotent, fail-soft, and observable through skipped/fallback reasons.

Extraction only applies to future agent-driven pods (`agentMode: auto`). Exclude interactive workspace/history/memory-workspace pods. Run one extraction attempt per pod outcome: `pod.completed` for complete/killed and `pod.status_changed` for failed/review_required. Compute lesson potential first. Only call the reviewer model above threshold. Produce at most one durable profile candidate per pod outcome. Existing/manual global memories remain supported, but this recorder must not auto-generate global candidates.

## Touches

- `packages/daemon/src/pods/memory-candidate-recorder.ts` - event listener and idempotency.
- `packages/daemon/src/pods/memory-extraction.ts` - lesson-potential scoring, sanitized prompt shaping, reviewer-model JSON parsing, create/update candidate decision.
- `packages/daemon/src/pods/memory-candidate-recorder.test.ts` and `packages/daemon/src/pods/memory-extraction.test.ts` - focused behavior coverage.
- `packages/daemon/src/index.ts` - instantiate after repositories/event bus are available.
- `packages/daemon/src/providers/llm-client.ts` - reuse `createProfileAnthropicClient` pattern if a small helper is needed.
- `packages/daemon/src/pods/quality-score-recorder.ts` - reference only; avoid refactoring it unless a tiny shared helper is unavoidable.

## Does not touch

- `packages/daemon/src/pods/system-instructions-generator.ts` - selection/injection is brief 04.
- `packages/escalation-mcp/` - agent reporting is brief 05.
- `packages/desktop/` - review UI is briefs 07/08.

## Constraints

- Reviewer model is `profile.reviewerModel || profile.defaultModel || pod.model || "claude-haiku-4-5"` and must be called via `createProfileAnthropicClient`.
- Use `processContent` before storing candidate content/evidence and before sending pod-derived snippets to the reviewer model.
- High priority signals: validation failures, PR/fix feedback, human rejection, low quality score, high cost, rework, tells/churn, escalations.
- Medium priority: unusually successful/high-signal pods.
- Low priority: ordinary green pods rarely produce candidates.
- LLM failure records a fallback/skipped reason and never changes pod lifecycle.

## Test expectations

Cover complete/killed/failed/review_required triggers, future-only gating, agent-mode gating, one-candidate cap, lesson-potential thresholds, sanitized evidence, reviewer-model fallback reasons, and update-candidate overlap.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
