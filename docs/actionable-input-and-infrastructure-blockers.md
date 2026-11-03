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
only infrastructure reports from the current lifecycle count, and the pause waits
for the active run to settle before changing status. It retains the infrastructure
reason without manufacturing a question. A pending real question prevents this
automatic pause. AI advice cannot consume this report stop threshold.
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
