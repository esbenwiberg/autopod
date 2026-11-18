# Retained memory-failed checks

The desktop memory case uses the existing retained-checkpoint infrastructure
request, claim, source custody and validation admission. It never uses Resume,
starts a coding segment, grants retry permission, resets accounting or delivers
changes. A passing result stops at validated for separate human approval.

Both failed and review-required are supported only for an ordinary local Docker
task with an attributable completed retained checks-only predecessor. Other
review-required infrastructure failures do not acquire this permission.

Inspection is read-only. A candidate execution profile is a configuration preview,
not proof that its actual allocation improves memory. Confirmation saves one exact
request before submitting it. After a lost reply, the desktop observes that request;
it never automatically retries a POST or invents a replacement key. The existing
read-only infrastructure handoff remains available for operator investigation.

## Evidence boundary

The initial collector supports direct Node tests using `node [--max-old-space-size=N]
--test --experimental-test-isolation=none path/to/test.js` (also the stable
`--test-isolation=none` spelling on Node versions supporting it). An optional
command-local `NODE_OPTIONS='--max-old-space-size=N'` is preserved, including its
precedence relative to CLI flags. Paths are literal, without shell expansion.
Package-manager scripts, arbitrary shell expressions, preload hooks, isolated
workers and other process families remain unavailable. These are deliberate
evidence limits, not reasons to rewrite a repository's frozen test command.

Before execution a command-specific probe runs the same Node invocation's heap
flags and environment in the actual container. Effective container memory is the
minimum of the observed Docker allocation and Node's cgroup-constrained memory.
A daemon-installed preload then records the real test process's initial heap,
constraint and PID before test code, refusing a changed measurement. A prospective
failure receives heap evidence only when its fatal V8 diagnostic matches that PID.
Array-buffer failures, unclassified kills, a child process's fatal diagnostic, and
legacy failures without measurements cannot establish this heap-specific path.

The failed immutable checked result retains the prospective measurements. A new
request binds that result, actor, task/generation, exact commit/tree, commands,
configuration preview and stable request ID. Admission requires strictly more
effective heap, no smaller effective container limit, and container headroom above
the candidate heap. Actual allocation ownership, source, actor and existing retry
permission are checked before dispatch; the engine repeats measurement immediately
before tests. Passing certification requires actual test-process evidence and a
current resource/source observation. Configured GB alone never establishes these
facts. No automatic sizing or additional spending authority is introduced.

## Verification limits

`retained-memory-checks-recovery.test.ts` uses real SQLite migrations/repositories,
real independent retained Git checkouts, and the production pod controller. Docker
allocation/transport, the check runner and independent reviewer are deterministic
doubles. It proves controller policy, custody, admission and replay behavior, not
live Docker allocation, provider availability, actual memory exhaustion or reviewer
quality. `test-process-memory.test.ts` runs real bounded local Node processes to
check heap-option precedence and process correlation; fatal diagnostics are
synthetic. No live recovery or cloud provisioning is part of these proofs.

Native model tests cover candidate review, unavailable evidence, pending requests
after lost replies, and stale generation/connection. Linux cannot execute these
macOS tests or establish rendered visual fidelity. Mac CI must run
`scripts/test-desktop.sh` for the exact submitted revision. The reference PNG was
visually inspected and the companion HTML was read as text; no HTML renderer was
available. Neither reference is shipped.
