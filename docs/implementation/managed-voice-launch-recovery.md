# Managed Voice launch recovery

The portfolio Voice smoke exposed a real workspace preparation incompatibility: `node_modules/` ignores directories but not the dependency-cache symlink. Keep the generated `/node_modules` exclusion in the isolated workspace's `.git/info/exclude`; never change the user's committed source or mirror.

Managed attempts are distinct from native pod listings. The same authenticated CLI transport now supports passive `GET /managed/attempts/:attemptId`, scoped to the caller's installation, returning the existing handle or JSON null. It neither renews a grant nor allocates a runtime. Capability: `managed-attempt-lookup-v1`. Existing protocol schemas and CLI success envelopes are unchanged.

Terminal reservations remain reconcilable after expiry even if no runtime was allocated. Safe launch limitations are stored in the existing result table. CLI failures return an allowlisted machine category; no raw exception text, response body, or credential is emitted. Older consumers still fail closed on a nonzero CLI exit.

An unallocated sandbox reservation can be cleaned only after observed exit and revocation, with no runtime reference and no durable sandbox allocation row (including uncertain creates). Delete only that isolated workspace. Allocated workers retain their artifact and source preservation checks.

Local regressions cover the directory-only ignore, unchanged mirror, restart, expired lookup, installation isolation, safe errors, and refusal to clean uncertain allocations. No migration or global profile enablement is introduced. The paired Dispatcher fix reports admission/attention truthfully and uses managed retry/stop instead of the native kernel.

Deployment must preserve the already deployed `425ff91c` release lineage from the parallel task. After paired deployment, recover and clean the two September 10 failed portfolio reservations before a fresh bounded research attempt. Local tests do not establish paid provider, Azure execution, artifact delivery, or Voice-device acceptance.

## Clean deployment rebuild

The first overlay activation preserved old Git metadata: health reported commit 425ff91c with dirty=true despite the new reachable managed bundle. The strict release gate rejected that deployment and retained maintenance. Rebuild this candidate with the standard script's --full mode and --verify-release; do not bypass the identity gate or claim health 200 as provenance.
