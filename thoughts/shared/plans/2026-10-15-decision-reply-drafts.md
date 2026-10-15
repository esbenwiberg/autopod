# R04f: preserve decision reply drafts and report submission honestly

## Scope, prerequisites and authority

Retain existing question replies through detail/card unmount, connection loss and
same-source reconnect. Preserve text until the daemon acknowledges the request;
never label an HTTP failure as proof that nothing was accepted. User selected
Inline status, authorized autonomous RPI and workers, and saw inline wireframes
for reconnecting, sending and unconfirmed delivery before product changes.
This is the final bounded desktop draft slice of the campaign, not a new messaging
capability. Root owns synthesis. Independent technical plan review precedes work.

Depends on R05b exact observed decision identity and completed R04e source/handler
ownership. R04e is still implementing; do not implement overlapping production
files before its integration. A private baseline-only native test can be developed
on current campaign source first, then merged with R04e before the fix. Root must
reconcile exact source/token API names with the integrated R04e implementation.

Selected scope is known escalation replies in Overview and card reply/approval
surfaces. Paused Resume guidance, Nudge, rejection feedback and existing request-
keyed retry journals remain separate unchanged operations. No on-disk drafts,
server/API/schema changes, automatic resending, receipt endpoint or new navigation.
Retention lasts for the current app process. Saved UUID/endpoint is not a daemon
incarnation. The existing message endpoint has no expected-decision parameter;
client checks cannot eliminate a server decision change between admission and POST.

## Current behavior and intended result

OverviewTab holds replyText in local State and clears before async Void reply.
SessionCardFinal has independent local text and clears/dismisses before completion;
its explicit Cancel discards text. Options and action-approval buttons also use
Void reply. A missing weak handler returns normally; HTTP can fail after durable
answer acceptance; refresh failures are swallowed. These facts are in
reply-draft-identity and reply-acceptance-boundary research. Root reread complete
OverviewTab, SessionCardFinal, PodActions, ActionHandler and PodStore.

After this change, both reply surfaces refer to one app-owned draft per exact
source/pod/decision. Typing, closing a detail tab and reconnecting preserve it.
A different decision or source never inherits it. A pending attempt is distinct
from confirmed pod status. Only successful HTTP acknowledgement may clear the
submitted revision. Errors preserve text and explicitly describe delivery as
unconfirmed; neither a successful refresh nor disappearance of the question is
an answer receipt. Resubmission is always an explicit user action.

## Phase 1: establish original behavior

Use existing private held REST and native decision fixture patterns, with actual
production Overview and a real field editor. Type a unique synthetic reply,
unmount/remount that surface for the same pod/decision, and observe text loss.
Also submit through the field's native Return path, hold POST, then fail it and
observe the original early clearing. Record exact unchanged source, failing
assertions/logs and captures before changing production. Baseline assertions must
observe actual field contents and actual held request, not only copied functions.

Private URLSession protocols must fail closed; no account startup, Keychain,
UserDefaults.standard writes, system keystrokes or external daemon. Serialize
native cases, restore process accessibility/defaults, release and join owned work,
close windows and invalidate sessions. Use bounded observable waits.

## Phase 2: shared draft ownership and outcome-aware submission

Own PodStore plus a small dedicated decision-reply store/helper if useful,
ActionHandler and narrowly scoped AutopodUI model/PodActions additions. Avoid a
generic command framework. Reuse R04e source identity/comparison exactly.

Key drafts by saved UUID (or R04e endpoint fallback), endpoint, pod ID and exact
nonempty escalation ID. Exclude configuration generation so reconnect retains
text. Never key by question text, status or nil decision ID. Keep storage app-
owned across handler replacement; do not create/mutate storage during View.body.
A snapshot/read closure is side-effect free; typing or explicit prepare/submit
creates state. Expose only the small view-facing snapshot/binding contract needed
for text, readiness, pending attempt and notice. Source binding remains captured
by actions; stale callbacks cannot read/write a replacement source's draft.

Draft reads/edits can continue while disconnected for the same retained source
and exact observed decision. Submission requires current R04e action ownership,
matching current source/pod/decision and awaiting-input eligibility. Capture the
key and answer synchronously on activation, then own the attempt before its first
await. Before every POST, perform a result-bearing, revision-aware detail refresh
and recheck that captured ID is still current. The actual detail response must
also name that same unanswered ID: a mismatching response stops submission even
if revision-aware merge preserves another current model. Carry this outcome from
the shared refresh helper without bypassing its merge. Distinguish preflight
admission from POST admission; uncertainty begins only once POST may be sent.
A failed preflight or changed ID is
not-admitted (no POST), preserves text and reports that the reply was not sent.
This reduces stale-cache exposure after reconnect but does not close GET-to-POST
server races. Verify ownership again inside the task before each API admission. Do not overload the legacy Void reply
used by paused guidance: add an explicit decision submission action with a typed
acknowledged/unconfirmed/not-admitted outcome. Missing-handler/default closures
must return unavailable/not-admitted, never pretend success.

Own each attempt independently of a view/caller lifetime. Admit at most one active
attempt per draft key across Overview/card and replacement handlers. Publish its
identifier and record-instance identity synchronously before awaiting; a duplicate invocation joins or returns
pending without POSTing. Caller cancellation/unmount must not cancel shared work.
The task retains captured source, decision, record identity, text revision and
handler generation. Record/revision identifiers must not repeat after deletion,
discard/recreation or pod removal/reinsertion; key equality alone is insufficient.
Clear pending state only for that attempt; release references after settlement.
No cross-pod blocking or hidden retries.

On HTTP acknowledgement, clear only the submitted text revision if the same
current authority/decision still owns it. New text entered while pending must not
be erased. Record acknowledgement separately from pod status and perform the
existing best-effort detail refresh. Publish acknowledgement and revision cleanup
immediately after200, before awaiting that optional refresh; a held GET must not
leave the notice saying sending/unconfirmed. Keep task cleanup distinct from the
HTTP acknowledgement state. Do not send the same acknowledged decision
again merely because a stale/failed refresh still displays it; show waiting for
updated question. A later question gets an empty independent draft.

On POST error, or superseded ownership after an admitted request, retain captured
text and report delivery unconfirmed. Newer edits must remain intact. A best-effort
current-generation refresh may reconcile displayed state, but cannot establish
acceptance of this answer. Do not automatically replay after reconnect, refresh,
remount or an error. Explicit manual resend may proceed only for the still-observed
same decision with current authority, and keeps the uncertainty warning visible
until the new attempt starts. Client validation is not server-side decision CAS.

An obsolete attempt must not refresh or mutate a replacement source/pod/decision;
it may settle only its own draft-attempt bookkeeping, retaining unconfirmed text.
If the same source reconnects while an old attempt remains in flight, the shared
pending owner prevents a second POST; its eventual obsolete result cannot clear
the retained draft. Different-source drafts remain isolated and are not replayed.

Selecting an option or action-approval/rejection answer intentionally replaces
the shared composer text with that exact selected answer before capturing the
attempt, matching current Overview behavior. Apply consistently to the card.
Failure retains that selected answer; explicit retry sends it unless the user
edits/selects another answer. An edit during the attempt advances the revision and
survives its completion. No invisible alternate retry payload.

Retirement: explicit existing card Cancel clears text for that exact context and
advances its revision; it never cancels an admitted request or removes pending/
acknowledged bookkeeping. Cancel/reopen after acknowledgement must not permit a
second POST for the same decision. Ordinary dismissal/unmount retains text.
Acknowledgement clears only the captured revision as above. Resolved/replaced
questions are not offered for submission or transplanted; their retained text
can remain private in memory until pod deletion or app exit. Remove a deleted
pod's idle draft entries; an active attempt owns its final cleanup. No history UI
or unbounded retained completed tasks. Preserve existing text trimming semantics.

## Phase 3: question preparation and native surfaces

Own existing OverviewTab and SessionCardFinal reply paths. Keep existing layout,
options, question and approval semantics, applying the shared composer state to
free text, option buttons and action approval/rejection. All decision paths use
the new exact-observed-decision action; none bypass it through legacy reply.
Keep sheet open through submission/error; close only after acknowledged submission
for the sheet's captured context, never after a different context replaces it.

Unknown compact-only identity must not accept a draft under nil. Load the existing
detail endpoint when the user opens a reply surface (Overview selection or card
Reply/approval interaction), not for every offscreen fleet card. Show a small
inline question-loading/unavailable state and disable submission until an exact
current decision is available. An explicit retry uses the same existing detail
read; no automatic action submission. Late preparation must be fenced by R04e and
must not reuse compact text/options as a validated decision identity. Loading must
report a real outcome: the current Void refresh silently catches errors and an
existing hydrate admission can return early. Reuse/extract its revision-aware merge
into a result-bearing path with the existing Void wrapper preserved. Concurrent
loads must join or each await their own real result; do not interpret an existing
hydration flag as success. Re-read the reconciled current model after completion;
a returned old DTO must not overwrite a newer WebSocket decision. If refreshed
question differs, render that new question before it can be answered.

Move card sheet presentation to a stable card-level parent: detail hydration can
change unknown type into action_approval, removing its current presenting branch.
The already-open sheet must show the fetched approval controls, or a truthful
resolved/unavailable state if no decision remains. Do not dismiss simply because
the presentation branch changed. Test unknown-to-action-approval explicitly.

Bind text directly to app-owned draft state so changing tabs, switching between
card/detail and same-source reconnect retain exact text. Update view task/context
identity for source and decision, including same-pod replacement. Do not capture
an old actions value or decision across an await and then clear/dismiss the new
view. Observe the current mounted context through a reference-owned lifetime or
current-state observation; a Task capturing an old SwiftUI value cannot establish
that comparison after suspension. A natural internal extraction of existing card reply-sheet content is
allowed for direct native testing; its actual .sheet wiring stays source-reviewed.
No production test-only mutable bypass or synthetic replacement reply renderer.

Use the shown Inline status direction: sending; reconnecting with draft kept;
unconfirmed delivery with draft kept and advice to inspect activity before retry;
acknowledged/waiting for updated question. Preserve draft text while pending, and
disable duplicate submit controls; text may remain editable. Ordinary not-admitted
errors use concise inline wording. Unknown identity shows loading or an explicit
refresh-question affordance. These are truthful request states, not optimistic
Running/Resolved state changes. No new dialogs or app navigation.

## Phase 4: focused proof and review

Model/API evidence through real store/handler/DaemonAPI and held private transport:
- Same source, pod and decision across remount/reconnect shares exact text; source,
  UUID, endpoint, pod and decision replacements isolate drafts, including equal
  question text. Unknown identity never receives a shared draft or POST.
- Every submit preflight returns the same current decision before POST; failed or
  mismatched preflight produces no POST and retains text. The GET-to-POST server
  race remains explicitly unqualified.
- Typed draft followed by option/approval replaces text deliberately; held failure
  retains the selected answer and explicit retry sends exactly it. Acknowledgement
  clears only that revision; newer edits survive. Cancel during a held attempt
  clears text without releasing admission; Cancel/reopen after ack keeps no-repeat.
- Current known decision submission sends exactly captured text once; two surfaces
  and same-source handler replacement cannot duplicate an active attempt.
- Acknowledgement clears only submitted revision; newer edit, new decision, removed
  pod and replaced source survive a late completion. Held as well as failed GET after200 remains
  acknowledged but does not invent pod state; stale same-ID view cannot auto-repeat.
- POST500/transport loss preserves draft and unconfirmed state. No POST on remount,
  refresh or reconnect. A deliberate retry of the same current decision works;
  a locally changed decision rejects the old key without HTTP.
- Old-generation admitted request may settle remotely but cannot publish/refresh
  replacement state or clear current draft. Caller cancellation does not release
  admission before owned attempt settles. Failure/teardown leaves no pending tasks.
- Current/failed/late preparation; compact unknown detail resolves to current ID;
  invalid/absent decision keeps submission unavailable. Newer event during detail
  load wins through existing merge. Unknown-to-action-approval keeps its sheet
  presented with current controls. No fleet-wide prefetch.
- Explicit Cancel affects its captured draft only; ordinary unmount retains text.
  Existing paused guidance/legacy reply tests still pass unchanged.

Native proof uses actual Overview inside DetailPanel at600/900px and actual card
reply content at its existing sheet width. Type through NSTextField field editor,
submit via actual native Return, inspect sending/unconfirmed/acknowledged/new-
question states and callback/transport effects. Exercise actual button activation
for options/approval where supported; do not treat labels as activation evidence.
Capture every materially changed state and inspect each. Prove card/detail shared
text and teardown/remount. If native sheet presentation cannot be exercised, report
it before narrowing to directly mounted production sheet content; no full-app or
human-signoff claim follows from isolated component proof.

Run focused new suites and existing DecisionIdentity, PodStoreLifetime,
ConnectionOwnership, ConfirmedAction, InlineControl, ReplyDecisionRetention,
FactWaiver and UnverifiedTermination checks, then full Swift --no-parallel,
AutopodDesktopExe build, Node22 secret scan and diffcheck. Exact test selection
must use implemented R04e suite names. Record functions/cases/skips/exits, frozen
source revision and evidence hashes. Reviewer checks every decision submission
path and ownership transition, independently reproduces material races and native
text states before PR. Hosted general/native checks and integrated affected proof
must pass before closure. No new live cloud pod is needed for this local contract.

## Acceptance and limits

- [x] Native original text-loss/early-clear behavior reproduced.
- [x] Shared exact-decision draft ownership and isolated unknown handling proven.
- [x] Attempt lifetime, acknowledgement and unconfirmed outcomes proven.
- [x] Detail/card native text/input states inspected at final source.
- [x] Independent pre-PR, hosted and integrated checks recorded.

This task improves process-lifetime decision drafts, not app-restart persistence,
all message composers, authoritative answer receipts or server-side expected-ID
binding. A remote decision can change between the local check and server handling;
no stronger exactly-once claim is made. No human judgment gate is necessary for
these contracts; automated native evidence is not user signoff. Reverting this
bounded storage/action/view change restores previous behavior without migration.

Independent plan review identified differing option-vs-typed behavior and Cancel
bookkeeping as unresolved. Root chose consistent existing Overview semantics:
option/approval explicitly sets the shared text; Cancel clears only text. Immediate
acknowledgement before optional refresh, non-reused record identity and fresh
preflight-before-POST are now required with focused regressions. Root approves
this bounded behavior under standing authority, subject to exact R04e API-name
reconciliation at integration; no additional product choice is pending.

Final independent plan review found no remaining blocker. Baseline is two native
cases on unchanged production: field-editor text across Overview unmount/remount,
and text during held POST then500 after native Return. Production overlap waits
R04e integration; all phases are authorized together after that prerequisite.

## Phase 1 baseline evidence (2026-10-15)

Unchanged production baseline:88a739c5ec52425e85d1d6e70da11ea9e3eb01a4.
Worker branch codex/reliability-decision-drafts uses the completed
reliability-inline-controls checkout. Only the opt-in baseline test and this plan
are changed; overlapping production work remains held for R04e integration and
coordinator API reconciliation.

`DecisionReplyDraftBaselineTests` mounts actual DetailPanel/Overview at900×760,
types through NSTextField's real field editor and sends Return through this test
process's NSApplication. The remount case changes the real detail-tab binding to
Logs and back, verifies the field disappeared and was recreated for decisionA,
and observes the typed text replaced by an empty string. The submission case
observes exactly one private held POST /pods/decision/message containing the exact
synthetic draft; its field/editor are already empty while the request is held and
remain empty after an HTTP500. The handler records an error, the pod remains on
questionA/awaiting-input, and no second request or refresh is admitted.

Compilation passed (`swift build --package-path packages/desktop --build-tests`,
64.09s; Swift6.3.3). Strict baseline command from the worktree root:

```sh
AUTOPOD_REPLY_DRAFT_BASELINE=1 AUTOPOD_REPLY_DRAFT_RENDER_DIR="$PWD/.autopod-data/reliability/r04f/baseline/captures" swift test --package-path packages/desktop --skip-build --no-parallel --filter DecisionReplyDraftBaselineTests
```

Observed exit1:2 Swift Testing functions in1 suite,3 expected desired-retention
assertion failures (remount, held POST, after500), zero skipped cases or unrelated
fixture failures. XCTest's preceding0-test report is not the Swift Testing result.
This is a reproduced baseline defect, not a passing implementation. Opt-in gating
keeps the strict failing checkpoint from running in unrelated default suites.

Private evidence `.autopod-data/reliability/r04f/baseline/` contains build.log,
native-baseline.log, source-before.json, the exact copied test source, proof.json
and six captures/text observations: remount-before/away/after and
post-before-return/held/after-500. All six screenshots were opened and inspected;
actual text, questionA and empty field states are legible. No replacement renderer,
account startup, system keystrokes, home-data or external daemon access was used.
The reply callback wrapper only retains/joins the existing production action task;
production submission and text logic remain intact. Private transport fails closed.

Both cases close windows, restore process accessibility/private defaults, join
owned tasks, invalidate sessions and assert no active or deadline-expired requests.
Native slot was released after this run. Baseline proves only the selected900px
Overview behavior, not card,600px, reconnect, final retention or acceptance logic.
Next step remains coordinator-owned R04e integration/API reconciliation, followed
by separately dispatched production phases and independent final review.

## R04e API reconciliation and baseline checkpoint

Root read the final R04e PodStore at ed02c8ed completely. Its exact existing APIs
are `configure(api:connectionID: UUID? = nil)`, `disconnect()`, internal
`ownership(for: DaemonAPI) -> Ownership?`, and `isCurrent(Ownership?) -> Bool`.
`Source` is currently a private Equatable value containing `connectionID: UUID?`
and `endpoint: URL`; `source` survives disconnect, while `configurationEpoch`
advances on every configure/disconnect. There is no existing `stableSource` API.

The implementation may promote this same source value to an internal Hashable
type with a narrowly scoped read accessor, so draft keys use exactly the same
UUID/URL comparison as cache ownership. Do not introduce a second normalization
or infer source from an API object. Keep the epoch ownership token separate:
retained-source reads/edits may work disconnected, but all HTTP admission and
completion publication still require `isCurrent`. An obsolete source callback
cannot choose the new current source implicitly. The retained app-level PodStore
can own the dedicated draft helper; it is already shared across ActionHandler
replacement and needs no new global singleton or persistence.

`refreshSession` is currently Void and catches errors. Preserve that external
wrapper for its existing callers while factoring the same status/decision merge
into a result-bearing internal read used by preparation/preflight. Return enough
information to distinguish the actual returned decision from the reconciled
current decision; neither alone satisfies the preflight contract. Do not replace
it with `hydrateSessionIfNeeded`, whose early-return admission is not a result.
Existing store removal paths converge on `forgetPodState`; integrate draft
retirement there without resetting global identity sequences or releasing an
active attempt early.

Baseline bc846039 on unchanged production 88a739c5 reproduced two native cases
with three expected retention assertions: after Overview unmount/remount, during
held POST, and after500. Actual field-editor typing and native Return sent one
captured payload. Root read the full tests/log and inspected all six captures.
The baseline is retained in Git and ignored evidence; convert/replace its opt-in
test into ordinary final regression coverage with the new preflight semantics.
No permanent skipped baseline is needed. R04e hosted/integration completion
remains the production-start prerequisite; root will record its exact merged base.

## Implementation and qualification (worker R04f)

R04e prerequisite merged at d2a426a26cd038fd9c27dbd66c8e2e9a4ff4002e;
worker merge47a6966d preserves baselinebc846039 and the API addendum. Core
checkpointdc769f11 adds PodStore-owned DecisionReplyStore, exact retained Source
keys and a typed DecisionReplyActions contract. Production freeze5e6675a6 wires
Overview and actual card sheet/approval controls. Test-only follow-up4d117372
handles the new real preparation request in existing native identity proof;
production bytes are unchanged from5e6675a6.

All selected decision paths now capture the displayed decision, retain one shared
text revision and synchronously own admission before awaiting. The existing
refresh merge returns both raw mapped and reconciled decisions for preflight.
Only HTTP acknowledgement can clear the submitted revision; it is published before
optional refresh. POST failure stays unconfirmed, with no automatic replay. Paused
Resume still uses the unchanged legacy reply contract. Missing/default handlers
cannot acknowledge. Unknown questions require an actual result-bearing detail
read and cannot acquire an identity from compact text.

Early independent review refined implementation within the approved plan:

- Expected request outcome distinct from task cleanup; found pending cleanup could
  mask unconfirmed delivery during held refresh. Notice now takes priority, while
  admission remains owned. Held500/transport-loss regressions assert this.
- Expected one active submission per exact key across retirement; found immediate
  record removal could permit a second request after equal-key reinsertion. A
  separate active-key owner survives retirement; new record UUID/text remain
  isolated from old completion. The regression joins the held old attempt.
- Expected preparation tied to actual pod lifetime; ID existence alone survived
  removal/reinsertion. Non-reused source/pod lifetime tokens now fence publication.
- Expected all fixture-owned work joined on failure; direct tasks were untracked,
  and invalidating URLSession before a late best-effort GET caused an actual
  teardown exception. Fixtures now track external tasks, close fail-closed peers,
  join work, then invalidate sessions. Injected early failure at GET and POST
  proves pending cleanup and zero expired requests.
- Expected rendered controls to answer their displayed decision; a computed live
  sheet pod could retarget an old callback to a new question before rendering.
  Immutable DecisionReplyInteraction captures the displayed context. Retained
  edit/option/Cancel callbacks are exercised after replacement without rendering.
- Expected obsolete view work not to dismiss a new question or resurrect a mount.
  Live source/epoch/decision/record checks now supplement the reference-owned
  mounted context. A non-reused mount lease is captured synchronously before
  scheduling preparation or dismissal waiters. Exact same-context unmount/remount,
  queued old preparation, and completion-before-render regressions cover this.

These are testable local ownership fences, not a server-side expected-decision
binding. No API/schema/dependency or non-Swift production change was made.

Native final command (worktree root):

```sh
AUTOPOD_REPLY_DRAFT_RENDER_DIR="$PWD/.autopod-data/reliability/r04f/implementation/captures" swift test --package-path packages/desktop --jobs 2 --no-parallel --filter DecisionReply
```

Passed22 Swift Testing functions /43 executions /3 suites, zero skips. The strict
baseline is replaced by ordinary regressions; no opt-in skipped baseline remains.
Actual field-editor typing, native Return twice in one event turn, native option,
approval/rejection and Cancel activation use real views/handler/DaemonAPI with
private held transport. Tests cover Overview600/900, actual AppKit sheet hydration
from unknown to approval, all decision button paths, card/detail text sharing,
ordinary unmount retention, reconnect, failure, acknowledgement and newer question.

Visual proof limitation: AppKit sheet cacheDisplay loses vibrancy/background and
native button appearance (white masks). Actual sheet interactions and transport
assertions remain executed. Supplementary `production-sheet-*` captures mount the
identical production DecisionReplySheet in an ordinary NSHostingView at560px with
its real handler/transport, not a replacement renderer. These legible captures
cover question/approval ready, sending, unconfirmed, acknowledged, loading and
unavailable states. All captures were opened and inspected; Overview and directly
mounted production-sheet text and controls are legible. This is isolated native
component/interaction proof, not full-app startup, account wiring or human signoff.

Affected command:

```sh
swift test --package-path packages/desktop --jobs 2 --no-parallel --filter 'DecisionReply|DecisionIdentity|PodStoreLifetime|ConnectionOwnership|ConnectionLaunchOwnership|ConnectionWiring|confirmedAction|inlineControl|inlineCombined|InlineControlRendering|replyRetainsDecision|factWaiverRefresh|unverifiedTermination'
```

Passed85 functions /205 executions /13 suites, zero skips,9.552s. The first run
failed only two fixed GET-count assertions in DecisionIdentityRenderingTests:
matching resolution now admits the mounted composer's real fourth preparation
read. The fixture explicitly holds/settles and joins it, retaining exact B/staleA/C
identity assertions and checking four GETs, no POST. No production merge semantics
were broadened to impose ordering between ordinary concurrent REST responses.

Full worker qualification at4d117372:

```sh
swift test --package-path packages/desktop --skip-build --no-parallel
swift build --package-path packages/desktop --jobs 2 --product AutopodDesktopExe
npx -y -p node@22 -p pnpm@9.15.4 -c 'pnpm secret-scan'
git diff --check
```

All exit0. Swift Testing reports496 discovered functions /28 suites:495 passed
functions /651 passed parameterized executions /27 passed suites, plus one existing
skipped live-daemon function in LiveVillageConnectionTests. XCTest separately
passes13 tests. Full Swift elapsed19.619s; executable build1.76s. Existing compiler
deprecation/unused-capture warnings remain. No live daemon, accounts, Keychain,
home data, OS-wide keystrokes, cloud pods or external network were used.

Ignored evidence remains in `.autopod-data/reliability/r04f/baseline/` and
`implementation/`: exact logs (including failed diagnostic runs), original and
final source/evidence hashes, captures and proof.json. All test windows/private
defaults/sessions/held requests are cleaned up; owned work is joined. Native slot
was released after the full run. Root and independent desktop reviewer have read
the production and lifetime changes; final independent reproduction, hosted checks
and integrated qualification remain coordinator-owned before closure/PR.

Final independent pre-PR proof: root reproduced the affected selection plus
confirmedKillAcceptsTerminalSnapshot() at4d117372:86 functions /206 executions /13 suites, zero skips,9.929s. Root read
the final source and inspected all43 independent captures (37 root-native plus6
root-decision); legible production-sheet supplements passed inspection, while
raw AppKit sheet rasterization retains the stated limitation. Independent desktop
reviewer reported no remaining actionable findings at4d117372, including the
test-only preparation fixture adjustment. Root independently records87 hashed
files and43 inspected PNGs in root-proof.json. Root proof is retained at
`.autopod-data/reliability/r04f/root-focused.log`, `root-native/`, `root-decision/`.
Hosted and integrated qualification remain pending coordinator PR/integration.


### Hosted Swift 6.1 compatibility correction

Hosted PR436 compilation on Swift6.1.2 rejected conversion of the local
MainActor function `stillOwnsDecision` to the Sendable acceptance closure at
three readSession calls. Local Swift6.3.3 accepted it. The predicate is now an
explicit `@MainActor @Sendable () -> Bool` closure, retaining the same handler
capture and exact ownership/record/decision checks. No behavior or test assertion
changes are included. Prior proof/manifest remain preserved under
`implementation/prior-cb8384b2/`; the hosted failure log is retained. Fresh focused,
full-suite and executable checks and independent source review follow this change;
Swift6.1.2 compatibility requires the hosted rerun, not inference from local Swift.

Correction verification on local Swift6.3.3 passed: focused86 functions /206
executions /13 suites, zero skips,9.587s; full495 passed functions /651 executions
/27 passed suites plus the existing one live-daemon skipped function/suite,
XCTest13 passed separately,19.427s; executable build0.30s and diffcheck passed.
Logs are `implementation/focused-swift61-correction.log`,
`full-swift61-correction.log`, `executable-swift61-correction.log` and
`diff-swift61-correction.log`. Root and independent desktop reviewer read the
one-line correction with no findings; reviewed ActionHandler SHA256 is
8b2f792ca2e780758ad7b2d6a8188749bca0e5e5c7dd13ebc73a9d0e1717df90. No new visual
claim is made by this annotation correction; existing inspected captures remain
prior-head evidence, and current focused native interactions pass. Hosted rerun
and integrated proof remain coordinator-owned.

## Coordinator closure — October 16

PROVEN for the scoped decision-draft contracts. PR [436](https://github.com/esbenwiberg/autopod/pull/436)
merged into codex/reliability at `f587fa075965245e53049b7367cb317eb8a0c55b`.
The exact reviewed correction head `c73039150ad2a86d1e8d50ac1495f2e0a10771cd`
passed hosted CI [38815098480](https://github.com/esbenwiberg/autopod/actions/runs/38815098480)
and Desktop [38815098505](https://github.com/esbenwiberg/autopod/actions/runs/38815098505):
Swift6.1.2 full tests, renderer contracts and unsigned Xcode app build all passed.
The initial compiler failure remains retained; no skipped hosted build is counted.

Root rebuilt and ran the full serialized Swift suite on merged source:495 passed
functions /651 executions /27 suites,13 separate XCTest passes, one existing
gated live function/suite skipped; elapsed19.909s. AutopodDesktopExe built in0.31s.
Root regenerated and personally inspected all43 reply/decision PNGs at this head.
The actual-sheet rasterization/component/full-app limits above remain explicit.
All23 correction source hashes matched the merged source before closure-doc edits.
Final Node22 secret scan passed; final source/JavaScript continuity is recorded in
R09. Evidence: `.autopod-data/reliability/r04f/root-proof.json` and
`.autopod-data/reliability/final/proof.json`, including raw hosted logs and captures.
There is no remaining R04f implementation, review, hosted or integration gate.
