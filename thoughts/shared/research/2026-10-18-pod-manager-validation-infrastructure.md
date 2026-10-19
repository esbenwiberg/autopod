# Slice 12 research: validation infrastructure classification and parking

Date: 2026-10-18.
Baseline: 86380d0ff76f126f8e60d245447f4a2718f8c4a5.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Existing boundaries

Eleven slices are complete. pod-manager.ts is 17,343 lines. Validation result
publication is now a synchronous module. The manager still classifies infrastructure
failures and parks pods through three named helpers.

pod-manager.ts:956–1006 contains four pure functions (51 lines including trailing
blank): isValidationInfrastructureOnlyFailure, validationInfrastructureFailureLabel,
isReviewInfrastructureOnlyFailure and reviewInfrastructureFailureLabel.

:6775–6842 contains three parking helpers (68 lines including trailing blank):
parkOnRetryAdmission, parkOnValidationInfrastructureFailure and
parkOnReviewInfrastructureFailure. There are eight awaited calls: two denied-admission
catch paths, three validation-infrastructure paths (including pre-check sandbox
unavailability), and three review-infrastructure paths (including council review).
All are inside manager orchestration. Some later review-failure branches inline
similar shutdown code; those are separate paths, not calls to these helpers.

## Classification and labels

Validation infrastructure classification is simply overall==='fail' plus a defined
infrastructureFailure field. It does not separately exclude deterministic failures
or require retryable=true. Its label is generic without metadata and otherwise
includes the reported phase.

Review infrastructure classification accepts null taskReview with review-timeout or
review-failed, or a review batch marked infrastructureUnavailable===true, or closure
verification unavailable/invalid. It then requires build pass; excludes failed
health/pages/test/lint/SAST and failed or pending-human facts; finally requires
overall fail. Health/test/etc. skips and absent optional results retain their current
handling. No additional setup/result consistency check exists here.

Review label precedence is frozen council → unavailable/invalid closure → timeout →
generic review failure. The label's council test uses truthiness whereas classification
uses ===true. Preserve the current expressions rather than normalize them.

The four functions are used in ordinary/manual validation, independent councils,
Resume routing (:16482), and injected into createValidationExecution (:5564–5566).
Moving them must retain the same names and implementations at every use.

## Three distinct parking behaviors

Denied admission first returns if the PASSED pod snapshot is not validating. Otherwise:
activity(error.message) → transition(review_required,{failureReason:error.message}) →
update(validationAttempts=max(0,snapshot.validationAttempts-1)). It retains correction
text. With a container: await preview stop, then factory.get(target).stop(container).
That try has no stopping activity or success log; failure warns with its own text.

Validation infrastructure always computes label, emits parked-for-Resume activity,
transitions to review_required, then updates refunded validationAttempts plus
lastCorrectionMessage=null. It does not pass failureReason to transition. With a
container, its try emits stopping activity, awaits preview stop, selects manager,
stops container and logs success with infrastructure metadata. Catch warns.

Review infrastructure transitions to review_required, without refund/update of
attempts/correction/reason. Its container-stop try is like validation infrastructure
but with review-specific logging and no infrastructure metadata in success log.

All refunds use the ORIGINAL snapshot argument, not a fresh repository read or the
Pod returned by transition. A synchronous transition subscriber could change stored
counts before the next update; the current helper still writes the original count.
No common transaction or new ownership check surrounds these steps.

Transition or counter-update failure can escape after earlier effects and before
shutdown. Stopping activity/preview/factory/stop/success-log failures are within the
respective stop try; warnings can themselves throw. Initial activity and transition
are outside that try. Proxy rejection prevents container stop. Missing container
skips the whole stop block. A successful stop followed by logger failure is still
caught/logged as a stop-path failure. No retry/remove/kill is added.

## Manager-owned collaborators

transition (:6470) validates state, updates pod fields, marks completion journal,
emits status after commit where configured, refreshes readiness on relevant states,
and returns a fresh pod. It remains shared manager code.

stopSandboxPreviewProxy (:3804) owns native preview ports and proxy maps. It removes
map entries, unexposes native ports, closes proxies, and retains its existing local
catches. It remains in manager. Parking helpers only call that callback before stop.
containerManagerFactory, podRepo, logger and activity emitter remain captured manager
references; methods are looked up when invoked.

Retry ledger admission/execution/outcomes stay in their existing modules. These
helpers adjust the DISPLAY validation attempt count, not durable retry budget.
TaskRetryBlockedError remains the existing class in task-retry-ledger.ts, used by
manager instanceof checks; a new parking module needs only its type for the argument.

## Existing tests and proof scope

Public manager cases around :16078 cover review infrastructure parking/attempts;
:16123 covers non-null unavailable councils; :16166 covers unavailable closure;
:16549 covers exhausted retry budgets across Resume/restart; :16733 pins validation
infrastructure parking once and refund; :16775/:16808 pin validation-only Resume.
Existing execution/admission/ownership groups protect current caller checks.

The predecessor's explicit affected set has 56 suites. Verified distinct additions
are a future pods/validation-infrastructure.test.ts, existing sandbox-preview-proxy,
preview-supervisor and api/routes/pods suites, yielding 60. State-machine, retry-ledger,
execution, publication, event-bus and SQLite suites are already included. There is
no validation-ownership.test.ts at this baseline; do not invent that command.

## Next action

Prepare the concrete extraction plan and illustrated HTML for approval. No product
code changed or implementation tests ran in this planning turn. The established
characterize → extract → qualify structure and incremental commit/push authorization
continue to apply.
