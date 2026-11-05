# Human decisions and infrastructure blockers

New `report_blocker` requests are infrastructure reports, never questions. They
carry `kind: infrastructure`, responsible `owner` (Autopod, parent or validation),
optional failing `phase`, plain description, attempted work and missing needs.
The daemon stamps lifecycle ownership. Counts, including mixed AI consultations,
cannot turn reports into pending input. Reports remain durable escalation evidence;
the escalation counter is not a question count.

For example, “Should the export include archived records? Recommend excluding them
to match the current screen; include them for a complete audit or exclude them for
screen parity” is an owner decision. “The validation runner cannot launch the locked
Node version” is a validation infrastructure report. Record the failing phase,
evidence and required repair; if no supported recovery exists, say so. Do not offer
a chat choice claiming to repair PATH, provide missing CI logs or settle an unknown
exit. A selected label, “ok”, “go on” or “skip” proves none of these actions occurred
and cannot waive a gate or grant authority for a different action.

The worker stops blocked attempts, preserves source and reports incomplete checks,
then finishes through owned execution settlement. Reporting itself does not change
lifecycle while the worker is active. On settled completion, infrastructure from
the current lifecycle holds the pod as failed with an infrastructure reason, no
pending question and no automatic coding or validation dispatch. Workspace capture
is attempted before the transition; capture failures retain original resources and
are explicit. An existing unanswered question takes priority and is never displaced.
At the configured report threshold, Autopod also requests the existing owned pause:
only infrastructure reports from the current lifecycle count, and the stop waits
for the active run to settle, then invokes that same narrow infrastructure completion
owner to preserve the workspace before parking as failed. Duplicate pause and message
admission remain fenced through preservation; missing positive settlement cannot be
replaced by a direct failed-state transition. It retains the infrastructure reason
without manufacturing a question. Ordinary Resume, Rework, tell and nudge
cannot clear the recorded infrastructure need or dispatch the same lifecycle. No
in-place chat recovery is supported: Autopod must diagnose the needs and provision
a qualified execution. Restart and host wake finish source preservation and park an
already-settled blocked worker through the existing completion gate. This requires
positive execution-ledger settlement for the same lifecycle, completion cycle and
recorded container/backend, with no outstanding task execution or cleanup ownership.
A complete event, an empty active-run set, an old cycle or a container-status lookup
alone is not termination proof. Missing evidence and failed reconciliation reads
retain the block and original resources without dispatch or artifact collection.
Periodic watchdog ticks route current automatic-worker reports to this same owner,
including late reports after dispatch was refused. They do not convert silence or
an ownership-read failure into a container stop or generic terminal failure. Reports,
resource/generation ownership and renewed activity are rechecked after awaited preview
or stop work; an already-admitted stop is retained as an effect, not called absent.
A pending real question prevents this automatic pause. A genuine answer still records
its actor and delivery custody; after the worker has settled, it cannot start another
coding turn on infrastructure blocked in that lifecycle. Saved guidance remains held
for a qualified execution, not an ordinary Rework suggestion. Direct rejection,
revalidation and validation-override dispatch also retain this infrastructure fence.
Ordinary validation, update-from-base (including post-abort rebases), instant overrides,
legacy attempt extensions, waiver application and pass delivery recheck it at their
owned boundaries. Preservation and diagnostic mutation guards remain available; they
are not validation authorization. Host credential repair replies retain their actor
and decision receipt atomically with leaving the answered-question state. A current
report leaves unknown execution running/held and lets positive settlement park it,
never an empty `awaiting_input` decision. It prevents both fetch/worker queueing and
push/PR/auto-approval dispatch. Delivery rechecks ownership after awaited boundaries.
Override guidance and other reply error paths retain shared settlement, unknown exits
and the original error rather than overwriting them with a generic failure.
Provider recovery (including profile-primary and automatic failover) cannot authorize,
tear down or queue over a current report; asynchronous boundaries recheck the hold.
Already-admitted effects remain recorded rather than being undone or called absent.
A report from an older lifecycle is preserved, not rewritten into a current block.
Recognized blocked-completion wording, exhausted token budgets, and fatal exits use
the same settled preservation owner. Budget usage/exceeded events, limits and extension
counts remain unchanged; preservation grants no continuation or extra budget. Concurrent
pause, terminal and restart calls coalesce for the same resource/cycle. A newly
recorded answer is re-evaluated after an in-flight question capture, without acting
on a replacement lifecycle or releasing saved guidance. Unverified
termination evidence is retained for its original run before paused or superseded
ordinary events are suppressed. The shared event-consumption settlement boundary
invokes preservation for feedback/message/correction runs as well as initial workers,
including fatal outcomes and stream errors. Worker admission and persisted cooldown
wakeups recheck reports before pulling another coding iterator. Local
Goal recovery requires stopped native execution as well as the resource-bound ledger
proof; generic Goal parking and failed Goal reads must not bypass preservation.
AI advice cannot turn this report stop threshold into a human decision.
Stream closure alone is not native termination proof: an unverified execution
retains its active ownership and resources without another stop or retry.
A report is a worker claim requiring diagnosis, not authoritative proof of an
external validation failure. Optional diagnostic gaps belong in task-summary limits,
not a blocking report. Explicit recovery must inspect actual execution evidence;
this change introduces no recovery command, waiver or automatic retry path.

Typed executor infrastructure and unverified exits retain their existing finite
retry/settlement policies. Unknown exits cannot be replayed automatically; missing
or inconclusive review remains incomplete. Coding correction rejects typed
infrastructure evidence, while ordinary source/test failures keep bounded correction.
Configured frozen setup and existing locked dependencies are preauthorized. New
out-of-scope product libraries, destructive operations, security approvals and
credentials retain their approval flows. Linux workers defer Xcode checks to a Mac.

## Compatibility and rollout

Stored legacy blockers with omitted `requiresResponse` retain their original reply
flow; existing explicit questions, action approvals and overrides remain resolvable
with the existing atomic persistence, actor provenance and exact reply delivery.
New MCP human decisions require a recommendation/reason and at least two useful
choices. Explicit decision requests cannot fall back to AI on timeout or unattended
mode; dependent work remains unauthorized. Older direct callers retain their legacy
payload compatibility. No stored request is rewritten or dismissed.

CLI, mobile and desktop retain existing failure presentation and show the recorded
infrastructure reason after settlement, without a pending question. Defensive pending
report projections suppress answer controls for noninteractive records. Mac rendering
and runtime checks require separate Mac qualification.

Source acceptance is separate from delivery. This work stacks on reliability PR
#502 (`b5b2bc07d8ba4f7c62a95fec8a5342f0fce894cc`); it does not duplicate its system CA,
Git, declaration heap or image changes, or replace #496/#498 execution evidence work.
Operators must integrate source, qualify images and observe deployed fresh workers
before declaring the production issue fixed. Existing frozen launches and historical
pods are not migrated or retried. Publication remains daemon-owned until an actual
PR URL exists. See [validation reliability](validation-execution-reliability.md) and
[worker reliability](worker-profile-reliability.md) for their independent rollout gates.
