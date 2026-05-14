# Codex parity

## Problem

The Codex runtime in autopod is materially less capable than the Claude runtime on four user-visible properties: it never emits `file_change` events (Codex's `patch_apply_*` events are unmapped — the parser drops them); `pod.costUsd` stays at 0 because Codex emits no native cost field; the `agent_reasoning` content is squashed into a truncated `status` line with a `"Reasoning:"` prefix; and `runtime.resume()` is a hack — it re-execs `codex` as a fresh prompt with no conversation history, so neither crash recovery (ADR-007) nor mid-stream re-prompting (validation correction, escalation response, rejection retry, nudge) actually continues the agent's session.

The asymmetry has a cost: Anthropic's Opus 4.7 tokenizer change makes effective per-request cost up to 35% higher than 4.6 even at the same per-token price, while GPT-5.4 is half the price of Opus 4.7. Codex pods are now economically attractive, but feel second-class — operators see no diff in the activity feed, no dollar figure on completion, mangled reasoning, and lose conversation context on every restart. That misalignment makes the runtime pick look more like a downgrade than a swap.

## Outcome

Codex pods are indistinguishable from Claude pods on the four user-visible properties: `file_change` events render in CLI watch + desktop on every edit, `AgentCompleteEvent.costUsd` carries a real dollar figure that lands in `pod.costUsd`, reasoning surfaces as distinct `reasoning` events (not status lines), and post-restart resume continues the same Codex session via `codex exec resume <id>` instead of re-spawning fresh.

## Users

- The autopod operator (Esben), running mixed-runtime fleets and wanting Codex's cost profile without the per-pod information loss.
- Future operators standing up Codex pods who don't have an existing "Codex feels second-class" mental model to overcome — they should land on parity behavior by default.
- The validation/recovery system itself (ADR-007's re-queue path): Codex recovery only works once `runtime.resume()` actually resumes.

## Success signal

A Codex pod run on a Docker-backed profile, followed by a forced daemon restart mid-stream, produces all four observables in one pass:

1. `file_change` events on every edit visible in `ap pod watch` and the desktop activity feed.
2. A final `complete` event carrying `costUsd > 0` and the resulting `pod.costUsd` non-zero in SQLite.
3. Reasoning surfaced as distinct `reasoning` events (rendered dim/italic in CLI, with the new event-type styling in desktop) rather than interleaved `status` lines.
4. The post-restart resume invokes `codex exec resume <captured-session-id>` (visible in container logs) and continues the same conversation rather than starting fresh — confirmed by the `pods.codex_session_id` column carrying the captured ID across the restart.

Observable #1 and #3 are gated by `cmd` ACs corroborating parser wiring plus Test expectations covering event shapes. #2 is gated by parser-side `costUsd` math (per ADR-026). #4 is gated by an integration case in `pod-lifecycle.e2e.test.ts` plus `codex-runtime.test.ts` coverage of the resume args.

## Non-goals

- **Copilot CLI parity.** Copilot has no structured JSON output upstream ([github/copilot-cli#52](https://github.com/github/copilot-cli/issues/52) still open). The current copilot parser stays as-is. The same `AgentReasoningEvent` variant we introduce here will be re-used when Copilot ships JSON, but we don't pre-build any handling.
- **Profile UI exposure of `codexSessionId`.** It's an internal pod field, the same way `claudeSessionId` is. No desktop screen, no CLI flag.
- **Backfilling historical Codex pod rows.** `codex_session_id` is NULL on existing pods, which is fine — those pods aren't running anymore and won't be resumed. Migration is forward-only with no data motion.
- **Codex on ACI as a separately-tested target.** Bind-mounts go through the `ContainerManager.spawn().volumes` contract uniformly. Whatever ACI does today for Claude bind-mounts, it does for Codex. If Claude resume on ACI is broken today, so is Codex resume on ACI; this spec doesn't widen or narrow that pre-existing state.
- **Per-pod cost overrides or runtime-time pricing edits.** Pricing JSON refresh policy is still ADR-015's manual-only stance.
- **Retiring `pod.costUsd` in favor of `effectiveCostUsd()` everywhere.** ADR-026 amends, not supersedes, ADR-015. The three known stragglers (`history-exporter.ts:233`, `quality-signals.ts:179`, `quality-score-recorder.ts:63`) self-heal once `pod.costUsd > 0` for Codex; no migration of read sites is in scope.
- **Removing the Swift `.output` case as a separate breaking change.** It's renamed-in-place to `.reasoning` (matches its actual current label `"Agent text output / reasoning"`).

## Glossary

- **`AgentReasoningEvent`** — new variant of the `AgentEvent` union in `@autopod/shared/types/runtime.ts`: `{ type: 'reasoning'; timestamp: string; text: string; isRaw?: boolean }`. Emitted for Claude `thinking` blocks (today dropped) and Codex `agent_reasoning` (today mapped to a truncated status line) and `agent_reasoning_raw_content` (today ignored). `isRaw: true` distinguishes Codex's raw-content variant.
- **Session ID** — for Codex, the UUID emitted on `session_configured.session_id` and used by `codex exec resume <id>` to continue an existing rollout file at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. For Claude, the analogous concept already exists as `claudeSessionId`.
- **Parser-side `costUsd` emission** — per ADR-026 (introduced here), runtimes without a native cost field compute `costUsd` at turn-complete via `computeCost(model, in, out)` from `@autopod/shared/pricing`. Model is captured from the runtime's session-config event. This is *additional* to ADR-015's `effectiveCostUsd` read-time path; it does not replace it.
- **Mid-stream re-prompting** — any call to `runtime.resume(podId, message, ...)` that isn't crash recovery: validation correction, escalation response, rejection retry, nudge. For Codex, today's behavior is "fresh exec with the message, no history"; after this spec, it continues the conversation (matching Claude). This is the intended parity definition.

## Reversibility

The work is mostly additive and forward-compatible. The one hard-to-reverse change is the `pods.codex_session_id` column added by migration `100_*`. Rollback would require dropping the column, which is destructive for any populated values. Forward path is safe: existing rows default to NULL, which the resume path treats as "session not yet captured — fresh exec." No backfill, no data motion.

The `AgentEvent` union widening (new `reasoning` variant) is non-breaking for consumers using non-exhaustive switches (CLI watch falls through to a generic JSON dump for unknown types) and surfaces compile errors for exhaustive consumers (caught at build time). Reversal: delete the variant; downstream parsers fall back to emitting `status` events with reasoning text inline.

ADR-026 amends ADR-015. Reversal would supersede ADR-026 with a follow-up ADR and revert the cost-computation lines in the parsers; `pod.costUsd` would resume reading as 0 for Codex pods and analytics would still work via `effectiveCostUsd`.
