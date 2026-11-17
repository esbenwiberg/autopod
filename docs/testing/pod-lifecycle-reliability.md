# Pod lifecycle regression runway

Run `bash scripts/test-pod-lifecycle.sh` after the normal frozen install and build.
The gate forces database tests on and requires every selected file to contain
executed passing tests. It covers the runway regressions, state transitions,
composed agent and validation workflows, infrastructure classifiers, and the
ordinary lifecycle e2e using migrated SQLite and mocked infrastructure.

Routing incidents compose the real review producer, tool/bridge, persisted reports
and manager decision. They cover one bounded inner reviewer retry, reconciliation
refusal without coding or fix-attempt burn, explicit external NOT RUN claims, and
required Mac Facts remaining pending rather than waived. Real Git verifies empty
incremental versus inherited changes. Missing live/host review source is not an
empty packet; display previews retain their separate best-effort fallback.

Network incidents interleave allocation and pressure cleanup across separate
managers sharing migrated SQLite. A provisioning bridge is not orphaned merely
because its first container has not attached. GC rechecks durable pod/reviewer
ownership and live network identity; unavailable ownership/inspection fails
closed. Unknown isolated system/deployment/artifact-check owners require their
own cleanup protocol, not ordinary pod GC. Exact-owner teardown remains distinct,
and genuine ordinary unowned bridges can still be reclaimed.

Delivery incidents run the real composed create/process/validation producer with
SQLite publication and merge journals. They require an immutable validation-source
binding before the initial committed-source push, exercise ordinary approval and
read-only external-merge observation, and keep lost publication/merge responses
distinct from confirmed outcomes. Local Git fixtures check actual source identity.
PR retries and failed post-check publication use the same checked-source ledger,
without auto-committing unreviewed bytes. A failed-state push needs an immutable
current passing certificate; a passing mutable projection is insufficient.
An ambiguous PR create still needs provider lookup and never authorizes duplicate
creation merely because a search returns no match.

Approval observes provider disposition before base preparation and again before
activating a prepared candidate. A merged predecessor is recorded separately from
candidate checks: prepared worktrees and original report resources remain in
rewrite custody, and no candidate pass or new worker is implied.

Historical missing-publication delivery requires an authenticated human approval
with an explicit reason, a matching immutable validation-source/result binding for
the exact task, generation, target and original resource, and provider head or
ancestry evidence. A passing mutable projection, PR URL or branch alone is
insufficient. No historical publication is invented. Older records lacking that
proof remain blocked; inspect source-recovery and the existing validation/rewrite
owner. There is no supported control that reconstructs missing historical proof
from logs or reruns coding to certify an old merge.

An admitted initial push with no response leaves validated source retained.
Human approval observes that original operation using the exact remote ref and
local source before continuing. Unknown/mismatched observations keep the same
admission and resource hold; they do not authorize a second push. A confirmed
unchanged publication is reused only after fresh local/remote observation and
present delivery-authority checks. An already-confirmed intent cannot admit a
second physical mutation; remote deletion/rewind never silently triggers a push.
Resume can also observe that original pending publication from a failed/review
hold before considering continuation. Exact remote/local proof settles only that
publication; failed checks, retry admission, accounting and other custody remain
unchanged, and continuation may still be refused. A completed-pod PR retry needs
the same current immutable certificate and original retained source/resource;
completion alone cannot authorize another publication. Revalidation can retain a
passing check result while an ambiguous prior merge still forbids publication.
The owning approval path can record original-publication facts before rejecting
changed retained-continuation checks. Observation does not waive those checks or
retention, and never creates a replacement approval, push or validation attempt.
Resume, PR retry and approval can settle the original publication while queued
guidance remains unconsumed. A genuine infrastructure report remains a blocker.
PR retry rechecks worker/validation termination before and after asynchronous
observations: a historical pass cannot authorize new delivery over unknown execution.

This selection is not proof of live containers, live external delivery,
platform-specific behavior, or every recovery route. Extend the existing
production fixtures and selection as further lifecycle regressions are added.
