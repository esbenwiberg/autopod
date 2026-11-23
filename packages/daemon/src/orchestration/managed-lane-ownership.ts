import type Database from 'better-sqlite3';

/** When composing saved delegation, fix the complete recovery partition before
 * any runtime resumes. A request or profile ID cannot select an owner lane. */
export function createManagedLaneOwnership(
  db: Database.Database,
  input: {
    ordinaryInstallations: readonly string[];
    signedRun?: string;
    savedOwnerDigest: string;
    separateSignedRuntime: boolean;
  },
) {
  const { signedRun, savedOwnerDigest, separateSignedRuntime } = input;
  const ordinaryIds = new Set(input.ordinaryInstallations);
  if (
    [...ordinaryIds].some((id) => id.startsWith('native.')) ||
    (separateSignedRuntime && !signedRun)
  )
    throw new Error('managed-lane-binding-invalid');
  const savedRun = db
    .prepare(`SELECT a.owner_digest FROM saved_delegation_admissions a
    JOIN parent_managed_runs p ON p.run_id=a.run_id
    JOIN orchestration_runs r ON r.id=a.run_id AND r.operator_owned=1
    WHERE a.run_id=?`)
    .pluck();
  if (signedRun && savedRun.get(signedRun)) throw new Error('managed-lane-ownership-overlap');
  const ordinary = (installation: string) => ordinaryIds.has(installation);
  const signed = (installation: string) =>
    signedRun !== undefined && installation === `native.${signedRun}`;
  const saved = (installation: string) =>
    installation.startsWith('native.') && savedRun.get(installation.slice(7)) === savedOwnerDigest;
  return {
    ordinary,
    signed,
    saved,
    ordinaryRuntime: (installation: string) =>
      ordinary(installation) || (!separateSignedRuntime && signed(installation)),
    assertRecovery() {
      // Even a queued parent with no worker yet requires the configured saved owner.
      if (
        db
          .prepare(`SELECT 1 FROM saved_delegation_admissions a
        JOIN orchestration_runs r ON r.id=a.run_id WHERE r.canceled=0 AND a.owner_digest<>? LIMIT 1`)
          .get(savedOwnerDigest)
      )
        throw new Error('saved-delegation-unconfigured-owner-retained');
      const unresolved = db
        .prepare(`SELECT DISTINCT dispatcher_installation_id AS installation
        FROM managed_pods WHERE observed_exit=0 OR (runtime_ref IS NOT NULL AND cleanup<>'observed')`)
        .all() as { installation: string }[];
      for (const { installation } of unresolved) {
        const owners =
          Number(ordinary(installation)) +
          Number(signed(installation)) +
          Number(saved(installation));
        if (!owners) throw new Error('saved-delegation-pilot-unrelated-managed-work-retained');
        if (owners !== 1) throw new Error('managed-lane-ownership-overlap');
      }
    },
  };
}
