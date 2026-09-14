import { describe, expect, it } from 'vitest';
import { createPodRepository } from '../pods/pod-repository.js';
import { createTaskHistoryArchive } from '../pods/task-history-archive.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { admitLaunch } from './launch-admission.js';
import { resolveLaunch } from './launch-resolver.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';

describe('analysis workspace admission and project history', () => {
  it('uses explicit work, requires interactive Task and refuses an unscoped project export', async () => {
    const db = createTestDb();
    try {
      const { services } = createTestConfiguration(db);
      const request = {
        repositoryId: 'repo-a',
        task: 'Analyze',
        work: { analysis: { kind: 'history' } },
      };
      await expect(resolveLaunch(request, services)).rejects.toMatchObject({
        code: 'ANALYSIS_WORKFLOW_REQUIRED',
      });
      const overrides = {
        workflow: { agentMode: 'interactive', output: 'artifact', validationPhases: [] },
      };
      const config = await resolveLaunch({ ...request, overrides }, services);
      expect(config.work.analysis).toEqual({
        kind: 'history',
        scope: 'repository',
        limit: 100,
        failuresOnly: false,
      });
      await expect(
        resolveLaunch(
          {
            emptyWorkspace: true,
            profileId: 'profile',
            task: 'Analyze',
            work: request.work,
            overrides,
          },
          services,
        ),
      ).rejects.toMatchObject({ code: 'ANALYSIS_REPOSITORY_REQUIRED' });
      const all = await resolveLaunch(
        {
          emptyWorkspace: true,
          profileId: 'profile',
          task: 'Analyze',
          overrides,
          work: { analysis: { kind: 'history', scope: 'all' } },
        },
        services,
      );
      expect(all.work.analysis?.kind).toBe('history');
      expect(
        (await resolveLaunch({ repositoryId: 'repo-a', task: '[history] | {}' }, services)).work
          .analysis,
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it('filters by frozen repository before the limit, including archived pods sharing a profile', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      for (const [id, repositoryId] of [
        ['a', 'repo-a'],
        ['b', 'repo-b'],
      ] as const) {
        await admitLaunch({
          request: { repositoryId, task: 'Task' },
          actorId: 'user',
          services,
          snapshots,
          createPod: () => insertConfigurationTestPod(db, id),
        });
      }
      const pods = createPodRepository(db);
      expect(
        pods.listForHistory?.({ repositoryId: 'repo-a', limit: 1 }).map((pod) => pod.id),
      ).toEqual(['a']);
      db.transaction(() => {
        createTaskHistoryArchive(db)('a');
        db.prepare('DELETE FROM pods WHERE id=?').run('a');
      })();
      expect(
        pods.listForHistory?.({ repositoryId: 'repo-a', limit: 1 }).map((pod) => pod.id),
      ).toEqual(['a']);
      expect(pods.listForHistory?.({ repositoryId: 'repo-b' }).map((pod) => pod.id)).toEqual(['b']);
    } finally {
      db.close();
    }
  });
});
