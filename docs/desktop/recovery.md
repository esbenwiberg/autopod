# Desktop recovery

Pod detail has one **Recovery options / Review recovery…** entry instead of
separate sandbox, environment replacement, stalled execution and finalization
banners. Supported running tasks keep a quiet discovery entry; a failed task,
recorded pending decision or retained environment gets a contextual card.

## Understand before acting

The overview separates:

- **What happened:** the task's recorded outcome, with its failure details available.
- **Saved work:** preservation recorded versus not verified. A Git checkpoint is
  never described as proof that final files and reports are all saved.
- **Execution:** worker-stop evidence versus an unverified outcome. Machine state
  alone does not prove execution termination or failure of an earlier request.
- **Storage:** retained sandbox resources and possible ongoing storage charges.
  This is not an inventory of every independent image, volume or snapshot.

Status comes from existing owning recovery observations, not frontend error-code
parsing or inferred timeouts. Observations from different lifecycle generations
require another status check before new workflow navigation. Every mutation
still refreshes/rechecks its own exact source, resource and request bindings;
the overview does not grant permission. Preservation/worker-stop flags are used
only when their own checkpoint-context generation matches the repair inspection;
missing identity stays unverified. Status changes keep the recovery window and
its recorded outcome visible rather than creating a new controller.

## Presentation and navigation

Recovery uses the active desktop palette in light and dark appearances, with a
quiet task-context header, separate saved-work/execution/storage cards and
outcome-oriented action cards. Narrow windows reflow into a readable single
column; content scrolls rather than being clipped. Hover is optional feedback,
not a way to reveal essential information. Navigation remains native Buttons.

Forms keep visible field labels, and destructive review has a separate warning
surface and loss-acceptance control. Color is accompanied by text and symbols;
request state, eligibility and confirmation requirements are unchanged by the
presentation. Technical identifiers stay available without dominating the first
screen.

## Choose an outcome

### Continue work

Review separate controls for checks-only retries or validation repair, qualified
environment replacement, supported Docker stalled-run stop/preservation, or
ending with work retained / verifying an already-merged PR. Opening a control
is not execution authorization. Budget, retry, source custody, pending guidance
and independent-check requirements still apply.

The replacement view explains source selection, settings preview, actual
qualification, coding and checks separately. It does not publish or merge.
This first UI slice still requires an independently inspected full host commit
and reviewed replacement profile ID: the existing inspection protocol does not
discover a safe source automatically. Do not paste a guessed or historical SHA.
Source cards and profile discovery require a separate correlated selection
contract, not a client-invented default.

### Recover files

The page now provides **Save a copy of your files**:

1. **Files already saved** lists separate saved host-workspace and artifact
   locations. These can be older than the environment; no complete preservation
   is inferred. Choose a source, not a silently substituted fallback.
2. **Other files in the original environment** checks provider metadata only.
   Choose Browse files explicitly to run the bounded read-only inventory of an
   already-running original. A stopped machine requires a separate **Start old
   environment** review. The 10–4000-character reason is an audit note, not an
   agent instruction. Starting may incur compute charges and does not itself
   retrieve files or guarantee file access. Lost starts are observed, not replayed.
3. **Select files to save** shows full relative paths and sizes from that source.
   Save selected files to this Mac opens a destination-folder chooser. Each copy
   creates a new private subfolder, never overwrites existing files, and never
   opens or executes downloaded content.
4. **Last copy** reports saved/verified, failed and not-copied files separately,
   including the exact destination. Binary bytes use base64 and SHA-256 transport
   checks plus local readback. Cancelling or changing connections stops remaining
   copies; previously saved files are kept. A cancelled picker creates nothing.

This is a selected-file convenience browser, **not a complete backup**. Up to
2,000 files / 10,000 visited entries / depth 16 are inventoried per source; files
are capped at 5 MiB. The desktop selects up to 100 files / 50 MiB per copy.
Truncation and skipped entries remain visible. Symlinks, hardlinks, special files,
common credential locations (`.env*`, `.git`, `.ssh`, `.aws`, `.azure`,
`.config`, `.npmrc`, `.netrc`, `.pypirc`, agent/control directories) and
dependency/cache locations are excluded. File content is **not** secret-scanned.

The separate authenticated `GET /pods/:id/file-recovery` API lists explicit
sources; `?original=1` opts into guest inventory. Content reads require source,
generation, opaque root/resource binding, relative path and file metadata version.
Changed files fail rather than silently copying a newer or older source.
Host reads and sandbox probes require **Python 3** (isolated standard library);
missing support fails closed, with no installation, wakeup or alternate-source
fallback. Original browsing currently supports only the exact **current retained
sandbox** and reuses its existing idle/custody/unknown-start fences. Historical
resources, Docker originals and held originals are not newly authorized by this
browser. Saved host copies can still be available independently.

Copied selected bytes do not prove final files/reports are all saved, mark an
execution stopped, release custody or grant deletion authority. No destructive
checkbox or delete button appears in this path; Free storage remains separate.

### Free storage

Review exact retained resource identity, blockers, a reason, explicit acceptance
of unsaved file/report loss and a second destructive confirmation. The supported
operation is **Discard unsaved data and delete…**, not archive-and-release. It
also attempts pod deletion; a confirmed environment deletion with blocked pod
cleanup remains a distinct partial result. Stop-and-retain does not free storage.

An unknown sandbox start can still have a separately reviewed loss-accepting
delete path when the owning backend allows it. Other task, source and execution
owners remain blockers. No unknown execution is called settled or preserved.

## Pending decisions and uncertain outcomes

The overview surfaces saved/unresolved decisions before suggesting new work.
Check status observes rather than resubmitting a mutation. Continue abandonment
uses the exact original request. A start request is never blindly replayed.
Sandbox start and abandonment have separate protected request journals scoped
to the owning connection/pod. Deletion decisions are additionally keyed to the
observed generation and exact resource. A changed selection requires a new
reason, loss acknowledgement and confirmation; older immutable decisions remain
retained rather than being overwritten or retried against the new selection.
A definite rejection is durably recorded separately from the immutable request,
bound to that exact request body. This survives restart, but still requires fresh
evidence of absence before the UI can explicitly discard the rejected draft.
Unreadable or mismatched evidence fails closed.

Full hashes, generations, resource namespaces, operation IDs and audit history
remain available under technical disclosures. Connection changes invalidate
current observations and do not discard saved decisions. Inspectors that do not
apply to the new lifecycle no longer contribute stale generations to the overview;
their saved requests and outcomes remain available to their owning controls.

## Isolated sample-data preview

Build alongside the installed app, without installing or replacing it:

```sh
./scripts/build-desktop-preview.sh --fixtures
open -n "packages/desktop/build-preview/Build/Products/Debug/Autopod Preview.app" --args --recovery-preview
```

This uses the separate preview bundle/preferences and credential identity. In
fixture mode, saved connection restore, connection creation/testing/switching,
deep-link connections and Microsoft sign-in/token refresh are disabled. It cannot
be converted into a live session through the preview's Connect button or Settings.
Build without `--fixtures` separately if a connected preview is deliberately wanted.

Choose **Fixture options → Recovery scenario** for a retained environment, an
unknown start outcome, or cleanup blocked by source custody. Start/discard receipts
are in-memory simulations; journals use a new temporary session directory.
Changing scenarios invalidates open actions rather than retargeting them. Saving
sample files creates a real new folder containing only example data at your chosen
Mac destination. The sample never starts coding/checks, provisions, publishes,
merges or deletes real
resources; simulated deletion keeps the sample task history visible. These
observations are not actual pod diagnostics or live recovery qualification.

## Not implemented by this UI change

Verified archive-and-release, custody release for retained originals, resource
reaping policy changes, automatic retry grants/budget increases, and new delivery
or merge authority are not provided. The unified UI composes existing native
controllers and protocols; it does not introduce a generic execute-recovery API.

See [sandbox wakeup recovery](../sandbox-wakeup-recovery.md),
[retained continuation](../retained-pod-continuation.md), and
[validation recovery](../validation-recovery.md) for the owning policies.
