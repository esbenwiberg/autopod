# R05b: preserve current desktop decision identity

## Scope and authorization

Bounded prerequisite to the selected Inline design's retained reply draft. The
user authorized autonomous RPI, workers, technical choices, pre-PR review and
campaign-branch integration. Root owns this plan; research is
`../research/2026-10-15-reply-draft-identity.md`. All phases form one authorized
task after independent technical plan review. Existing layouts and wording stay
as shown; this repairs which existing question survives asynchronous responses.
No draft persistence, new control, daemon/API change or automatic reply replay.

## Current facts

Native PodResponse and EventTypes carry escalation IDs. PodMapper and EventStream
drop them before PodStore/UI Pod. EventStream ignores a resolved event's ID and
unconditionally clears the question and sets Running. PodStore's status revision
protects lifecycle status from an already-in-flight response, but not decision
question/options/type. Older full detail can replace them too. Compact payloads
have no live escalation ID; finalization.pendingDecisionId only covers settlement.
A same-text question is not an identity. The newer compact merge clears unavailable
detail fields and rehydrates the selected pod; the apparently field-preserving
mergeCompactPod branch cannot process a newer row through its current caller.

## Desired behavior

A known unanswered detail/event decision retains its exact ID alongside its
question, type and options. Resolving decision A cannot erase displayed decision
B. A GET or fleet traversal started before a decision event cannot replace that
event's decision fields, including an explicitly cleared decision. Resolving a
question does not itself prove the next pod lifecycle state; status comes from
status events or refreshed REST. Unknown current model identity triggers existing refresh rather
than guessing a match. Other existing store merge and connection epoch semantics
remain intact.

## Phase 1: identity and event resolution

Files: `packages/desktop/Sources/AutopodUI/Models/Pod.swift`,
`Sources/AutopodDesktop/Mapping/PodMapper.swift`,
`Sources/AutopodDesktop/Stores/PodStore.swift`, and
`Sources/AutopodDesktop/Stores/EventStream.swift` under packages/desktop.

Add optional `escalationId` to Pod and both compatible initializers, default nil.
Map only an unanswered detail escalation's nonempty ID. Resolved/missing detail
maps nil. Compact maps nil even when finalization carries a settled ID; do not
mistake settlement metadata for a universally current decision. Preserve existing
question formatting and missing-field compatibility.

Extend setEscalation to accept optional ID/type with default nil, update the whole
decision group, and advance a per-pod local decision revision. Created events
supply actual ID/type/options. Resolution uses a dedicated store operation that
clears all decision fields only when its nonempty ID matches the currently known
ID; missing current model ID, empty supplied ID or mismatch leaves fields unchanged.
Raw malformed events with no escalationId remain dropped by the existing parser;
EventTypes is read-only and no decoder behavior change is promised. A successful clear advances
the revision. Do not set Running from resolution. EventStream requests the existing
best-effort refresh after every resolved event, matched or otherwise. That refresh
can establish authoritative status/decision after the event. No automatic mutation.

Use the internal EventStream construction seam for an injectable escalation
notification callback if required to exercise created events without posting OS
notifications. Public construction keeps the existing NotificationService path;
test construction supplies a recorder. Keep this narrow to escalation notifications.

## Phase 2: protect event decisions from stale REST

Use a store-monotonic sequence or non-reused token for decision revisions; a
per-pod counter reset on removal must not reuse an earlier request snapshot.
PodStore captures the decision revision alongside status revision before each
refreshSession and loadSessions suspension. When a newer decision event occurs,
merge the current ID/question/options/type as one group into the incoming pod.
The nil group after a matching resolution is also authoritative for this fence;
do not resurrect it from the held response. Preserve current decision fields when
a full detail payload's updatedAt is strictly older than the current pod, even
when allowing that payload to hydrate other fields. Do not change lifecycle
merge policy or invent a new global timestamp ordering contract.

Apply preservation to reachable compact and full merge paths. Keep revision
cleanup consistent with per-pod removal, and configuration ownership consistent
with existing epochs. A later request started after the event may reconcile the
server's current decision normally. A fresh newer compact response may leave
identity unknown until detail hydration; never carry an old ID beside a different
summary or derive identity from text. No compact wire field or helper cleanup
unrelated to this behavior.

## Phase 3: reproducible proof

Establish old-interface failing behavior before adding the production fix: held
full detail and compact traversal plus newer setEscalation must show replacement
of the newer question; raw resolved A while known newer B must show incorrect
clear/Running. Preserve baseline source/logs in ignored evidence, with exact SHA.
If ID assertions need the new interface, separate baseline observable text/status
from final identity assertions. No invented baseline verdict.

Use existing HeldRESTTransport/PodStoreLifetimeFixture patterns for private
synthetic APIs, bounded waits and complete request/task teardown. Add focused
DecisionIdentityTests and native DecisionIdentityRenderingTests. Exercise actual
mapping, store, wired EventStream socket callbacks and real DaemonAPI responses:

- Detail maps unanswered ID/type/options, resolves to nil, and accepts legacy
  optional fields; compact remains unknown even with finalization metadata.
- Created B followed by resolved A preserves all B fields and lifecycle until
  refresh. Resolved B clears the whole group without inventing Running; follow-up
  GET can report Validating, Running, or another AwaitingInput decision.
- Unknown-ID and duplicate resolved events neither clear another decision nor
  invent lifecycle. They use read-only refresh. Fresh authoritative GET can clear.
- Hold GET, then created B; return older/equal snapshot A or no decision: B survives.
  Hold GET, resolve B; return B: cleared fields stay cleared. Later fresh GET can
  adopt C. Include old full response arriving after a newer-timestamp current pod.
- Hold compact traversal, apply created/resolved event, return newer-timestamp
  compact snapshot: preserve the entire current decision group. Include selected
  rehydration and epoch replacement. Specifically test held GET at revision1,
  removal/reinsertion of the same pod ID, created B with a fresh token, then old A
  response: B survives. Clearing the per-pod dictionary must not reuse revision1.
  General deleted-row resurrection remains outside this task. A post-event
  selected hydration is a fresh request and may reconcile normally.
- Same question text with different IDs remains distinguishable. Independent pods
  retain independent revision ownership. Existing status/validation/selection
  assertions and R04c guards still pass.
- Shared DecisionResponseContractTests additionally assert mapped detail ID and
  compact unknown identity. No fixture/server/API content change is required.

Capture actual same-mounted DetailPanel/Overview at600 and900px while B is shown,
after stale A resolution/held REST, and after authoritative reconciliation. Native
text/accessibility plus request assertions must establish which question/options
are shown. Inspect every materially different image. Use private defaults and no
account startup, Keychain or notification posting. These are production component
claims; do not claim full-app acceptance, full compositor fidelity or human signoff.

Run focused new identity, existing decision/contract/fleet/lifetime/confirmed/inline
Swift tests; full `swift test --package-path packages/desktop --no-parallel`;
`swift build --package-path packages/desktop --product AutopodDesktopExe`;
Node22 secret scan and git diff check. Record skip accounting. Worker freezes
source/evidence; independent reviewer reads final diff, reruns races and inspects
captures before PR. Hosted general/native checks and integrated affected proof
must pass before closure.

## Plan review

Independent reviewer clarified unknown current model identity versus malformed
wire events and identified revision reuse after removal/reinsertion. Root adopted
unchanged parser behavior plus non-reused decision tokens and an explicit race
assertion. These are technical corrections within standing campaign authority.

## Acceptance and limitations

- [x] Pre-fix observable races reproduced with preserved logs.
- [x] Known identity retained and wrong resolution cannot clear another decision.
- [x] Held pre-event REST cannot replace or resurrect the decision group.
- [x] Unknown identity and later authoritative reconciliation covered.
- [x] Native question/option retention captures inspected.
- [ ] Independent pre-PR, hosted and integrated verification passed.

This local event/request fence is not universal cross-stream linearizability.
The wire has no decision revision on compact rows and timestamps are not unique.
Arbitrary reordered created events and equal-timestamp concurrent REST snapshots
are not newly guaranteed by this task. Draft persistence and expected-decision
binding on reply submission remain subsequent plans. No changes to reply API,
response acceptance, persistence schemas, automatic retries or draft clearing.
Human preference/signoff is not an automated acceptance item. Reverting this
bounded client change restores prior mapping/event behavior; no data migration.


## Worker implementation and proof (2026-10-15)

Production changes are limited to the four planned files. Pod stores optional
unanswered escalation identity; EventStream passes created identity/type and only
clears a matching resolution, then requests read-only refresh without inventing
Running. PodStore uses monotonic decision tokens and preserves the four decision
fields together across held REST and strictly older detail responses. Existing
configuration epochs and lifecycle merge policy remain unchanged.

Pre-fix regression source is preserved in commit `910586be` (production baseline
`36566b48`). The executable old-interface baseline failed both held detail/compact
cases and stale resolution: 2 test functions / 3 cases / 6 assertion failures.
The source and full log are retained under ignored `.autopod-data/reliability/r05b/`.

Final production/test source was frozen at
`6854b61c24beabafafb2273e7cf5f8f25c4ddba4`, after merging campaign `7565b084` including
R04d. Later changes to this plan only record evidence. No dependency changes or
fresh Swift cache were required; verification used Swift 6.3.3 and the existing cache.

| Material claim | Executed evidence | Result |
|---|---|---|
| Unanswered detail identity retained, compact/legacy identity unknown | DecisionIdentityTests and shared DecisionResponseContractTests | Passed |
| Created/resolved callbacks preserve the matching decision and observed lifecycle | Actual EventStream factory callbacks, private DaemonAPI GET barriers and injected notification recorder | Passed |
| Held detail/compact cannot replace or resurrect event decision fields | Older/equal/absent snapshots, resolution, removal/reinsert tokens, independent pods, selected hydration and epoch replacement | Passed |
| Existing native question/options survive stale A and adopt authoritative C | Same-mounted production DetailPanel/Overview, 600 and 900px, six PNGs plus accessibility text/frame checks, one mount and three GETs per case | Passed; all six images inspected |
| Broader native compatibility | Affected run 47 Swift Testing functions / 6 suites; full run 447 Swift Testing functions / 19 suites plus 13 XCTest cases | Passed; affected run zero skips, full run skips the existing opt-in live test |
| Executable and repository checks | AutopodDesktopExe build, Node22 secret scan, git diff check | All exit 0 |

Exact reproducible commands (run from repository root):

```sh
AUTOPOD_DECISION_RENDER_DIR="$PWD/.autopod-data/reliability/r05b/native" swift test --package-path packages/desktop --no-parallel --filter 'DecisionIdentity|DecisionResponseContract|ReplyDecisionRetention|PodStoreFleet|PodStoreLifetime|confirmedAction|confirmedKill|InlineControl'
swift test --package-path packages/desktop --no-parallel
swift build --package-path packages/desktop --product AutopodDesktopExe
npx -y -p node@22 -p pnpm@9.15.4 -c 'pnpm secret-scan'
git diff --check
```

Ignored receipts are `proof.json` (source/image/log SHA-256 mapping),
`baseline.log`, `focused-final.log`, `full-swift-final.log`, `build-final.log`,
`secret-scan-final.log`, and `native/detail{600,900}-{current-B,after-stale-A,reconciled-C}.{png,ax.txt}`.
The Swift Testing runner reports function counts; parameterized cases are additional.
Full-run lines 449–450 explicitly skip `LiveVillageConnectionTests` and its
`configuredDaemonReachesStoresEventsAndBundledVillage()` test (one existing opt-in
live test, not two skipped tests). Lines 43–46 separately report 13 XCTest cases
passed. The previous worker summary incorrectly said zero skips for the full run;
this accounting correction does not change source, tests, captures or results.
Known warnings include AppKit's deprecated enhanced-accessibility selectors in
native fixture construction and the existing unused AppRootView capture.

This is component-composition proof using production SwiftUI views, mapped store
state and real DaemonAPI decoding against a private held transport. It does not
start the production account/bootstrap, post OS notifications, navigate Work/Logs,
activate reply controls, prove full compositor fidelity, or establish draft
retention/reply acceptance. The existing EventStream event-refresh Task is not
joinable by the fixture; successful assertions await its state, and teardown
invalidates the store epoch, disconnects the controlled socket and releases all
private requests/sessions. Independent pre-PR review, hosted checks and integrated
verification remain root-owned pending gates.
