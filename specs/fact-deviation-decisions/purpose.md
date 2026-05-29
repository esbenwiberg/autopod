# Fact Deviation Decisions

## Problem

Two related Autopod attention paths are currently too noisy or too implicit.

First, `report_blocker` is intended to let the agent record infrastructure or
environment blockers without immediately stopping useful work every time. The
current implementation creates an escalation and the daemon bridge treats every
`report_blocker` like a human-blocking request, so below-threshold blockers can
park a running pod in `awaiting_input` and make the UI say "Agent needs input"
even when the tool response tells the agent to continue.

Second, required-fact deviations are recorded by agents through task summaries,
but the human decision path is still a one-off "approve waiver" flow. That flow
does not match the domain model anymore: a human may waive a required fact, use
replacement proof, or enforce the original fact. The operator also needs to be
clearly told when fact decisions are pending, decide all pending facts, and run
validation once after the complete batch.

## Outcome

Below-threshold `report_blocker` calls are stored for logs and analytics without
parking the pod, while required-fact deviations become explicit human decisions
in the daemon API and desktop UI: `Waive Required Fact`, `Use Replacement Proof`,
or `Enforce Original Fact`, applied as a complete batch before one revalidation.

## Users

Esben as the Autopod operator. The affected user experience is the pod detail
surface in the macOS desktop app and the daemon-backed validation workflow that
decides whether a pod can continue.

The agent is also affected indirectly: below-threshold blocker reports should
let it continue, and unavailable required-fact commands should be logged clearly
for the human while preserving the existing agent feedback that asks for a
`factDeviations` request.

## Success Signal

A pod that reports an infrastructure blocker below the auto-pause threshold keeps
running with no `pendingEscalation`, and a pod with pending required-fact
decisions shows a clear desktop attention state where the operator must choose a
domain decision for every pending fact before one batch revalidation runs.

Brief 01 proves the nonblocking blocker behavior with MCP and daemon bridge unit
tests. Brief 02 proves the backend batch API, decision mapping, one-revalidation
behavior, and unavailable-command activity logging with daemon route/manager/
validation tests. Brief 03 validates the native desktop experience with human
review, because Autopod-self required facts run in Linux pods and cannot execute
SwiftUI/AppKit tests.

## Non-Goals

- CLI support for fact-deviation decisions.
- Backward compatibility for `POST /pods/:podId/facts/:factId/approve-waiver`.
- New pod statuses, state-machine changes, or database migrations.
- Changing the existing internal task-summary decision enum unless implementation
  absolutely requires it. The public API and desktop copy should use the domain
  terms even if the validator continues to consume `approved_waive`,
  `approved_replace`, and `rejected`.
- Special final-fail behavior when `enforce_original_fact` reruns an unavailable
  command. The validator should keep current semantics; this plan only adds
  clearer user-visible logging for unavailable commands.
- Adding profile settings or making fact-decision policy configurable.

## Glossary

- **Report blocker** - The `report_blocker` MCP tool call. It records a blocking
  issue from the agent. Below the auto-pause threshold it is only a stored
  blocker record; at threshold it becomes a human-blocking escalation.
- **Auto-pause threshold** - The profile/pod threshold that decides when repeated
  `report_blocker` calls should actually pause for human input.
- **Human-blocking escalation** - A request that calls the daemon
  `notifyEscalation(...)` path, can move the pod to `awaiting_input`, and sets
  `pendingEscalation`.
- **Fact deviation** - An agent-reported request in `taskSummary.factDeviations`
  explaining that a required fact cannot be satisfied as written or should be
  replaced by alternate proof.
- **Waive Required Fact** - The human decision to accept that a required fact is
  impossible or inappropriate for this run. Public API action:
  `waive_required_fact`; internal validator decision: `approved_waive`.
- **Use Replacement Proof** - The human decision to accept replacement proof
  supplied by the agent. Public API action: `use_replacement_proof`; internal
  validator decision: `approved_replace`.
- **Enforce Original Fact** - The human decision to reject the deviation and run
  the original required fact. Public API action: `enforce_original_fact`;
  internal validator decision: `rejected`.
- **Unavailable command** - A required-fact command that exits `127` because the
  command is missing from the validation container, such as `swift` in the Linux
  Autopod-self pod image.

## Reversibility

The plan has no database migrations and no on-disk format migration. The API
change intentionally removes the old waiver endpoint/client method because the
operator does not need backward compatibility. Rollback is code-only: restore the
old endpoint/client and remove the batch decision route if needed.
