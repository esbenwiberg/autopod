# Close out work handled elsewhere without inventing native delivery

A manually delivered task can remain Validated because its historical daemon
publication receipt is missing, or manually Paused after a successor PR merged.
Do not create a retrospective push receipt, mark checks passed, force Complete,
or wake a worker just to make another recovery control eligible.

The explicit **visibility-only** disposition is separate from ordinary Archive:

```sh
ap status POD --json
ap archive-handled-elsewhere POD \
  --generation EXACT_GENERATION --status EXACT_CURRENT_STATUS \
  --reference https://github.com/OWNER/REPO/pull/NUMBER \
  --reason 'Work delivered elsewhere; retain the original evidence and resources' \
  --ack-retained-execution --json
```

Verify the external work before choosing the disposition. The reference stored
by this action is **human supplied**, not a server-verified publication, merge or
validation receipt. The authenticated actor, observed generation/state, reason,
reference and retention acknowledgement are stored in the existing fleet archive
audit row. Repeated archival retains its original metadata until visibility is
restored. Stale generation/state refuses the action.

This supports ordinary PR/branch tasks in Validated, Paused with a manual marker
(including ambiguous legacy intent), or ordinary archive states. Running/provisioning/queued/validating/approval/merge states,
nonmanual budget/provider pauses, interactive tasks and native Goals are refused.
Default `ap archive` keeps its existing state restriction. The distinct endpoint
is `POST /pods/:podId/archive-handled-elsewhere`; unsupported clients/daemons fail
closed, never fall back to an approval, kill or ordinary-archive override.

Only fleet visibility and its audit record change. Native status, source,
containers, ignored files, reports, pending guidance, worker/execution uncertainty,
unknown usage, budgets and publication/merge/custody ledgers remain untouched.
Archival does not stop execution, prove preservation, settle billing uncertainty,
release resources or prevent retained resources from incurring costs. It cannot
cancel provider work already admitted before the disposition; recovery rechecks
live intent before admitting further effects and after awaited work. It never
marks a task Complete or launches dependents.

Startup reconciliation leaves archived ordinary tasks and manual-marker pauses
alone: it does not wake, requeue, quiesce or delete their resources, nor infer that
an unknown worker stopped. Older releases also used the manual marker when
recovery automatically parked work: that legacy intent is ambiguous and stays
held for an explicit owner decision. New automatic ordinary sandbox parking uses
no manual marker, so later restarts can observe and reconcile it. Native Goal and
interactive recovery remain with their existing owners.

```sh
ap ls --archived --json
ap status POD --json
ap unarchive POD --json
```

Restoring visibility does not resume work, answer guidance, clear custody or
reconcile old receipts. Any later execution/delivery still requires its existing
owning controls and actual evidence. An explicit manual pause stays manual across
restart, including after visibility restoration.
