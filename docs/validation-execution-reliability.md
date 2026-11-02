# Validation execution reliability

Sandbox self-validation (`validate_locally` setup/build/test/lint) and final validation
share the same command executor. Sandbox commands stream stdout and stderr, retaining
at most 50,000 characters per stream, and await the native exit result. Local Docker
validation retains buffered execution. Both paths forward the configured working
directory, phase deadline in milliseconds, and scoped environment unchanged. Secret
file variables still use the agent shim; commands are not reconstructed from secrets.
Self-validation continues to emit activity and refresh its heartbeat while running.

Like final validation, self-validation reapplies matching admitted **literal** build
environment values inside the child argv after transport/user wrappers. Secret
references and resolved credentials remain in the scoped exec environment, never
in the readable staged command. Daemon-owned overrides retain precedence. See
[toolchain environment](final-validation-toolchain-env.md).

A missing exit, timeout, or transport failure remains a failed/unverified check with
partial output. Cleanup confirmation is not a test exit or permission to repeat a
command. No retry budget, timeout setting, retained evidence, or recovery fence changes.
See [timeout evidence](validation-timeout-recovery.md) and
[execution recovery](validation-execution-recovery.md) before handling unknown outcomes.

## Cancellation authority

Ordinary Azure streaming wrappers publish a private PID/start-time receipt before
dropping root to `autopod`. The drop uses `su --session-command` to retain the owned
process group. Cancellation explicitly requests root authority, checks leader start
time and process group, then uses bounded TERM/KILL and live-member confirmation.
Receipts are created exclusively so preexisting files or symlinks cannot be overwritten.
Elevated signalling accepts only a regular, non-symlink root-owned receipt with mode
0600. For a private receipt owned by the canonical non-root `autopod` user, the cleanup
dispatcher drops to that user before checking and signalling the group. Worker receipts
never authorize root signals; other ownership or permissions fail closed. Missing,
unreadable, or stale receipts fail closed. The cleanup request is single-attempt and
bounded to five seconds. A provider that rejects concurrent buffered cleanup reports
that failure; it does not silently retry or establish success.

## Qualification

Run `validation-process-cleanup.test.ts` on Linux. Its cross-UID cases require a
**disposable** root-capable fixture with an existing non-root `autopod` user; the tests
never elevate the runner. They check receipt privacy, non-root child group membership,
forged-receipt rejection and actual termination. Also run as non-root to retain
same-user cleanup coverage. Skipped Linux/root-only cases on macOS are not qualification.

Run the streaming executor and pod-bridge regressions, then ordinary lint, build,
extended `pnpm typecheck` and the complete `pnpm test` with native SQLite available.
Normal build declarations do not replace extended typechecking. The large pod-manager
suite tracks every local in-memory SQLite fixture and closes open databases after each
test, including failures. Detached recovery tests await their actual validation promise
before teardown; sleeps are not synchronization.

Real Azure qualification must separately verify streaming dispatch, scoped environment,
long-running output and timeout cleanup on the deployed image/provider, including
concurrent buffered cleanup rejection. Local Linux fixtures cannot establish those
backend capabilities, settle historical ordinary validations or waive review/delivery
gates. The retained live-haddock source (`cf7682f8`) was recovered for local integration;
its historical failed/unavailable full-check and review receipts remain unchanged.
