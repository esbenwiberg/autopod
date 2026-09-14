# External configuration migration report

Local source inspection, 2026-09-14. No external consumer, enrolled grant, live profile or database was changed. This report identifies the required contract changes; it does not certify a live deployment.

## Preliminary hosted inventory

The healthy hosted daemon at release `136219fa0e2cbb700dd4d4ca9e4ee2584d4deca3` returned its existing redacted profile projection. This was a read-only API call; it did not export or inspect the hosted database and therefore cannot produce the final cutover digest.

An owner-only JSON backup of that redacted API projection was saved at `/Users/ewi/.autopod/backups/hosted-config-20260914T093127Z/config.json`, with its inventory and checksum in the adjacent `manifest.json`. The configuration checksum is `e1dd282bd3355aab9c4d2886ca0c2b88ec26acc359bf2ec4d69222eed2833bd0`. The backup contains 28 profiles, three provider-account identities, six schedules, the repository-local Pi configuration and hosted release identity. Credential objects and secret fields are omitted. This is a safe configuration reference, not a restorable database backup.

The projection contains 28 profiles and six inheritance-based variants. It reports no custom actions and no enabled test pipelines, so the approved retirement removes no active configuration. The reviewed draft mapping is in `thoughts/shared/plans/2026-09-14-hosted-conversion-bindings.draft.json`.

- `teamplanner-logs` maps to workspace `42e48009-9e8f-4046-ae42-cb62b20d0909` and only the supported tables present there: `AppTraces`, `AppExceptions` and `AppRequests`. The resource group contains App Service and Function resources but no Container App, and its workspace has no supported container-log table. The legacy container-log action is therefore not carried forward.
- `contextand-ctx` had an unscoped `ado-code` group with no Azure DevOps organization, project or repository recorded. The draft retires this access and emits `SCOPED_ACCESS_RETIRED`; it does not invent a broad grant.
- `guardian-deploy` is retired as a selectable profile. Its published-default deployment setup remains on the Guardian repository, and old references resolve to the reusable `guardian` profile.
- Provider account selections, explicit empty failover, GitHub access, the inferable TeamPlanner ADO reads, exact TeamPlanner PIM eligibility, code-intelligence packages and repository usual profiles are mapped.

The resulting redacted candidate preview has source digest `a2b0863da8543c917aa9c4dbb9f4c3a997bb3dd387ebdc1072f11d146a10f83a`, converts all 28 bindings into 102 composable entities, and has zero blockers. It retains two deliberate warnings: `SCOPED_ACCESS_RETIRED` for `contextand-ctx` and `PROFILE_REPLACED` for `guardian-deploy`.

For discovery, the exact Log Analytics Reader eligibility was activated for the same user and production resource group. Azure ARM exposed the workspace and table metadata, while aggregate data queries remained unavailable during the short RBAC propagation window; no log records were read. Azure required its five-minute minimum active duration before accepting deactivation. The deactivation returned `Revoked`, and a subsequent active-assignment lookup returned no matching assignment.

A final rehearsal must still run against a verified hosted database backup with the matching encryption key. The current hosted daemon exposes redacted profiles but has no database-export or conversion-preview endpoint.

## Repository-local Pi configuration

The inspected `.pi/autopod.json` contains:

- `defaultProfile: "autopod-self"`
- `allowedProfiles: ["autopod-self"]`
- `validationSuite: "deterministic"`

The new native launch contract cannot infer a repository from this profile name. Conversion must first supply the reviewed mapping for `autopod-self`: repository ID, setup ID and new profile ID. The Pi consumer then needs to submit the explicit repository/setup/profile selection, resolve a preview, and submit its digest and request ID. Its allowed-profile check is insufficient as a repository authorization check once profiles are reusable.

Keep `validationSuite` behavior explicit in the mapped repository setup/workflow; the same spelling alone does not establish equivalent validation. The current file was deliberately left unchanged because the live conversion mapping is not available. Do not replace its values with fixture IDs such as `repo-a`.

## CLI and native API clients

Old native calls that supply only `profileName` must migrate to `LaunchRequest` with an enrolled repository (or the explicitly supported empty-workspace variant). Resolve before admission and preserve request identity on retries. The repository's usual profile is a default; a supplied profile overrides it without changing repository identity.

For the candidate CLI, use `ap run --repo <enrolled repository> --profile <converted profile> --task ... --preview` before admission. Scripts that import credentials into profiles or link provider accounts to profiles must instead authenticate an account and reference its ID from the AI preset. Old profile API errors are upgrade failures, not reasons to retry with guessed defaults.

## Dispatcher-managed callers

`packages/daemon/src/managed/profile-set-config.ts` continues to parse `reviewed-profile-set-v1`, including each native managed profile snapshot, its digest, budget and repository enrollment. This is the authoritative managed envelope. A reusable configuration profile ID is not a replacement for that envelope, and must not be substituted into `profileSnapshot.profileId` by name matching.

Before deployment, compare the actual Dispatcher enrollment and reviewed profile-set definitions against their current contract, then explicitly review any mapping to reusable local configuration. Preserve repository enrollment, budgets, route constraints, scope, source-delivery authority and snapshot digests. A mapping cannot enable native Goals, new write grants or a different backend merely because a preset supports them for regular pods.

The external Dispatcher deployment and Pi consumer implementation were not inspected or edited in this local candidate review. Their exact deployment compatibility remains a release check; the local managed regression suite covers the retained AutoPod side of the contract.
