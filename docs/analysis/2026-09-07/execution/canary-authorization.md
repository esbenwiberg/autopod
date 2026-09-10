# Continuing canary authorization

On 2026-09-10, after checkpoint 130, the user explicitly authorized: “Approved all the canaries you need”. This supersedes the former one-attempt approval boundary for the remaining goal-scoped canaries and diagnostic retries. No repeated user approval is required for those canaries.

Each run remains bounded, with a pinned source/image and unique identity, named checks, spend estimate, preserved failures and verified cleanup. Start with the prepared CP130 Codex packet (approximately $0.053 known compute/one-transfer components, ancillary conversion/storage/retries unpriced), then adapt only to evidence from preceding runs. Do not repeat unchanged failures without a diagnostic change. No model calls are needed for the current capability probes.

This authorization does not by itself authorize production deployment/restarts, mutation of existing pods or shared resources, role grants, source publication, merges or external messages. Completed native and backup proof remains retained.
