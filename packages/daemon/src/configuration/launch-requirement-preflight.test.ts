import type { ExecutionRequirements, SpecContract } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { admitLaunch } from './launch-admission.js';
import { resolveLaunch } from './launch-resolver.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';

const contract = (executionRequirements: ExecutionRequirements): SpecContract => ({
  contractVersion: 1,
  title: 'Strict worker prerequisites',
  dependsOn: [],
  scenarios: [],
  requiredFacts: [],
  humanReview: [],
  executionRequirements,
});
const request = (requirements: ExecutionRequirements) => ({
  repositoryId: 'repo-a',
  task: 'Implement with explicit prerequisites',
  work: { contract: contract(requirements) },
});

describe('strict launch requirement admission', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('freezes valid v2 requirements and exact daemon-resolved references without changing gates', async () => {
    const { services, store } = createTestConfiguration(db);
    const requirements: ExecutionRequirements = {
      version: 2,
      executables: ['node'],
      platform: 'linux/amd64',
      minimumMemoryBytes: 1024 ** 3,
      minimumCpu: 1,
      requiredReferenceRepositories: [{ repositoryId: 'repo-b', commitSha: 'a'.repeat(40) }],
    };
    const input = {
      ...request(requirements),
      referenceRepositories: [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
      requestId: 'strict-admission',
    };
    const preview = await resolveLaunch(input, services);
    const snapshots = createLaunchSnapshotRepository(db, store);
    const createPod = vi.fn(() => insertConfigurationTestPod(db, 'strict'));
    const admitted = await admitLaunch({
      request: { ...input, expectedDigest: preview.digest },
      actorId: 'operator',
      services,
      snapshots,
      createPod,
    });
    expect(createPod).toHaveBeenCalledOnce();
    expect(admitted.config.work.contract?.executionRequirements).toEqual(requirements);
    expect(snapshots.get('strict')).toEqual(preview);
    expect(preview.workflow.validationPhases).toEqual(['build', 'test']);
    expect(preview.workflow).toEqual(
      (await resolveLaunch({ repositoryId: 'repo-a', task: 'Legacy' }, services)).workflow,
    );
    expect(services.referenceRevision).toHaveBeenCalledWith(expect.anything(), 'main');
    // Changing an executable changes the frozen digest rather than rebuilding software.
    const changed = await resolveLaunch(
      { ...input, work: { contract: contract({ ...requirements, executables: ['node', 'git'] }) } },
      services,
    );
    expect(changed.digest).not.toBe(preview.digest);
    expect(changed.resolvedEnvironment).toEqual(preview.resolvedEnvironment);
    await expect(
      resolveLaunch(
        {
          ...input,
          expectedDigest: preview.digest,
          work: { contract: contract({ ...requirements, executables: ['git'] }) },
        },
        services,
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_CHANGED' });
  });

  it.each<
    [ExecutionRequirements, Array<{ repositoryId: string; ref: string; access: 'read' }>, string]
  >([
    [{ version: 2, executables: [], platform: 'darwin/arm64' }, [], 'EXECUTION_PLATFORM_MISMATCH'],
    [{ version: 2, executables: [], platform: 'linux/arm64' }, [], 'EXECUTION_PLATFORM_MISMATCH'],
    [
      {
        version: 2,
        executables: [],
        requiredReferenceRepositories: [{ repositoryId: 'repo-b', commitSha: 'a'.repeat(40) }],
      },
      [],
      'EXECUTION_REFERENCE_MISSING',
    ],
    [
      {
        version: 2,
        executables: [],
        requiredReferenceRepositories: [{ repositoryId: 'repo-b', commitSha: 'b'.repeat(40) }],
      },
      [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
      'EXECUTION_REFERENCE_MISMATCH',
    ],
    [
      { version: 2, executables: ['docker'], requiresImageBuild: true },
      [],
      'EXECUTION_IMAGE_BUILD_UNSUPPORTED',
    ],
  ])('rejects unsupported/missing strict requirements before pod insertion (%j)', async (requirements, references, code) => {
    const { services, store } = createTestConfiguration(db);
    const createPod = vi.fn(() => insertConfigurationTestPod(db, 'must-not-exist'));
    // Operator labels, even Docker/Mac labels, never override resolved software or qualify builds.
    store.write({
      id: 'env',
      kind: 'environment',
      name: 'Declared, not qualified',
      expectedRevision: 1,
      payload: { template: 'node22', capabilities: ['node', 'docker', 'macos', 'image-build'] },
    });
    await expect(
      admitLaunch({
        request: { ...request(requirements), referenceRepositories: references },
        actorId: 'operator',
        services,
        snapshots: createLaunchSnapshotRepository(db, store),
        createPod,
      }),
    ).rejects.toMatchObject({ code });
    expect(createPod).not.toHaveBeenCalled();
    expect(db.prepare('SELECT id FROM pods WHERE id=?').get('must-not-exist')).toBeUndefined();
  });

  it('rechecks strict requirements on original frozen follow-ups, not just current-preset launches', async () => {
    const { services } = createTestConfiguration(db);
    const parent = await resolveLaunch({ repositoryId: 'repo-a', task: 'Original' }, services);
    services.readLaunch = () => parent;
    await expect(
      resolveLaunch(
        {
          ...request({ version: 2, executables: [], platform: 'darwin/amd64' }),
          source: { podId: 'parent', digest: parent.digest, configuration: 'original' },
        },
        services,
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_PLATFORM_MISMATCH' });
  });

  it('does not substitute a moved reference after preview and accepts an exact SHA-256 revision', async () => {
    const { services } = createTestConfiguration(db);
    const input = {
      ...request({
        version: 2,
        executables: [],
        requiredReferenceRepositories: [{ repositoryId: 'repo-b', commitSha: 'a'.repeat(64) }],
      }),
      referenceRepositories: [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
    };
    vi.mocked(services.referenceRevision).mockResolvedValue('a'.repeat(64));
    const preview = await resolveLaunch(input, services);
    vi.mocked(services.referenceRevision).mockResolvedValue('b'.repeat(64));
    await expect(
      resolveLaunch({ ...input, expectedDigest: preview.digest }, services),
    ).rejects.toThrow();
    // There is no task-text dependency inference.
    expect(
      await resolveLaunch(
        { repositoryId: 'repo-a', task: 'Use Docker and native Mac checks' },
        services,
      ),
    ).not.toHaveProperty('work.contract.executionRequirements');
  });
});
