# Explicit reruns of failed work

An intentional rerun is a human-authorized **distinct logical task** with its own
configured finite budget. It does not repair, erase, reset or inherit permission
from the old task's incomplete accounting. Preserve the original source and
execution evidence. Changing an AI preset does not change an existing frozen pod.

Composable admission normally blocks overlapping `touches`, including failed
pods that retain work. An authenticated original owner can exempt **only the exact
source named in `work.intentionalRerun.ofPodId`**, provided:

- The original is an idle, failed automatic task with a valid frozen launch,
  no PR, sidecars or test-run resources, and a full local Docker container ID.
- Task worker/validation, source custody, deletion and recovery ownership are
  settled. Unresolved delivery or prior merge requests still block the exception.
- A bounded read-only Docker observation positively reports stopped (or deleted).
  Running, unknown, inaccessible or timed-out resources refuse admission. This
  preflight never stops, wakes, executes inside or deletes the original resource.
- Original generation, timestamp, resource, launch and idleness still match after
  that observation and inside the synchronous snapshot-admission transaction.

Other overlapping pods still block. Missing server preparation cannot grant the
exception. Existing dispatch checks still validate the exact original task and
contract, repository and **original base branch**; main being newer or merged
is not permission to change that rerun binding. Source restoration and current
validation/review remain necessary, not inferred from an old saved checkpoint.

Ordinary terminal or non-overlapping reruns retain their existing path. Exact
saved request replay returns its recorded pod before resource observation or
mutable configuration checks, preventing duplicate launches after a lost response.

If the original container is still running, do not remove `touches`, downgrade
conflict policy, invent settlement evidence or change request identities to get
past this check. Quiesce it only through a separately authorized preservation-safe
operation, or leave the rerun blocked. Retained-continuation originals continue to
require their owning recovery controls; this is not a new source-custody release.
