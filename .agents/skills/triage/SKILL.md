---
name: triage
description: Route Autopod work to the right workflow before planning or execution. Use when a request is ambiguous between fixing directly, /investigate-bug, /prep, /plan-feature, /podsitter, /code-council, /arch-council, /premortem, or a repo-specific checklist skill; also use when the user asks which skill or planning path to use.
---

# Triage

## Overview

Choose the smallest workflow that can responsibly handle the request. Triage is a router, not a planning ceremony.

## First Pass

Scan for at most 60-90 seconds before choosing:

1. Restate the requested outcome in one sentence.
2. Grep likely terms and file paths if the request names code, behavior, or an error.
3. Check whether the request already names a skill; explicit user choice wins unless the code scan shows a clear mismatch.
4. Search `docs/decisions/index.md`, `docs/conventions/index.md`, and approved memories when available. Treat matches as routing evidence, not as a reason to deepen triage.
5. Decide the primary route and any secondary checklist skills that should be referenced later.

If the user only asked "which skill?", stop after the recommendation. If the user asked you to do the work, immediately load and follow the selected skill.

## Routing Table

| Signal | Route |
| --- | --- |
| Exact fix is obvious, low risk, and no planning artifact would survive merge | Fix directly |
| Broken behavior, unclear root cause, repro/regression needed | `/investigate-bug` |
| Single concern, 1-2 packages, no new cross-module contract, one validation checkpoint | `/prep` |
| 3+ modules, >4 hours, multiple pods/checkpoints, new shared contract, or ADR likely | `/plan-feature` |
| User asks to watch, babysit, unstick, rescue, approve, or operate recent pods | `/podsitter` |
| User asks "should we build this?" or "is this a good idea?" | `/code-council` |
| User compares viable architecture/tooling options | `/arch-council` |
| User wants blind spots, risk, failure modes, or stress testing | `/premortem` |
| Request touches `Profile` fields | Reference `/add-profile-field` inside `/prep` or `/plan-feature` |
| Request touches `PodStatus` or state transitions | Reference `/add-pod-state` inside `/prep` or `/plan-feature` |

## Decision Rules

- Prefer the lighter route when the blast radius is genuinely small.
- Upgrade from `/prep` to `/plan-feature` when scanning reveals 3+ packages, a new public/shared type, DB rollout concerns, or an ADR-sized decision.
- Prefer `/investigate-bug` over `/prep` when the first artifact needed is root cause, not implementation work.
- Do not route every bug through `/investigate-bug`: trivial, localized bugs can be fixed directly.
- Do not use `/plan-feature` just because the idea is important; use it because the work needs multiple checkpoints or cross-module design.
- Secondary checklist skills are not primary routes. Attach them to the selected planning artifact so the executor reads them at the right moment.

## Output Shape

When stopping after triage, answer in this compact form:

```markdown
Route: /prep
Why: single concern, daemon-only, one required fact can prove it.
Secondary skills: /add-pod-state
Next move: load /prep and scan `packages/shared/src/types/pod.ts` plus `packages/daemon/src/pods/state-machine.ts`.
```

When continuing, state the route in one sentence and then follow the selected skill without adding another confirmation gate.
