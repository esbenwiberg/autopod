---
name: add-pod-state
description: >
  Walks through the layers that must be touched when adding a new value to
  `PodStatus` — the type, the transition table, behavioural helpers, optional
  migration, and the orchestrator handler. Use when introducing a new pod
  lifecycle state or sub-state.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
---

# /add-pod-state

Adding a new `PodStatus` value is small but bug-prone — miss the transition
table and the new state is unreachable; miss the orchestrator handler and pods
land in it and just sit there.

## When to use

- The user wants to introduce a new pod lifecycle state (e.g.
  `awaiting_review`, `paused_for_credentials`).
- A new sub-state of an existing phase that needs its own behaviour.

## When NOT to use

- A new attribute on an existing state — that's a column on `pods`, not a
  status value.
- A transient runtime flag that doesn't survive restart — keep it in memory.

## Procedure

### 1. Add the value to `PodStatus`

`packages/shared/src/types/pod.ts` — extend the `PodStatus` union.

### 2. Add allowed transitions

`packages/shared/src/constants.ts` — add entries to
`VALID_STATUS_TRANSITIONS` covering every legal in-edge and out-edge.
A state with no in-edges is unreachable; with no out-edges, terminal (which
may or may not be intentional — check `isTerminalState()`).

### 3. Update behavioural helpers

`packages/daemon/src/pods/state-machine.ts` — update the relevant
`canX()` helpers (`canReceiveMessage`, `canPause`, `canNudge`, `canKill`,
`isTerminalState`) for the new state's semantics.

### 4. Migration (only if persistence shape changes)

Pod status is stored as a text column — adding a new value usually doesn't
need a migration. Add one only if the new state requires new columns
(`packages/daemon/src/db/migrations/0NN_*.sql`, never reuse a prefix).

### 5. Handle the new state in `processPod()`

`packages/daemon/src/pods/pod-manager.ts` — the orchestration loop must know
what to do when a pod is in this state, otherwise pods land in it and idle.

## Verification

```bash
npx pnpm --filter @autopod/daemon test
```

Run the state-machine tests specifically:

```bash
npx pnpm --filter @autopod/daemon test -- state-machine.test
```

If the state should appear in the desktop UI status mapping, also update
`packages/desktop/Sources/AutopodUI/.../PodStatusBadge.swift` (or equivalent).
