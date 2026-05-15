---
title: "Close residual Claude/Codex runtime gaps"
acceptance_criteria:
  - type: cmd
    outcome: Codex runtime exports a ResumeSessionNotFoundError class
    hint: grep -nE "export class CodexResumeSessionNotFoundError extends Error" packages/daemon/src/runtimes/codex-runtime.ts
    polarity: expect-output
  - type: cmd
    outcome: Codex runtime watches stderr for the "no rollout / thread not found" markers
    hint: grep -nE "no rollout found|thread .* not found|state db missing rollout path" packages/daemon/src/runtimes/codex-runtime.ts
    polarity: expect-output
  - type: cmd
    outcome: Codex resume() attaches a stderr listener that pushes [stderr] error events into the stream
    hint: grep -nE "handle\.stderr\.on\('data'" packages/daemon/src/runtimes/codex-runtime.ts
    polarity: expect-output
  - type: cmd
    outcome: pod-manager wraps the Codex recovery resume call in a try/catch generator that clears codexSessionId and falls back to a fresh spawn
    hint: grep -nE "CodexResumeSessionNotFoundError" packages/daemon/src/pods/pod-manager.ts
    polarity: expect-output
  - type: cmd
    outcome: pod-manager writes the autopod system instructions to ~/.codex/AGENTS.md for Codex pods
    hint: grep -nE "/\.codex/AGENTS\.md" packages/daemon/src/pods/pod-manager.ts
    polarity: expect-output
  - type: cmd
    outcome: codex-runtime config.toml writer bumps project_doc_max_bytes so heavy briefs are not truncated
    hint: grep -nE "project_doc_max_bytes" packages/daemon/src/runtimes/codex-runtime.ts
    polarity: expect-output
  - type: cmd
    outcome: Codex runtime resume tests cover (a) ResumeSessionNotFoundError on stderr marker, (b) stderr capture as [stderr] events
    hint: grep -nE "CodexResumeSessionNotFoundError|\\[stderr\\]" packages/daemon/src/runtimes/codex-runtime.test.ts
    polarity: expect-output
  - type: cmd
    outcome: pod-manager test asserts a Codex pod with a stale codexSessionId clears it and falls back to fresh spawn
    hint: grep -nE "CodexResumeSessionNotFoundError" packages/daemon/src/pods/pod-manager.test.ts
    polarity: expect-output
  - type: cmd
    outcome: typecheck, lint, and full test suite pass
    hint: ./scripts/validate.sh
    polarity: expect-output
touches:
  - packages/daemon/src/runtimes/codex-runtime.ts
  - packages/daemon/src/runtimes/codex-runtime.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
does_not_touch:
  - packages/daemon/src/runtimes/claude-runtime.ts
  - packages/daemon/src/runtimes/codex-stream-parser.ts
  - packages/daemon/src/runtimes/claude-stream-parser.ts
  - packages/shared/
  - packages/desktop/
  - packages/cli/
---

## Task

The codex-parity series (briefs 01-05, all landed) wired the Codex parser, reasoning event, session-ID capture, state-dir bind-mount, and `exec resume` invocation. A side-by-side read of `claude-runtime.ts` vs `codex-runtime.ts` and the two runtime call-sites in `pod-manager.ts` surfaces four residual operational gaps where Codex pods diverge from Claude pods. Close them so a Codex pod and a Claude pod behave indistinguishably on (1) stale-session resume recovery, (2) stderr visibility on agent crashes, and (3) the autopod system-instructions delivery surface.

Two further gaps were considered and **explicitly dropped** — see Non-goals.

### Gap 1: Codex resume-failure detection + orchestrator fallback

`ClaudeRuntime.resume()` (claude-runtime.ts:211-258) watches stderr for `"No conversation found with session ID"`, throws `ResumeSessionNotFoundError` after the stream drains, and `pod-manager.ts:4822-4846` wraps the call in a `resumeWithFallback` generator that catches the throw, clears `claudeSessionId`, and yields a fresh spawn. **The Codex equivalent is missing**: `codex-runtime.ts:147-215` has no stderr inspection, and `pod-manager.ts:4847-4852` calls `runtime.resume()` for Codex with no try/catch, so a stale `codexSessionId` (after a wipe of `~/.codex/sessions/`, a CLI upgrade, or an unrecoverable rollout DB) propagates upward as a hard failure.

Symptoms in production stderr (per OpenAI Codex issues #11634, #11997, #19475, #19661):
- `ERROR codex_core::session: failed to record rollout items: thread <uuid> not found`
- `no rollout found for thread`
- `ERROR codex_core::rollout::list: state db missing rollout path for thread`

### Gap 2: Codex stderr capture during resume

The same stderr listener block at claude-runtime.ts:216-232 also serves a second purpose: it surfaces stderr text as `[stderr]` `error` events in the agent stream so the CLI/desktop see crashes instead of going dark, and pino logs every line at `warn`. Codex `resume()` today doesn't read stderr at all — only the post-spawn `awaitExitCodeBounded` block in `spawn()` (codex-runtime.ts:125-144) emits an `error` event, and only after the process exits. A mid-stream Codex crash on resume is silent today.

This gap is the prerequisite mechanism for gap #1 — the same listener detects the resume-failure marker and pushes the warn log.

### Gap 3: System instructions delivery for Codex

`pod-manager.ts:4572-4576` writes `AUTOPOD_INSTRUCTIONS_PATH = /home/autopod/.autopod/system-instructions.md`. Claude picks it up via the `--append-system-prompt-file` CLI flag; Copilot via `customInstructions` (eventually merged with `/workspace/.github/copilot-instructions.md` at pod-manager.ts:4750-4769). **Codex doesn't pick it up at all.** Codex CLI has no `--instructions` / `--prompt-file` flag — it loads instructions only from discovered `AGENTS.md` files (verified against `codex-rs/exec/src/cli.rs` flag definitions and `codex-rs/core/src/agents_md.rs` discovery logic). The discovery order is:

1. `$CODEX_HOME/AGENTS.override.md`
2. `$CODEX_HOME/AGENTS.md`
3. Walk from project root downward to cwd: `AGENTS.override.md`, `AGENTS.md`, configured fallbacks

`$CODEX_HOME` defaults to `~/.codex/` (i.e. `/home/autopod/.codex/`). Codex enforces a `project_doc_max_bytes` budget on each file — the default is well below autopod's typical system-instructions size (the brief plus injected sections plus MCP docs commonly exceeds 32 KiB).

**Decision (locked):** write a second copy of `systemInstructions` to `/home/autopod/.codex/AGENTS.md` for Codex pods, and bump `project_doc_max_bytes = 262144` (256 KiB) in the existing config.toml write inside `codex-runtime.ts:writeMcpConfig`. The repo's own `AGENTS.md` (if any) is concatenated by Codex — autopod's instructions go first because global is loaded before project discovery.

## Per-gap implementation

### Gap 1 + Gap 2 (codex-runtime.ts)

Mirror the Claude pattern at claude-runtime.ts:1-42 and 211-258. The two gaps share the same listener block, so do them together.

1. **Constants + error class** at the top of `codex-runtime.ts` (after the existing imports):

   ```ts
   // Substrings Codex CLI emits to stderr when `exec resume <id>` finds no
   // matching rollout or thread record. Surfaces vary across releases — match
   // any of them. References: OpenAI codex issues #11634, #11997, #19475, #19661.
   const RESUME_FAILURE_MARKERS = [
     'no rollout found',
     'thread not found',
     'state db missing rollout path',
   ] as const;

   export class CodexResumeSessionNotFoundError extends Error {
     readonly podId: string;
     readonly codexSessionId: string | undefined;
     constructor(podId: string, codexSessionId: string | undefined) {
       super(
         `Codex exec resume failed: no rollout/thread for session ${codexSessionId ?? '<unknown>'}`,
       );
       this.name = 'CodexResumeSessionNotFoundError';
       this.podId = podId;
       this.codexSessionId = codexSessionId;
     }
   }
   ```

   Match markers case-insensitively against the stderr text — Codex's Rust logs are not stable on casing across versions.

2. **Wire stderr capture inside `resume()`** at codex-runtime.ts:192-194 (immediately after `this.handles.set(podId, handle);`). Mirror the Claude block at claude-runtime.ts:211-258:

   ```ts
   const stderrEvents: AgentEvent[] = [];
   const resumeFailure = { sessionNotFound: false };
   handle.stderr.on('data', (chunk: Buffer) => {
     const text = chunk.toString('utf-8').trim();
     if (!text) return;
     const lower = text.toLowerCase();
     if (RESUME_FAILURE_MARKERS.some((m) => lower.includes(m))) {
       resumeFailure.sessionNotFound = true;
     }
     this.logger.warn(
       { component: 'codex-runtime', podId, stderr: text.slice(0, 500) },
       'codex stderr',
     );
     stderrEvents.push({
       type: 'error',
       timestamp: new Date().toISOString(),
       message: `[stderr] ${text.slice(0, 500)}`,
       fatal: false,
     });
   });

   const codexSessionIds = this.codexSessionIds;
   const enriched = (async function* drainWithStderr(): AsyncIterable<AgentEvent> {
     for await (const event of CodexStreamParser.parse(handle.stdout, podId, logger)) {
       for (const e of stderrEvents.splice(0)) yield e;
       yield event;
     }
     for (const e of stderrEvents.splice(0)) yield e;
     if (resumeFailure.sessionNotFound) {
       codexSessionIds.delete(podId);
       throw new CodexResumeSessionNotFoundError(podId, sessionId ?? undefined);
     }
   })();
   ```

   Then wrap `enriched` in the existing `withPostCompleteGrace(withIdleLivenessProbe(...))` chain — replace the inline `CodexStreamParser.parse(...)` argument at codex-runtime.ts:197 with `enriched`.

3. **Throw only when `sessionId` was set** — if `resume()` was called with no session ID (fresh-fallback path at codex-runtime.ts:164), stderr capture still happens but `sessionNotFound` does nothing useful; either guard the throw on `sessionId != null` or let the error class carry `undefined`. Matching the Claude pattern, just throw — pod-manager's catch handles both.

### Gap 1 (pod-manager.ts:4847-4852)

Replace the bare Codex resume call:

```ts
} else if (isRecovery && pod.runtime === 'codex' && pod.codexSessionId) {
  emitStatus('Resuming Codex pod…');
  const codexContinuationPrompt = await buildContinuationPrompt(pod, worktreePath!);
  events = runtime.resume(podId, codexContinuationPrompt, containerId, secretEnv);
}
```

With the same `resumeWithFallback` shape Claude uses at pod-manager.ts:4822-4846 — closure-capture `podRepoRef`, `runtimeRef`, `containerIdRef`, etc., catch `CodexResumeSessionNotFoundError`, clear `codexSessionId`, log a warn, build a recovery task via `buildRecoveryTask(pod, worktreePath!)`, and `yield*` a fresh `runtime.spawn(...)`. Use `pod.runtime === 'codex'` to drive the import:

```ts
import { CodexRuntime, CodexResumeSessionNotFoundError } from '../runtimes/codex-runtime.js';
```

Add it next to the existing `ResumeSessionNotFoundError` import at pod-manager.ts:87.

The two `resumeWithFallback` generators (Claude's at 4822-4846, Codex's new one) duplicate enough lines that an extraction is tempting — **don't extract**. The two error types and the two pod-repo updates (`claudeSessionId` vs `codexSessionId`) are different enough that a generic helper adds more indirection than it saves; keep the two blocks parallel and obvious.

### Gap 3 (pod-manager.ts:4572-4576 + codex-runtime.ts:writeMcpConfig)

1. **In pod-manager**, immediately after the `AUTOPOD_INSTRUCTIONS_PATH` write at 4572-4576, add a Codex-specific copy:

   ```ts
   if (pod.runtime === 'codex') {
     await containerManager.writeFile(
       containerId,
       `${CONTAINER_HOME_DIR}/.codex/AGENTS.md`,
       systemInstructions,
     );
   }
   ```

   Pull `CONTAINER_HOME_DIR` from the existing `@autopod/shared` import at pod-manager.ts:41 (it's already exported alongside `AUTOPOD_INSTRUCTIONS_PATH`).

2. **In codex-runtime.ts:writeMcpConfig**, two changes:

   - Always emit the config.toml, even when `mcpServers` is empty — remove the early `return` at codex-runtime.ts:275. The budget bump needs to land even on profiles with no extra MCP servers (escalation alone may not require entries here, depending on what pod-manager passes — verify against the spawn config).
   - Prepend a top-level `project_doc_max_bytes = 262144` line to the output, above any `[mcp_servers.*]` sections. The TOML rule is "top-level keys before tables" — a stray top-level key after a `[table]` is a parse error.

   ```ts
   private async writeMcpConfig(
     containerId: string,
     mcpServers: SpawnConfig['mcpServers'],
   ): Promise<void> {
     const sections: string[] = [
       'project_doc_max_bytes = 262144',
     ];
     if (mcpServers && mcpServers.length > 0) {
       for (const server of mcpServers) { /* …existing logic… */ }
     }
     await this.containerManager.writeFile(containerId, MCP_CONFIG_PATH, `${sections.join('\n\n')}\n`);
   }
   ```

   The function is invoked on both spawn (codex-runtime.ts:66) and resume (codex-runtime.ts:156), so the budget is re-applied across container respawns and crash recovery — same lifecycle as the MCP config itself.

## Touches

- `packages/daemon/src/runtimes/codex-runtime.ts`
- `packages/daemon/src/runtimes/codex-runtime.test.ts`
- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/pods/pod-manager.test.ts`

## Does not touch

- `packages/daemon/src/runtimes/claude-runtime.ts` — Claude path is the reference shape; no change.
- `packages/daemon/src/runtimes/codex-stream-parser.ts` — parser is correct; the gaps are runtime-orchestration, not parsing.
- `packages/daemon/src/runtimes/claude-stream-parser.ts` — unrelated.
- `packages/shared/` — no new constants needed (`CONTAINER_HOME_DIR` already exported).
- `packages/desktop/`, `packages/cli/` — no UI surface change.

## Non-goals

- **Codex `--debug` flag parity.** Codex CLI exposes no debug or verbose flag (`codex debug` is a subcommand, not a flag). The closest analog would be `RUST_LOG=debug`, but Codex's Rust tracing writes to stderr in mixed formats that risk confusing the JSONL parser. Accepted asymmetry — `AUTOPOD_DEBUG_AGENT=1` continues to work for Claude only.
- **Codex model-alias resolution.** Claude's `resolveModelId` exists because users type `opus`/`sonnet`/`haiku` and the CLI needs `claude-opus-4-7`/etc. Codex's canonical model IDs (`gpt-5`, `gpt-5-mini`, `gpt-5-codex`) are already what users type — no alias mapping needed today. Re-open when a real alias use case emerges.
- **ACI parity.** The `~/.codex/AGENTS.md` write goes through `containerManager.writeFile(...)`, which already abstracts Docker and ACI uniformly. No ACI-specific work required.
- **Cleanup of `~/.codex/AGENTS.md` on terminal pod state.** The file lives in the container's writable layer (not the bind-mounted `~/.codex/sessions/`), and the container is removed on terminal pod state by `cleanup()` — no separate cleanup hook needed.
- **Retiring the `claudeSessionId` regex hack.** Already done in codex-parity brief 05 (commit `ddc2c2f`). Out of scope.

## Test expectations

In `codex-runtime.test.ts`:

1. `resume()` with `codexSessionId = 'stale-uuid'` and a mocked `execStreaming` whose stderr emits `"ERROR codex_core::session: failed to record rollout items: thread stale-uuid not found"`:
   - Asserts the resulting async iterable throws `CodexResumeSessionNotFoundError`.
   - Asserts `err.codexSessionId === 'stale-uuid'`.
   - Mirror the Claude test at claude-runtime.test.ts:774-800.
2. `resume()` with the same mocked stream + an unrelated stderr line (e.g. `"warning: low disk space"`):
   - Asserts a `[stderr] warning: low disk space` `error` event is yielded with `fatal: false`.
   - Asserts no error is thrown.
3. `writeMcpConfig` with `mcpServers = []`:
   - Asserts `containerManager.writeFile` is called once with a config.toml containing `project_doc_max_bytes = 262144` and no `[mcp_servers.*]` sections.
4. `writeMcpConfig` with one HTTP server:
   - Asserts the output contains BOTH the budget line and the `[mcp_servers.<name>]` table.

In `pod-manager.test.ts`:

1. A Codex pod entering the recovery branch with a stale `codexSessionId`, where the mocked runtime's `resume()` throws `CodexResumeSessionNotFoundError`:
   - Asserts `podRepo.update(podId, { codexSessionId: null })` was called.
   - Asserts a subsequent `runtime.spawn({ ... })` call with the recovery task was made.
   - Mirror the Claude test at pod-manager.test.ts:1914-1918+.
2. The system-instructions write block: a Codex pod's container receives a `writeFile` call for `/home/autopod/.codex/AGENTS.md` whose content matches the generated system instructions. (Claude pod assertion stays unchanged — proves the new write doesn't fire for non-Codex runtimes.)

## Live smoke test (manual; in addition to the unit tests)

After all unit tests pass, run a real Codex pod end-to-end. Requires Docker available locally (per the environment notes — may not run inside the sandbox).

1. `npx pnpm build && npx pnpm --filter @autopod/daemon start` (or your standard `ap` workflow).
2. Spawn a Codex pod against a tiny repo (e.g. the autopod scratch profile) and let it complete.
3. **Verify gap #3:** `docker exec <container> cat /home/autopod/.codex/AGENTS.md | head -20` returns the autopod system-instructions content. `docker exec <container> grep project_doc_max_bytes /home/autopod/.codex/config.toml` returns `project_doc_max_bytes = 262144`.
4. **Verify gap #1 + #2 (induced failure):**
   - With a Codex pod that has a persisted `codexSessionId`, `docker exec <container> rm -rf /home/autopod/.codex/sessions/*`.
   - Kill the daemon and restart it so the pod re-enters recovery.
   - Observe in the daemon logs: `"Codex exec resume failed: no rollout/thread for session …"` followed by `"Codex --resume found no rollout — falling back to fresh spawn"` (or whatever the analogue warn message ends up being), and the pod reaches `complete`.
   - In the SQLite DB, `codexSessionId` is cleared after the fallback.

Capture the smoke output in a paragraph at the end of the PR description.

## Risks / pitfalls

- **Codex stderr marker drift.** The marker strings come from OpenAI Codex GitHub issues — they're not a documented stable contract. New CLI versions may change wording. The match is case-insensitive substring over three alternative strings, which gives some breathing room, but if a future Codex release renames them entirely the runtime silently stops catching resume failures. Lock the strings in the test fixture so a parser-update commit catches the drift, and leave a comment pointing back to this brief.
- **`writeMcpConfig` early-return removal.** Today the function bails when `mcpServers` is empty. After this brief it always writes. Confirm no existing test relies on the early return (grep `codex-runtime.test.ts` for `writeFile` assertions); update tests accordingly.
- **TOML top-level-key-before-table rule.** `project_doc_max_bytes` MUST be emitted before any `[mcp_servers.*]` section. Putting it after produces a parse error and Codex refuses to start. The example join order in the snippet above is correct; the test should assert ordering.
- **`AGENTS.md` size in tests.** The system-instructions output can be 30 KiB+. The unit test for the `pod-manager` write doesn't need to exercise that size — assert path + content prefix only, not full equality on a 30 KiB string.
- **resume() fallback path with no session ID.** When `resume()` is called with no persisted session ID (the fresh-fallback at codex-runtime.ts:164), the stderr listener still runs. The `sessionNotFound` flag will never trip in that path, but it's worth a one-line comment so a future reader doesn't think the listener is dead code on that branch.
- **Test pollution from the in-memory `codexSessionIds` Map.** `codex-runtime.test.ts` should `new CodexRuntime(...)` fresh per test or explicitly clear the Map; otherwise a `resume` failure test could leak the stale ID into a later test's spawn.

## Reference reading

- `packages/daemon/src/runtimes/claude-runtime.ts` — lines 1-42 (constants + `ResumeSessionNotFoundError`) and 211-258 (the stderr listener + resume-failure throw). This is the canonical shape to mirror.
- `packages/daemon/src/runtimes/claude-runtime.test.ts:774-800` — the test pattern for "throws `ResumeSessionNotFoundError` when stderr emits the marker".
- `packages/daemon/src/pods/pod-manager.ts:4822-4846` — the Claude `resumeWithFallback` generator. The Codex version mirrors this at 4847+ once this brief lands.
- `packages/daemon/src/pods/pod-manager.test.ts:1914+` — the test pattern for "stale session → fallback".
- `packages/daemon/src/runtimes/codex-runtime.ts` — current state of the runtime (post-codex-parity brief 05).
- `specs/codex-parity/{purpose,design}.md` and `specs/codex-parity/briefs/05-wire-resume-and-state-dir.md` — the prior series that landed the session-continuity stack this brief builds on.

## Glossary

- **Codex session ID** — the UUID emitted on `session_configured.session_id` and persisted as `pods.codex_session_id`. `codex exec resume <SESSION_ID>` continues an existing rollout file at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- **`CODEX_HOME`** — Codex's config + session root. Defaults to `~/.codex/`. Inside autopod containers this resolves to `/home/autopod/.codex/`.
- **`AGENTS.md`** — Codex's user-instruction file (analogous to Claude's `CLAUDE.md`). Loaded from `$CODEX_HOME/AGENTS.{override.,}md` first, then walked from project root down to cwd.
- **`project_doc_max_bytes`** — Codex `config.toml` field controlling the per-file byte budget when reading `AGENTS.md`. Default is well below autopod's typical system-instructions size.
- **`CodexResumeSessionNotFoundError`** — new error class thrown from `CodexRuntime.resume()` when stderr indicates the rollout or thread record is missing. Caught by pod-manager to drive the fresh-spawn fallback.
- **`ResumeSessionNotFoundError`** — the existing Claude equivalent at `claude-runtime.ts:31-42`. Kept as the per-runtime convention rather than introducing a shared base class.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings (especially the temptation to extract a generic `resumeWithFallback` helper — keep the two blocks parallel; see the gap #1 implementation note).
2. Run `./scripts/validate.sh` — build, lint, full test suite must all pass.
3. Run the **live smoke test** described above against a real Codex container. Paste a one-paragraph summary in the PR description.
4. Commit and push to `claude/compare-implementations-6np9A`.
