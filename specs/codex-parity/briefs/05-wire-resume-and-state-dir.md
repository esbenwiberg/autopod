---
title: "Wire Codex session resume and state directory"
depends_on: [01-establish-shared-contracts, 02-codex-parser-parity]
acceptance_criteria:
  - type: cmd
    outcome: codex-state-store helper module exists
    hint: test -f packages/daemon/src/runtimes/codex-state-store.ts
    polarity: expect-output
  - type: cmd
    outcome: codex-runtime resume uses exec resume subcommand
    hint: grep -nE "'exec', 'resume'" packages/daemon/src/runtimes/codex-runtime.ts
    polarity: expect-output
  - type: cmd
    outcome: pod-manager persists codex session ID from event.sessionId
    hint: grep -nE "codexSessionId" packages/daemon/src/pods/pod-manager.ts
    polarity: expect-output
touches:
  - packages/daemon/src/runtimes/codex-state-store.ts
  - packages/daemon/src/runtimes/codex-state-store.test.ts
  - packages/daemon/src/runtimes/codex-runtime.ts
  - packages/daemon/src/runtimes/codex-runtime.test.ts
  - packages/daemon/src/pods/pod-manager.ts
does_not_touch:
  - packages/daemon/src/runtimes/codex-stream-parser.ts
  - packages/daemon/src/runtimes/claude-stream-parser.ts
  - packages/shared/
  - packages/desktop/
  - packages/cli/
---

## Task

Wire persistence + bind-mount + resume mechanics that complete Codex session continuity.

1. **`codex-state-store.ts`** (new). Mirror `packages/daemon/src/runtimes/claude-state-store.ts` verbatim. Export:

   ```ts
   export function codexStateDirForPod(podId: string): string;
   export async function ensureCodexStateDir(podId: string): Promise<string>;
   export async function cleanupCodexState(podId: string): Promise<void>;
   ```

   Host root: `~/.autopod/codex-state/<podId>/`. Override env var: `AUTOPOD_CODEX_STATE_DIR`. Container mount target: `${CONTAINER_HOME_DIR}/.codex/sessions` (where Codex CLI looks up rollouts).

2. **pod-manager bind-mount for Codex**. At `pod-manager.ts:3566-3580` the Claude state dir is established and added to the spawn volumes list. Add a parallel block guarded by `pod.runtime === 'codex'`:

   ```ts
   let codexStateDir: string | null = null;
   if (pod.runtime === 'codex') {
     try {
       codexStateDir = await ensureCodexStateDir(podId);
     } catch (err) {
       logger.warn(
         { err, podId },
         'Failed to create Codex state dir — resume across container respawns will fail',
       );
     }
   }
   ```

   Add the mount to the `volumes` array at `pod-manager.ts:3589-3595`:

   ```ts
   ...(codexStateDir
     ? [{ host: codexStateDir, container: `${CONTAINER_HOME_DIR}/.codex/sessions` }]
     : []),
   ```

   Update the comment at line 3569 — it currently reads "Only wired for Claude — codex/copilot respawn fresh without state." After this change: "Wired for Claude and Codex; Copilot still respawns fresh."

3. **pod-manager: persist `codexSessionId` from `event.sessionId`**. At `pod-manager.ts:4806-4811`, retire the Claude-specific regex hack:

   ```ts
   } else if (event.type === 'status' && event.sessionId) {
     const update: PodUpdates = {};
     if (pod.runtime === 'claude') update.claudeSessionId = event.sessionId;
     else if (pod.runtime === 'codex') update.codexSessionId = event.sessionId;
     if (Object.keys(update).length > 0) podRepo.update(podId, update);
   }
   ```

   The old regex-on-message-string code (`event.message.match(/\(([^)]+)\)$/)`) deletes; brief 03 keeps the `(xxx)` suffix in the message for human readability, so the visible CLI/desktop text is unchanged.

4. **`codex-runtime.ts:resume()`**. Today (codex-runtime.ts:103) constructs `['exec', message, '--full-auto', '--json']` — a fresh exec with the message, no history. Replace with a session-aware shape:

   ```ts
   async *resume(podId, message, containerId, env?) {
     const sessionId = this.codexSessionIds.get(podId)
       ?? this.podRepo.getOrThrow(podId).codexSessionId;
     const args = sessionId
       ? ['exec', 'resume', sessionId, message, '--json']
       : ['exec', message, '--full-auto', '--json']; // fresh fallback
     // ...rest unchanged: shimPath, execStreaming, parser, grace, exit-code wait
   }
   ```

   Inject `podRepo` (and a per-runtime `codexSessionIds: Map<string, string>`) via the constructor — mirror `ClaudeRuntime` at claude-runtime.ts:33-40 + 326. The `runtime-registry.ts` constructor wires the dependencies.

   Also update `CodexRuntime.spawn()` to populate the `codexSessionIds` Map when the first `session_configured` event surfaces in the AgentEvent stream — observe the `AgentStatusEvent.sessionId` field as events flow through. The Map is the in-memory short-cut; pod-manager's DB persistence is the durable source.

5. **`codex-runtime.ts:spawn()` — unchanged otherwise.** First spawn stays `exec <task> --model <model> --full-auto --json`. The parser captures the session ID; pod-manager persists it; subsequent `resume()` reads from DB or Map.

   **Exact `exec resume` arg layout** — verify against `codex --help exec resume` inside the container image. The 2026 docs confirm `codex exec resume <SESSION_ID>` accepts a follow-up prompt; current understanding is positional `<message>` after the session ID. If the actual CLI uses `--prompt`/stdin/etc., adjust and lock the shape in the unit test.

## Touches

- `packages/daemon/src/runtimes/codex-state-store.ts` (new)
- `packages/daemon/src/runtimes/codex-state-store.test.ts` (new)
- `packages/daemon/src/runtimes/codex-runtime.ts`
- `packages/daemon/src/runtimes/codex-runtime.test.ts`
- `packages/daemon/src/pods/pod-manager.ts`

## Does not touch

- `packages/daemon/src/runtimes/codex-stream-parser.ts` — gated by brief 02.
- `packages/daemon/src/runtimes/claude-stream-parser.ts` — gated by brief 03.
- `packages/shared/` — gated by brief 01.
- `packages/desktop/`, `packages/cli/` — gated by brief 04.

## Constraints

- **ADR-007 (re-queue recovery)**: pod-manager.ts:3213+ already handles `recoveryWorktreePath` for orphaned-pod recovery. The `runtime.resume()` call from the recovery flow (pod-manager.ts:4616) is where Codex resume was failing silently. After this brief, recovery actually continues the Codex session.
- **Mid-stream re-prompting changes for Codex**: `runtime.resume()` is called from FIVE places — recovery, validation correction (pod-manager.ts:5383), escalation response (~5424), rejection retry (~5882), validation post-fix loop (~7157). All five start continuing the Codex conversation instead of fresh-exec'ing. This is intentional parity behavior and is documented as a cross-cutting issue in the spec's plan preview. Don't try to gate it behind a feature flag; the whole point is symmetry with Claude.
- **ACI parity**: bind-mount goes through `containerManager.spawn().volumes` uniformly. Whatever ACI does today for the Claude bind-mount, it does for Codex automatically. This brief does NOT separately test ACI; that's existing infrastructure-test coverage.
- **Cleanup on terminal**: when a Codex pod hits a terminal state (`complete`/`killed`/`failed`), call `cleanupCodexState(podId)` symmetrically with `cleanupClaudeState`. Grep `pod-manager.ts` for `cleanupClaudeState` calls and add a Codex sibling at each site (typically the finally block of `processPod()`).
- **`CodexRuntime` constructor change**: the `runtime-registry.ts` (`packages/daemon/src/runtimes/runtime-registry.ts`) constructs runtimes. If new dependencies are added (podRepo), update the registry. Don't break Claude's wiring.

## Test expectations

- `codex-state-store.test.ts`: cover `ensureCodexStateDir(podId)` creates the directory, `cleanupCodexState(podId)` removes it, and `AUTOPOD_CODEX_STATE_DIR` env override works. Mirror `claude-state-store.test.ts` line-for-line.
- `codex-runtime.test.ts`: add a `resume()` test — mock `execStreaming`, assert args contain `['exec', 'resume', '<sessionId>', message, '--json']` when `pod.codexSessionId` is set in the mock podRepo.
- `codex-runtime.test.ts`: add a `resume()` fallback test — when `codexSessionId` is null, assert args contain `['exec', message, '--full-auto', '--json']` (today's path).
- `codex-runtime.test.ts`: add a `spawn()` test — verify that an `AgentStatusEvent.sessionId` flowing through the parser populates `codexSessionIds` Map (in-memory short-cut).
- `pod-lifecycle.e2e.test.ts` — add a case: spawn a Codex pod, simulate `AgentStatusEvent` with `sessionId`, assert `podRepo.getOrThrow().codexSessionId` equals the session ID. Add a symmetric case for Claude (proves the regex-hack retirement doesn't regress Claude).
- The full daemon-restart-mid-stream observable (success signal #4) is anchored by the e2e test case plus the `codex-runtime.test.ts` assertions on the resume arg shape. No `cmd`/`api`/`web` AC fires that observable — accepted per the cross-cutting resolution.

## Risks / pitfalls

- The exact `codex exec resume` arg layout may differ across Codex CLI versions. Lock the shape in the test fixture after verifying in the container image; if it changes upstream, the test catches it.
- `~/.codex/sessions/` is populated by Codex with `YYYY/MM/DD/rollout-*.jsonl`. Bind-mounting just the top-level `~/.codex/sessions/` is sufficient — the date-directory structure is internal to Codex.
- `claudeSessionId` persistence currently happens via the regex hack; the retirement is in the same commit as the new sessionId-field path. Don't leave both code paths active — either is fine alone, both together causes a double-write.
- `CodexRuntime` doesn't currently know about `podRepo`. The constructor signature change ripples through `runtime-registry.ts` and any test that constructs a `CodexRuntime` directly. Quick grep before the change confirms the scope (probably 2-3 sites).

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
