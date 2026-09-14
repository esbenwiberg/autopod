import { expect, it } from 'vitest';
import { createGoalRepository } from '../pods/goal-repository.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { deriveLaunch } from './derive-launch.js';
import { admitLaunch } from './launch-admission.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';

it('records Task rework only after native achievement and confirmed stop, keeping the original Goal', async () => {
  const db = createTestDb();
  try {
    const { store, services } = createTestConfiguration(db);
    const snapshots = createLaunchSnapshotRepository(db, store);
    const admitted = await admitLaunch({
      request: { repositoryId: 'repo-a', task: 'Make tests pass', intent: 'goal' },
      actorId: 'user',
      services,
      snapshots,
      createPod: () => insertConfigurationTestPod(db, 'pod'),
    });
    const goals = createGoalRepository(db);
    const goal = goals.create('pod', admitted.config.task, 'codex');
    const fence = { generation: 1, attemptId: 'native' };
    goals.beginAttempt('pod', goal.revision, fence, 'codex');
    goals.bindSession('pod', fence, 'native-session');
    db.prepare("UPDATE pods SET status='validating' WHERE id='pod'").run();
    const config = deriveLaunch(admitted.config, {
      source: { kind: 'goal-rework', podId: 'pod', digest: admitted.config.digest },
      task: 'Fix the validation finding',
    });
    const activate = () =>
      snapshots.activateGoalRework({ config, expectedGeneration: 1, apply: () => {} });
    expect(activate).toThrow('achieved');
    goals.observe('pod', fence, {
      sequence: 1,
      state: 'achieved',
      nativeStatus: 'achieved',
      nativeSessionId: 'native-session',
      objective: goal.objective,
      cumulativeTokens: 42,
      cumulativeSeconds: 2,
    });
    expect(activate).toThrow('stopped');
    goals.confirmStopped('pod', fence);
    const env = store.get('environment', 'env');
    store.write({
      ...env,
      expectedRevision: env.revision,
      payload: { ...env.payload, template: 'node24' },
    });
    activate();
    expect(snapshots.get('pod')).toMatchObject({
      intent: 'task',
      task: 'Fix the validation finding',
      environment: { template: 'node22' },
    });
    expect(snapshots.getOriginal('pod')).toEqual(admitted.config);
    expect(goals.get('pod')).toMatchObject({
      state: 'achieved',
      observedTokens: 42,
      nativeSessionId: 'native-session',
    });
    expect(activate).toThrow();
  } finally {
    db.close();
  }
});
