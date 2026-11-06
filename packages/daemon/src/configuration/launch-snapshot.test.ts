import type { EffectiveLaunchConfig, ExecutionRequirements } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { configurationDigest } from './configuration-digest.js';
import { resolveLaunch } from './launch-resolver.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';

function withRequirements(
  config: EffectiveLaunchConfig,
  executionRequirements: ExecutionRequirements,
) {
  const { digest: _digest, ...body } = config;
  const next = {
    ...body,
    work: {
      ...body.work,
      contract: {
        contractVersion: 1 as const,
        title: 'Final requirements',
        dependsOn: [],
        scenarios: [],
        requiredFacts: [],
        humanReview: [],
        executionRequirements,
      },
    },
  };
  return { ...next, digest: configurationDigest(next) };
}

it('checks new final configs but returns durable receipts before static or mutable admission checks', async () => {
  const db = createTestDb();
  try {
    const { store, services } = createTestConfiguration(db);
    const snapshots = createLaunchSnapshotRepository(db, store);
    const config = withRequirements(
      await resolveLaunch({ repositoryId: 'repo-a', task: 'Original' }, services),
      {
        version: 2,
        executables: [],
        platform: 'linux/amd64',
      },
    );
    const createPod = vi.fn(() => insertConfigurationTestPod(db, 'final-config'));
    const first = snapshots.admit({
      config,
      requestId: 'original-request',
      requestDigest: 'original-payload',
      createPod,
    });
    expect(first).toEqual({ podId: 'final-config', created: true });
    const invalid = withRequirements(config, {
      version: 2,
      executables: [],
      platform: 'darwin/arm64',
    });
    expect(() =>
      snapshots.admit({
        config: invalid,
        requestId: 'new-request',
        requestDigest: 'new-payload',
        createPod,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXECUTION_PLATFORM_MISMATCH' }));
    const current = vi.spyOn(store, 'assertCurrent').mockImplementation(() => {
      throw new Error('Do not revalidate a receipt');
    });
    expect(
      snapshots.admit({
        config: invalid,
        requestId: 'original-request',
        requestDigest: 'original-payload',
        createPod,
      }),
    ).toEqual({ ...first, created: false });
    expect(current).not.toHaveBeenCalled();
    expect(createPod).toHaveBeenCalledOnce();
    expect(snapshots.get(first.podId)).toEqual(config);
    expect(() =>
      snapshots.admit({
        config: invalid,
        requestId: 'original-request',
        requestDigest: 'different-payload',
        createPod,
      }),
    ).toThrowError(expect.objectContaining({ code: 'REQUEST_CONFLICT' }));
    expect(db.prepare('SELECT count(*) AS n FROM pods').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM pod_launch_snapshots').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
