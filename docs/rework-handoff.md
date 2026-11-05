# Rework handoff

Ordinary coding Rework keeps the task and preserved work, provisions a fresh
container and may spend more task tokens. The desktop handoff loads authoritative
retry eligibility before enabling either the footer or budget continuation.
Refresh after a cooldown or a recorded decision. This display is not a lease:
server admission rechecks lifecycle, custody, settlement and retry facts.

“Guidance for this continuation” is optional and separate from the required reason
for “Authorize one retry”. Guidance supplements the frozen task; it does not
change scope, configuration, permissions, retry authority or publication approval.
A recorded authorization permits one eligible retry of the displayed failure and
provider binding. It does not bypass cooldowns or other admission gates. Rework
remains a separate explicit action. Consumed or superseded grants are not usable.

Guidance is saved atomically with the authenticated human's Rework request, bounded
to 16,000 characters, and delivered by the existing operator guidance queue to the
current worker. Reading returns a durable receipt; acknowledgment records receipt,
not proof that the guidance was applied. Unread guidance retains the existing
completion hold. Rework does not depend on restoring the previous conversation.
Resume delivery and Revalidate remain agent-free. Workspace Restart, PR feedback,
native Goal controls and retained/source-owned checks keep their specialized paths.

## API and compatibility

- `GET /pods/:podId/rework-v1/eligibility` projects `eligible`, `grant_recorded`,
  `authorization_needed`, `cooldown` or `blocked`, with reason, lifecycle generation
  and displayed failure ID. Inspection does not reserve an execution or use a grant.
- `POST /pods/:podId/retry-authorizations` accepts the existing requestKey/reason/stage
  fields plus optional `expectedFailureId`. New clients send the displayed failure
  ID. A stale new decision is rejected; replaying the same stable key observes the
  original decision even after a later failure. Existing clients omitting the
  field retain their historical latest-failure behavior. Provider-bound one-use
  admission remains in the existing task retry ledger.
- `POST /pods/:podId/rework-v1` accepts only `{requestKey, generation, guidance}`.
  `requestKey` is a stable UUID; empty guidance queues no message. The actor is
  derived from authentication. First acceptance returns 202; exact replay returns
  200 and the recorded receipt, without dispatching again. Changed payload/actor
  replays conflict. Stale lifecycle requests fail before storing guidance.
- `GET /pods/:podId/rework-v1/requests/:requestKey` observes a durable receipt.
  `settledAt` describes **dispatch** settlement, not worker completion. `error`
  records a dispatch failure; accepted guidance remains saved.

The versioned endpoint is mandatory for guidance. A missing/older daemon disables
ordinary desktop Rework; clients must never fall back to `/validate` and drop the
body. Legacy `/validate` remains available for existing clients and workspace
Restart, but cannot dispatch while a durable Rework request is unresolved.
The CLI client exposes the versioned methods and optional expected failure binding;
existing CLI commands retain their existing behavior.

The desktop saves authorization and Rework request drafts by daemon URL, full pod
ID and stage, and guards execution against connection changes and concurrent
clicks. Rejected drafts remain available for revision. Uncertain submissions never
automatically repeat. Use **Check latest state** to inspect the request and observed
pod state. Authorization can explicitly retry recording the same decision key;
this never starts Rework. Only after a settled dispatch and a terminal observed
pod may the operator deliberately review another attempt.

## Interrupted dispatch

The request and queued guidance commit before asynchronous workspace preservation
or teardown begins. A daemon crash can therefore leave an unresolved receipt,
including a crash before dispatch starts. It is deliberately not a replayable
execution ticket. Reposting the same request only observes it, and other Rework
requests remain blocked while it is unresolved. Inspect the receipt, lifecycle,
worker/validation settlement and custody evidence before operator recovery. This
change adds no automatic crash replay, journal-unlock or live recovery grant.
Do not infer that a null `settledAt` means no worker ran, and do not clear the
journal to make an uncertain execution repeat.

## Native qualification (Mac required)

Linux build and TypeScript tests do not qualify SwiftUI, AppKit or native transport.
On a Mac run:

```sh
cd packages/desktop
swift build
swift test --filter 'ReworkTransportTests|versionedRework|TaskRetryClientTests|retryClient|PodRepairReworkTests|PodRepairResumeTests|FollowUpTests'
swift test
xcodebuild -project Autopod.xcodeproj -scheme Autopod -configuration Debug -destination 'platform=macOS' build
```

Verify both submit entries, explicit authorization, unavailable/older daemon,
connection change, response loss and reopening the handoff. Inspect provisioning
and observed worker-running state separately from request acceptance.
