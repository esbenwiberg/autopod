# ADR-032: Prompt-only helper containers for daemon LLM helpers

## Status

Proposed

## Context

Autopod already has live pod container reviewer paths for validation,
pre-submit review, advisory browser QA, and memory ranking. Some daemon-owned
best-effort helpers still call provider APIs directly from the daemon, notably
PR title/body generation and auto-commit message generation. When those direct
daemon calls hit provider rate limits or credential gaps, the user sees template
or heuristic fallback even though the pod's authenticated container runtime may
be able to run Claude or Codex successfully.

The helper work remains daemon-owned. ADR-001 keeps the daemon authoritative for
worktrees, git operations, pushes, and PR creation. Moving PR creation into the
pod would make ownership and sanitization worse. The need is narrower: run the
LLM part of daemon helper work through the authenticated container runtime first.

Some helper work happens after the main pod container has stopped, such as
approval retry PR creation. Persisting generated PR metadata before shutdown
would cover only part of the problem and would introduce a durable helper-output
contract. The selected v1 shape is a short-lived, prompt-only helper container
for post-container helper work.

## Decision

Best-effort daemon LLM helpers use container-local execution before daemon API
or deterministic/template fallback.

The stage order is:

1. live pod container, when one is available and running;
2. short-lived prompt-only helper container, when the caller allows
   post-container helper execution;
3. daemon API fallback, when the profile/provider supports it;
4. deterministic/template fallback.

Prompt-only helper containers support both `local` Docker and `sandbox`
execution targets by using the existing `ContainerManager` interface. They
receive only daemon-computed prompt context. They do not mount the repo, copy
the workspace, start preview sidecars, expose app ports, or sync files back.
They receive the same reviewer/provider auth environment and secret-file inputs
used by live pod reviewers, then they are cleaned up after the prompt finishes
or fails.

Helper container token usage is attributed to a first-class harness phase named
`helper`. Cost breakdown gains a `helper` bucket. Blocking validation review,
deep review, and pre-submit review are not migrated to the helper phase; they
keep their existing validation semantics and `review` attribution.

Pod activity remains final-degradation-only. Intermediate live-container or
helper-container failures are structured logs. Activity is emitted only when the
final output the user receives is deterministic/template fallback, such as PR
metadata template fallback or memory deterministic fallback.

## Consequences

Easier:

- PR metadata, auto-commit messages, memory ranking, advisory helpers, and
  ask_ai-style helpers can avoid daemon-side provider rate limits when the
  container runtime is authenticated.
- Post-container retry flows still have a container-local option without moving
  git or PR authority into pods.
- Prompt-only input keeps helper containers simple and avoids persisted PR
  metadata or helper-output storage.
- Local Docker and sandbox targets share the same helper contract.

Harder:

- Helper-container spawn, auth injection, timeout handling, and cleanup must be
  reliable on both Docker and sandbox backends.
- The `helper` phase is a shared analytics contract that must be reflected in
  shared types, cost aggregation, cost breakdown, and clients that display
  phase cost.
- Helper call sites must precompute enough prompt context because helper
  containers cannot inspect repo files.
- Structured logging needs enough stage detail for diagnosis because
  intermediate helper failures are intentionally not pod activity.

Committed to:

- The daemon remains authoritative for git, worktrees, pushes, and PR creation.
- Helper containers are prompt-only in v1.
- Daemon API fallback remains available in v1.
- Blocking validation review remains validation, not helper.
- Pod activity reports final user-visible fallback, not every intermediate
  helper-stage failure.

## Alternatives rejected

- **Daemon API only.** This preserves the exact failure mode where direct daemon
  provider calls rate-limit and cause template fallback.
- **Move PR creation into pods.** This conflicts with ADR-001 and makes git/PR
  ownership, sanitization, and policy enforcement harder.
- **Persist generated PR metadata before shutdown.** This adds a durable storage
  contract and covers only PR metadata, not auto-commit, memory, advisory, or
  ask_ai-style helper calls.
- **Mount or copy the repo into helper containers.** This widens the execution
  surface and complicates sandbox support. The daemon can compute the needed
  diff/context and pass it in the prompt.
- **Show every fallback stage as pod activity.** This would make pod timelines
  noisy and obscure the final user-visible degradation. Logs are the right place
  for intermediate stage failures.
