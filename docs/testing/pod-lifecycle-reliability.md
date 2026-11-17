# Pod lifecycle regression runway

Run `bash scripts/test-pod-lifecycle.sh` after the normal frozen install and build.
The gate forces database tests on and requires every selected file to contain
executed passing tests. It covers the runway regressions, state transitions,
composed agent and validation workflows, infrastructure classifiers, and the
ordinary lifecycle e2e using migrated SQLite and mocked infrastructure.

Delivery incidents run the real composed create/process/validation producer with
SQLite publication and merge journals. They require an immutable validation-source
binding before the initial committed-source push, exercise ordinary approval and
read-only external-merge observation, and keep lost publication/merge responses
distinct from confirmed outcomes. Local Git fixtures check actual source identity.

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
admission and resource hold; they do not authorize a second push.

This selection is not proof of live containers, live external delivery,
platform-specific behavior, or every recovery route. Extend the existing
production fixtures and selection as further lifecycle regressions are added.
