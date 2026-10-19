# Connected desktop acceptance — 2026-10-19

Original verdict: **FAILED readiness** at the revision below. The two failures
are now repaired and proven locally; see [fleet display repair](fleet-display-repair.md).
Hosted rollout/recheck remain pending, so readiness is still incomplete.

The original run had passing configuration persistence and app
isolation checks. PR #439 remains draft. Implementation tested:
`9c64410d78be170f5520c8373f0b258a4ca28fc3`. Freshly fetched `origin/main` is
`6e51d1ce9495235e6aac2e498393cd2dd9a0e66b`, already included in this branch.
No implementation changes were made during this proof run.

## Passing checks

| Claim | Observed evidence | Result |
| --- | --- | --- |
| Preview connects to the real daemon | Native Setup sheet tested and saved a Microsoft connection named Hosted acceptance using the refreshed existing CLI session. Real records loaded. | Proven |
| Real saves persist across process restart | Created only `Codex desktop acceptance 2026-10-19 (disposable)`, repository ID `79bc950b-0981-48ef-8f62-05c289dceda4`. Saved prepare/SAST commands and a credential reference; independent authenticated API read matched exactly. Quit Preview, built normal Preview without startup fixtures, relaunched, restored connection and reopened revision 1 with the same values. | Proven |
| Invalid input retains the draft | Native save of an invalid remote showed the daemon URL error with the name and input retained. Empty credential ID save showed the daemon schema error. Revert restored the saved reference and cleared dirty/error state. | Proven |
| References stay references | API payload held `buildEnv.ACCEPTANCE_TOKEN = {secretId: desktop-acceptance-missing-credential}`; reopened form retained its credential switch and ID. This deliberately nonexistent reference tested representation, not secret availability. | Proven within that scope |
| Test configuration cleanup | Native Archive removed only the disposable repository. GET by ID returned HTTP 409 with `error: CONFIG_ARCHIVED`. | Proven |
| Existing configuration remained unchanged | Before/after ID, revision and SHA-256 comparisons of every active repository, profile and credential metadata record matched: 23 repositories, 27 profiles, one credential metadata record. | Proven |
| Current app stays separate | Current app retained its original AutoPod connection while Preview used Hosted acceptance. Bundle/defaults identity, Keychain service and connect deep-link scheme are distinct. | Proven for observed stores and connection state |
| Validation / secondary navigation | Real combined-toad validation rendered one horizontal strip of nine icon/status cards, with build/tests passed and remaining phases skipped; Evidence rendered its left section rail. Work's Task/Plan/Summary/Deviations/Process/Cost controls were reachable with its saved summary. | Proven for exercised states |
| Settings / themes / Village | Connected Settings rendered in Light, then was restored to Dark. Village loaded its native web renderer and empty state, with live activity connected. | Proven for exercised states |
| Other workspace reachability | Real Schedules, History, Analytics and standalone Series data loaded through native navigation; no jobs or pod actions were run. | Proven for reachability, not every action |

The normal signed Preview build passed `./scripts/build-desktop-preview.sh`,
including strict deep code-signature verification. All three GitHub checks at
implementation revision `9c64410d` passed: CI build-and-test, Desktop
test-and-build and secret-scan. The preceding full local suite passed 573 Swift
Testing tests plus 13 XCTest tests; it was not rerun for this documentation-only
acceptance record.

## Blocker 1: repository identity and filtering

1. Connect Preview to the hosted daemon and open All pods.
2. Cards show Repository unavailable. The repository menu contains only All
   repositories.
3. Open valid-goldfish. The detail header still says Repository unavailable.
4. The real `/pods/valid-goldfish/configuration` response contains the captured
   remote `https://github.com/esbenwiberg/todo-canary.git`.
5. History and standalone Series also render unknown/unavailable repository.

`DesktopRepository.resolve` reads the retired `profileSnapshot` and current
legacy profile name/URL. Modern pods have null legacy snapshots, while the
captured repository lives in the effective launch configuration. Compact fleet
responses expose neither a safe captured repository display identity nor the
launch configuration. Opening the full pod therefore does not repair identity.

Required follow-up: carry a bounded, credential-free captured repository identity
through discovery, mapping and shared presentation, with legacy fallback and a
truthful empty-workspace distinction. Verify card/header labels, search and
repository filters across Fleet, History and Series against modern records.
Do not restore identity by inferring it from mutable profile names or task text,
or by fetching every large pod/configuration document on every fleet refresh.

## Blocker 2: milestone counts disappear until hydration

1. On the initial fleet list, combined-toad shows No report.
2. Its full pod API response has progress currentPhase 3, totalPhases 3.
3. Select the card: after detail hydration the same card changes to M3/3.

CompactPod exposes only `progressSummary`, not structured milestone counts;
`PodMapper.map(CompactPodResponse)` therefore leaves the UI phase absent. This
contradicts the requested milestone display before opening each pod.

Required follow-up: include bounded structured reported progress in compact
responses and mapping, preserving lifecycle/milestone separation, invalid-count
handling and correct merge/refresh ownership. Prove the initial card shows M3/3
without selection and remains correct across refresh.

## Evidence and boundaries

Native captures were inspected locally and retained under `/private/tmp`:

- `autopod-connected-invalid-draft.png`
- `autopod-connected-commands-reopened.png`
- `autopod-connected-reference-reopened.png`
- `autopod-connected-empty-credential-error.png`
- `autopod-connected-fleet-repository-failure.png`
- `autopod-connected-validation.png`
- `autopod-connected-village.png`
- `autopod-connected-settings-light.png`
- `autopod-connected-current-app-unchanged.png`

API evidence: `autopod-connected-baseline.json`, `autopod-connected-saved.json`
and `autopod-connected-cleanup.json`. Baseline/cleanup contain metadata hashes,
not credentials. Initial cleanup verification incorrectly looked for `code`;
the actual daemon response uses `error`. The corrected check asserted HTTP 409
and CONFIG_ARCHIVED and passed without changing application behavior.

Credential existence/permission resolution, private feed access, command
execution, terminal input, pod launch/approval/merge, active Village pod
navigation and every failure/running detail state were not exercised. No new
provider work was launched or credential grants changed. Browser custom-protocol
navigation was blocked and not bypassed; the native connection form plus the
approved existing CLI session provided the successful connection instead.
