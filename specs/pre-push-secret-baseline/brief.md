# Baseline pre-existing secrets in push diff scans

## Goal

Fix Autopod's push-checkpoint `diff` security scan so formatting or unrelated edits do not turn Secretlint findings already present in the same base-revision file into blocking pod failures, while every newly introduced exposure remains fail-closed.

The triggering incident is hosted pod `civil-donkey`: a required repository-wide formatting pass touched Scruffy files containing deliberate synthetic AWS-key fixtures and local PostgreSQL development defaults. Eighteen pre-existing matches blocked validation. A nineteenth connection string was newly added in CI and must continue to block until removed; this Autopod fix must not waive it.

## Root cause

`packages/daemon/src/security/file-walker.ts:listDiffFiles()` selects changed paths, after which `packages/daemon/src/security/scan-engine.ts` scans each current file in full. The engine never compares current Secretlint occurrences with the same path at its resolved base ref. Consequently, “finding in a changed file” is treated as “finding introduced by this change.”

The behavior dates to security scanning commit `4dc8b4f9`. Commit `0d816969` fixed missing-base fallback but did not add occurrence-level baselining.

## Required implementation

For a push-checkpoint scan with effective `diff` scope and a successfully resolved base ref:

1. Read the same changed path from the resolved base revision when it exists.
2. Run only detectors that support safe baseline identity comparison against that base content. This task adds that support for Secretlint; do not baseline ML PII or injection findings.
3. Derive an opaque internal identity from the Secretlint rule and exact matched range. The raw match and identity must never enter public `ScanFinding` data, persistence, logs, warning sections, API output, or PR bodies.
4. Subtract base occurrences from current occurrences as a multiset, scoped to the same path. One base occurrence exempts only one equal current occurrence.
5. Fail closed: unresolved refs, missing base paths, read errors, detector errors, or budget exhaustion must not suppress current findings.

Behavioral boundaries:

- Formatting or line movement around the same exact matched value in the same path does not block.
- New and rotated values block.
- A second copy of an existing value in the same path blocks.
- Copying or moving an existing value to another path blocks.
- Provisioning scans and full-scope push scans continue reporting all matches.
- Existing missing-base behavior from `0d816969` remains intact.

Prefer a detector-internal identity mechanism (for example an opaque digest associated privately with a finding) over extending shared/persisted `ScanFinding`. Do not compare line numbers or four-character redacted snippets; both are unsafe identities.

## Likely files

- `packages/daemon/src/security/detectors/detector.ts`
- `packages/daemon/src/security/detectors/secretlint-detector.ts`
- `packages/daemon/src/security/detectors/secretlint-detector.test.ts`
- `packages/daemon/src/security/file-walker.ts`
- `packages/daemon/src/security/file-walker.test.ts`
- `packages/daemon/src/security/scan-engine.ts`
- `packages/daemon/src/security/scan-engine.test.ts`

Avoid profile-schema or desktop changes unless the implementation proves they are strictly necessary; this is not a user-configurable suppression feature.

## Non-goals

- Ignoring test, fixture, corpus, documentation, or generated paths.
- Adding an agent-editable ignore/suppression file.
- Waiving newly introduced development or CI credentials.
- Changing provisioning or strict/full-scan semantics.
- Baselining ML PII or prompt-injection findings.
- Recovering or modifying Scruffy/civil-donkey from this Autopod repository worker.

## Validation

Implement every scenario and required fact in `contract.yaml`. Run the focused facts and the normal repository validation appropriate for a security-boundary daemon change. Preserve all unrelated work.

After this fix is validated and deployed, the operator will separately rework `civil-donkey` so its new GitHub Actions PostgreSQL service uses ephemeral localhost-only trust and a passwordless connection URL. The reworked pod should then resume validation: its eighteen unchanged fixtures will be baselined, while the newly added CI password would still block if not removed.
