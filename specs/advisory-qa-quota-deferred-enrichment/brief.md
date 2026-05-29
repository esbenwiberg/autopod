---
title: "Defer advisory QA and PR enrichment across reviewer quota limits"
touches:
  - packages/daemon/src/validation/advisory-browser-qa-runner.ts
  - packages/daemon/src/validation/advisory-browser-qa-runner.test.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/worktrees/pr-manager.ts
  - packages/daemon/src/worktrees/pr-manager.test.ts
  - packages/daemon/src/worktrees/ado-pr-manager.ts
  - packages/daemon/src/worktrees/ado-pr-manager.test.ts
  - packages/daemon/src/worktrees/pr-description-generator.ts
does_not_touch:
  - packages/desktop/
  - packages/escalation-mcp/
  - packages/shared/src/types/profile.ts
  - packages/daemon/src/pods/state-machine.ts
---

## Task

Make advisory browser QA and PR title/body generation survive reviewer-provider
429s by deferring them as nonblocking enrichment work instead of permanently
falling back or exhausting a short inline budget.

When blocking validation passes, the pod must remain approvable and mergeable
even if advisory QA is waiting for reviewer quota. When PR title/body generation
hits a quota/rate-limit error, create the PR with provisional template content
and schedule a later enrichment retry that updates the PR once reviewer quota
clears.

Also restrict advisory browser QA to scenarios that can honestly be tested in
the running app: scenarios covered by `browser-test` facts plus explicit
`human_review` items. Unit-test-only adapter/config scenarios must not become
browser QA targets.

## Why

`willing-reindeer` showed the failure mode clearly: pre-submit review and
validation review consumed the profile's reviewer quota, PR title/body
generation fell back with `api_call_failed`, and advisory browser QA immediately
hit 429s. Advisory then spent its visible activity on quota waits for scenarios
that were mostly adapter/config behavior proven by unit tests, not browser
flows.

Advisory and PR narrative are valuable, but they are not reasons to hold a pod
hostage. They should be eventual enrichment that waits for quota to recover.

## Touches

Update advisory target selection and retry behavior in
`packages/daemon/src/validation/advisory-browser-qa-runner.ts`. Add stage-level
progress logs for browser capture, action planning, image review, structured
fallback, quota waits, and deferred retry scheduling.

Update validation/pod orchestration in `packages/daemon/src/validation` and
`packages/daemon/src/pods/pod-manager.ts` so advisory quota waits can persist as
background/nonblocking work. Approval and merge flow must not wait for advisory
reviewer quota.

Update GitHub and Azure PR manager paths so quota/rate-limit failures from PR
title/body LLM generation create provisional template PRs and schedule deferred
PR enrichment. The deferred retry must update the existing PR title/body once
quota clears.

Add or update focused daemon tests named after the contract scenarios.

## Does not touch

Do not add a new pod lifecycle status. Do not change `PodStatus`, state-machine
transitions, or profile fields. Avoid desktop changes unless existing event
serialization is insufficient; prefer existing pod activity and validation phase
events.

Do not retry non-quota provider failures forever. Invalid LLM output,
unavailable credentials, unsupported provider surfaces, and non-rate-limit API
failures should keep their current fallback/error behavior unless a narrow
change is required to distinguish quota.

## Constraints

`docs/decisions/ADR-027-advisory-browser-qa-evidence-not-validation.md` governs
the behavior: advisory browser QA is evidence only and must remain nonblocking.

`packages/daemon/src/pods/pod-manager.ts` already emits
`Approval continuing while advisory browser QA runs...`; preserve that intent.

The current 8-minute advisory budget may be increased only because advisory is
not blocking approval/merge. Prefer a durable retry horizon such as 30-60
minutes over a long sleep inside the validation call.

Respect killed/killing/terminal pod states before retrying advisory or updating
a PR. Do not keep containers alive indefinitely after a pod has been killed,
completed, superseded, or otherwise made ineligible for enrichment.

If no browser-testable advisory targets exist, record a clear advisory skip
reason and avoid calling the reviewer model.

## Test expectations

Add or update targeted tests so the contract facts are proven with narrow test
filters:

- `advisory-quota-deferred`: advisory quota errors record pending quota state,
  schedule a retry, preserve passing validation, and emit target/stage activity.
- `approval-not-blocked-by-advisory`: approval/PR/merge flow can continue while
  advisory is pending reviewer quota.
- `pr-narrative-deferred`: GitHub and Azure PR creation use provisional content
  on quota, then deferred enrichment updates title/body after quota clears.
- `advisory-targets-browser-testable`: unit-test-only scenarios are excluded
  from advisory targets while browser-test facts and human review items remain.
- `no-browser-targets-skip`: when there are no browser-testable targets,
  advisory records a skip and makes no reviewer model call.

## Risks / pitfalls

Do not convert advisory uncertainty into validation failure. The blocking
validation result remains the safety gate.

Avoid spinning endless timers in memory without persistence or clear lifecycle
ownership. If the existing daemon has no durable background-job abstraction
appropriate for this, implement the smallest daemon-owned mechanism that can be
tested and that stops cleanly for killed/terminal pods.

Be careful when updating PR bodies: preserve existing validation/evidence
sections and avoid overwriting user or reviewer edits unnecessarily.

## Wrap-up

Before finishing:
1. Run the contract fact commands from `contract.yaml`.
2. Run `npx pnpm --filter @autopod/daemon test` if the touched surface is broad.
3. Run `npx pnpm build` if exported types or package boundaries change.
4. Commit and push.
