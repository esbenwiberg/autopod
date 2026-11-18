import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { digest, sha256 } from '../managed/canonical.js';
import { parseManagedProfileSetConfig } from '../managed/profile-set-config.js';
import { combinedPolicyDigest } from '../orchestration/combined-attestation.js';
import {
  operatorBasePolicy,
  operatorSeedInput,
  parseOperatorEnrollment,
} from '../orchestration/operator-enrollment.js';
import { operatorRunId } from '../orchestration/operator-runs.js';
import { createHistoricalDiskDatabase, MIGRATIONS_DIR } from './disk-database.js';
import { fixtureSigner } from './gate-signer.js';
import { resign } from './managed-fixture.js';
import { setupOrchestrationRun } from './orchestration-run-fixture.js';

export async function operatorSeedFixture(image: string) {
  const { root, subject: s, request, bytes } = await setupOrchestrationRun();
  const db = createHistoricalDiskDatabase(path.join(root, 'daemon.db'), [
    { dir: MIGRATIONS_DIR, through: 269 },
  ]);
  onTestFinished(() => db.close());
  const f = { db };
  const operator = {
    issuer: 'https://fixture.example/',
    audience: 'fixture-api',
    objectId: 'owner',
    installationId: 'test-installation',
  };
  const slot = 'inspection',
    run = operatorRunId(operator, slot);
  for (const bound of [request.profileSnapshot, request.effectiveGrant]) {
    bound.budget.expiresAt = Math.floor(Date.now() / 1000) + 600;
    bound.budget.maxDurationSeconds = 480;
  }
  request.profileSnapshot.snapshotDigest = digest(
    Object.fromEntries(
      Object.entries(request.profileSnapshot).filter(([k]) => k !== 'snapshotDigest'),
    ),
  );
  request.effectiveGrant.profileSnapshotDigest = request.profileSnapshot.snapshotDigest;
  request.outputs.artifacts.mode = 'required';
  request.outputs.artifacts.include = request.outputs.artifacts.requiredPaths = ['report.md'];
  request.outputs.artifacts.limits = { maxFiles: 1, maxFileBytes: 16384, maxTotalBytes: 16384 };
  resign(request);
  const cli = { bindings: [operator], artifactDirectory: path.join(root, 'artifacts') };
  const profiles = parseManagedProfileSetConfig(
    JSON.stringify({
      mode: 'reviewed-profile-set-v1',
      installationId: operator.installationId,
      profiles: [
        {
          profileSnapshot: request.profileSnapshot,
          taskKind: request.task.kind,
          artifactPath: 'report.md',
          inputNames: [],
          sourceMode: 'none',
        },
      ],
      mirror: {
        enrollmentId: s.repository,
        path: path.join(root, 'does-not-exist'),
        remote: request.profileSnapshot.scope.repositories[0]?.remote,
        baseRevision: s.commit,
      },
      image,
    }),
  );
  if (!profiles) throw new Error('missing-profile');
  const source = {
    commit: s.commit,
    predecessor: s.predecessor,
    tree: s.tree,
    bundleDigest: sha256(bytes),
    bundlePath: path.join(root, 'approved.bundle'),
  };
  await writeFile(source.bundlePath, bytes, { mode: 0o600 });
  const data = {
    main: {
      profileName: 'repofit',
      profileId: 'fixture-profile',
      profileRevision: 2,
      aiId: 'fixture-ai',
      aiRevision: 8,
      model: 'fixture-controller',
      accountId: 'fixture-hosted',
    },
    mission: 'Inspect MAPLE IRIS CEDAR, send one follow-up per defect and none for a clean result.',
    budget: { requests: 18, active: 6, workers: 8, turns: 2 },
    recipes: { inspect: request },
    source,
  };
  const checks = fixtureSigner('checks', 'checker', digest('checks/v1')),
    review = fixtureSigner('independentReview', 'reviewer', digest('review/v1'));
  const authorities = {
    basePolicyDigest: operatorBasePolicy(data, profiles),
    checks: checks.authority,
    independentReview: review.authority,
  };
  const sign = (policy: typeof authorities, reviewer = review, tree = s.tree) => {
    const inputDigest = operatorSeedInput(
      { ...s, run, tree, policyDigest: combinedPolicyDigest(policy) },
      source.bundleDigest,
    );
    return {
      checks: checks.attest({ inputDigest, status: 'passed', evidenceDigest: digest('checked') }),
      review: reviewer.attest({
        inputDigest,
        status: 'passed',
        evidenceDigest: digest('reviewed'),
      }),
    };
  };
  const enrollment = parseOperatorEnrollment(
    JSON.stringify({
      version: 1,
      slot,
      objectId: operator.objectId,
      ...data,
      authorities,
      ...sign(authorities),
    }),
  );
  if (!enrollment) throw new Error('invalid fixture');
  return { enrollment, cli, profiles, f, root, run, sign, source, operator };
}
