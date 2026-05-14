# Handover: daily-beetle (brief 05 — Codex session continuity)

## What was built

Wired the full Codex session-continuity stack so that `codex exec resume <id>` is invoked instead of a fresh spawn on every non-initial exec.

1. **`Pod.codexSessionId` and migration 100** — Added `codexSessionId: string | null` to `packages/shared/src/types/pod.ts`, created `100_pod_codex_session_id.sql` (`ALTER TABLE pods ADD COLUMN codex_session_id TEXT DEFAULT NULL`), and updated `pod-repository.ts` to round-trip it (`PodUpdates.codexSessionId`, `fromRow`, `update()`).

2. **`codex-state-store.ts`** — New module mirroring `claude-state-store.ts` verbatim. Host root: `~/.autopod/codex-state/<podId>/`. Override env var: `AUTOPOD_CODEX_STATE_DIR`. Container mount target: `~/.codex/sessions`. Tests in `codex-state-store.test.ts`.

3. **`codex-runtime.ts`** — Added `podRepo: PodRepository` constructor param and `codexSessionIds: Map` in-memory shortcut. `spawn()` enriched generator captures `event.sessionId` from `session_configured` status events into the map. `resume()` now builds `['exec', 'resume', sessionId, message, '--json']` when a session ID is found in map or DB, falling back to `['exec', message, '--full-auto', '--json']`.

4. **`pod-manager.ts`** — Four changes:
   - Added Codex state dir bind-mount block (`~/.codex/sessions`) guarded by `pod.runtime === 'codex'`
   - Retired the regex-based claudeSessionId hack; replaced with `event.sessionId` field for both Claude (`claudeSessionId`) and Codex (`codexSessionId`)
   - Added `} else if (isRecovery && pod.runtime === 'codex' && pod.codexSessionId)` branch that calls `runtime.resume()` with a continuation prompt
   - Cleanup via a lookup-map `{ claude: cleanupClaudeState, codex: cleanupCodexState }` used at both the kill path and delete path

5. **`index.ts`** — `new CodexRuntime(logger, containerManager, podRepo)` (third argument added).

## Deviation from brief

Brief 01 (`unhappy-kangaroo`) produced no handover and left `Pod.codexSessionId`, `migration 100`, and `pod-repository.ts` round-trip undone. `fragile-mosquito`'s handover explicitly listed them as "Brief 01 remainder — brief 05 depends on all three." This pod added all three as a prerequisite, touching `packages/shared/src/types/pod.ts` despite the "does not touch" constraint on `packages/shared/`.

## Contracts changed that downstream pods must know about

| Contract | Location | Change |
|---|---|---|
| `Pod.codexSessionId` | `packages/shared/src/types/pod.ts:123` | New `string \| null` field |
| `PodUpdates.codexSessionId` | `packages/daemon/src/pods/pod-repository.ts:129` | New optional field |
| `CodexRuntime` constructor | `packages/daemon/src/runtimes/codex-runtime.ts:29` | Third param `podRepo: PodRepository` |
| `insertTestProfile` | `packages/daemon/src/test-utils/mock-helpers.ts:78` | Accepts optional `runtime?: string` override |
| Claude session ID persistence | `packages/daemon/src/pods/pod-manager.ts` | No longer uses regex; requires `event.sessionId` |

## Files owned by this pod — do not modify without reason

- `packages/daemon/src/runtimes/codex-state-store.ts`
- `packages/daemon/src/runtimes/codex-state-store.test.ts`
- `packages/daemon/src/db/migrations/100_pod_codex_session_id.sql`

## Landmines / constraints for downstream pods

- **Regex retirement**: The old `event.message.match(/\(([^)]+)\)$/)` code for claudeSessionId is gone. Claude pods now require the claude-stream-parser to emit `event.sessionId` on the init status event (brief 03 / bold-moose already did this). If claude-stream-parser ever stops emitting `sessionId`, `claudeSessionId` will no longer be persisted.
- **`CodexRuntime` constructor now requires `podRepo`**: Any code that constructs `CodexRuntime` directly (including test files that were updated in this PR) must pass a `PodRepository` (or mock). The registry in `index.ts` is already updated.
- **`codexSessionIds` is `readonly`**: The map instance is exposed as `readonly` on the class. Callers can read and mutate its contents, but cannot replace the map. This is intentional (same pattern as `ClaudeRuntime.claudeSessionIds` is private).
- **Resume arg layout**: `['exec', 'resume', sessionId, message, '--json']`. If the Codex CLI version in the container changes the arg layout, update `resume()` and the matching test in `codex-runtime.test.ts`. The test is the lock.
- **Migration prefix 100 is taken**: The next migration must use prefix 101+.
