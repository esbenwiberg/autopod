# Recover transient Azure Sandbox 403 failures

## Problem

Azure Container Apps Sandboxes' preview data plane can return repeated empty HTTP 403
responses even when the daemon identity and adjacent operations are valid. Autopod already
retries these responses at the transport layer, but after exhaustion it misclassifies the
incident as an unknown agent failure, produces misleading readiness risk, and makes Resume
skip an original task that never ran.

## Outcome

Autopod performs one safe fresh-sandbox recovery for a proven pre-agent transient empty-403
failure, then exposes a truthful, resumable Azure infrastructure failure if recovery does not
succeed.

## Users

Operators running Autopod pods on the Azure Sandboxes execution target, especially series
whose downstream work should not be blocked by a transient provider incident.

## Success signal

A pod whose first sandbox exhausts empty-403 retries before agent execution automatically
provisions one different sandbox after 30 seconds and runs its original task; a repeated or
unsafe failure stops without a loop and is presented as Azure infrastructure unavailable.

## Non-goals

- Increase request-level retry attempts.
- Retry deterministic RBAC denial.
- Add pod states or profile settings.
- Automatically reroute regions or execution targets.
- Restart work after agent execution became observable.
- Add a fleet-wide circuit breaker or new client UI.

## Glossary

- **Empty 403** — an HTTP 403 data-plane response with no response body and only allowlisted
  diagnostic headers.
- **Transport retry** — the existing bounded retry of one Azure HTTP operation.
- **Fresh-sandbox recovery** — deletion of the old sandbox followed by a new sandbox using the
  same safe host worktree.
- **Agent execution evidence** — a runtime-yielded event, native session, provider accounting,
  task summary, or other durable signal that the worker may have acted.
- **User-initiated run** — an initial pod run or an explicit Resume/Rework, each with one
  automatic fresh-sandbox recovery budget.

## Reversibility

The schema change is additive. Runtime behavior can be reverted without rewriting existing
rows; older binaries ignore the nullable failure JSON and defaulted counter.
