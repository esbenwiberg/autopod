# Close a failed pod

In the desktop pod **Overview**, choose **Close as failed** after reviewing the
failure. The pod leaves **Needs attention** and **Active** and appears in
**Completed** with its original **Failed** outcome. It remains in history. This
does not stop execution, delete anything, free storage, waive validation,
publish, or release dependent pods. An explicitly started retry can still
produce a new failure that needs attention.

The daemon verifies that the current failed run is idle and that its Docker or
sandbox execution resources are stopped or absent. Running or unknown resources,
unresolved operations and specialized recovery paths block closeout. A sandbox
without an exact identity cannot be assumed absent. Open **Recovery** to inspect
those cases; don't use Kill or Force Complete just to clear the list. Keep the
original resources until the appropriate recovery or cleanup is confirmed.

## Previously archived pods

Creating new fleet archives, including the handled-elsewhere disposition, is
retired. Hiding a pod was never termination or resource cleanup: unknown
execution and charges could continue out of view. The old CLI write commands
refuse locally, and the old daemon write routes return HTTP 410
(`FLEET_ARCHIVE_RETIRED`). Neither translates the write into another action.

Existing entries are visible in desktop **History → Previously archived**.
Search by pod ID and open the pod to inspect its state and any available
recovery actions. The archive flag is not evidence of resource release, current
billing, successful validation, or delivery. Historical actor/reason and any
handled-elsewhere reference remain intact; a human reference does not certify
publication or a merge.

```sh
ap ls --archived --json
ap ls --include-archived --json
ap status POD --json
ap unarchive POD --json
```

**Restore to fleet** / `ap unarchive` changes visibility only. There is no bulk
restore, migration of legacy statuses, or automatic resource mutation. Existing
archive rows continue to fence startup recovery. Explicit manual pauses remain
manual across restart, including after visibility restoration. Existing
archived entries remain accessible by exact ID; default fleet listing still
excludes them and explicit archive scopes still apply before pagination.

For an eligible retained run, **Stop and retain** ends execution without
reclaiming storage. [Delete & free resources](retained-cleanup.md) is a separate
explicit, confirmable action for supported recorded Docker continuations, not a
replacement for all historical cases. A legacy archive with unknown ownership or
execution stays held; do not force it Complete, fabricate evidence, or use
legacy Kill/Delete to bypass custody. Ordinary pod deletion and task History
after confirmed cleanup are separate from this retired visibility feature.
