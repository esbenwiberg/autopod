# Sandbox checkpoint canary and recovery

Do not enable authoritative sandbox delivery broadly without an approved hosted canary.

1. Enable the sandbox-only checkpoint flag for one pod. Induce bounded Azure file-read 429, empty 403, and 502 failures. Confirm activity distinguishes retrying, verified, and durability-degraded states; never call a partial transfer recovered.
2. Confirm the promoted host `HEAD` and tree are the recorded snapshot SHA, checkpoint age remains below the lease, and validation runs from that exact host tree. Inspect metrics for phase latency, bytes/chunks, retries, semaphore wait, and Azure request IDs.
3. On a failed transfer, retain the sandbox and quarantine ref. Verify the feature branch/worktree remain at the last verified checkpoint. Do not re-run the agent for a transport failure.
4. Roll back by disabling authoritative delivery while retaining checkpoints and quarantine refs. The legacy recursive path is emergency-only and must not be used to assert source correctness.
5. A `hostImported && lineageVerified` record proves an imported capture, not successful promotion or final report preservation. Use the supported worktree recovery control; do not manually force-update the feature branch. If the sandbox is gone before import, explicitly select an earlier verified checkpoint through its owning recovery protocol and disclose its timestamp; never claim unavailable final content was recovered.
6. Garbage collect only after a newer verified checkpoint exists and retention has elapsed. Keep the sole verified quarantine ref and failed transfer evidence until an operator confirms a newer recovery point.

## Worker amended or autosquashed unpublished commits

A periodic capture can retain commit A on the host while the isolated worker later
rewrites A into A′. That is not a descendant of the earlier source, even though it
belongs to the same task. Keep the failed sandbox and all quarantine refs.

The daemon may reconcile this specific case only during the first generation's
initial coding segment, before any validation attempt or PR publication, for an
ordinary PR/branch task (not a fix, series, interactive or checks-only task). Its
anchor is the recorded admitted starting SHA, not a branch name supplied during
recovery. The host tip must be an exact checkpoint in this pod's quarantine; both
old and new source histories must descend from the anchor. The host checkout must
be clean, and newly tracked paths must not overwrite ignored files, reports or
symlink ancestors. Path enumeration fails closed for non-UTF-8 names rather than
silently substituting a different filesystem path.
Unrelated host commits, foreign/lookalike checkpoints and uncertain ancestry still
block promotion. Git replacement refs/grafts are not ancestry proof.

Successful reconciliation records `rewrittenFrom` (old checkpoint, old source,
admitted base), retains both histories under their existing quarantine refs and
materializes the exact new snapshot. It does not rewrite the sandbox's HEAD/index,
merge a PR, grant retry permission or certify required checks.

For an already failed `worktreeCompromised` pod, the existing authenticated
`POST /pods/:id/recover-worktree` control recaptures through these same checks and
clears compromise only after complete verified promotion/materialization. It may
resume a stopped sandbox for capture; that is a separate operator action, not a
read-only inspection. A local patch or deployment alone does not perform recovery.
If the guard still refuses, preserve the original and inspect the distinct source
histories rather than forcing a reset. Missing runner tools such as `jq` remain a
separate prerequisite; source recovery is not a validation pass.
