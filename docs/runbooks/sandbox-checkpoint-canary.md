# Sandbox checkpoint canary and recovery

Do not enable authoritative sandbox delivery broadly without an approved hosted canary.

1. Enable the sandbox-only checkpoint flag for one pod. Induce bounded Azure file-read 429, empty 403, and 502 failures. Confirm activity distinguishes retrying, verified, and durability-degraded states; never call a partial transfer recovered.
2. Confirm the promoted host `HEAD` and tree are the recorded snapshot SHA, checkpoint age remains below the lease, and validation runs from that exact host tree. Inspect metrics for phase latency, bytes/chunks, retries, semaphore wait, and Azure request IDs.
3. On a failed transfer, retain the sandbox and quarantine ref. Verify the feature branch/worktree remain at the last verified checkpoint. Do not re-run the agent for a transport failure.
4. Roll back by disabling authoritative delivery while retaining checkpoints and quarantine refs. The legacy recursive path is emergency-only and must not be used to assert source correctness.
5. Manual recovery: materialize the newest `hostImported && lineageVerified` quarantine record. If the sandbox is gone before import, explicitly use only the latest earlier verified checkpoint and report its timestamp; do not claim the unavailable capture was recovered.
6. Garbage collect only after a newer verified checkpoint exists and retention has elapsed. Keep the sole verified quarantine ref and failed transfer evidence until an operator confirms a newer recovery point.
