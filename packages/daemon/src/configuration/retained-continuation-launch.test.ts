import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { environmentImageKey } from '../images/environment-image-key.js';
import { createRetainedCheckpointRecovery } from '../pods/retained-checkpoint-recovery.js';
import { retainedCheckpointFixture } from '../test-utils/retained-checkpoint-helpers.js';
import { resolveLaunchExecutionSettings } from './launch-execution-settings.js';
import {
  type RetainedExecutionSelection,
  retainedContinuationLaunch,
} from './retained-continuation-launch.js';

const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const f = await retainedCheckpointFixture('validation', true, true);
  fixtures.push(f);
  const launch = f.ctx.deps.launchConfiguration!;
  const parent = launch.read(f.podId)!;
  const environment = { ...parent.environment, template: 'node24' as const };
  const resolvedEnvironment = {
    ...parent.resolvedEnvironment,
    pinnedBase: `sha256:${'a'.repeat(64)}`,
  };
  resolvedEnvironment.imageKey = environmentImageKey({ environment, ...resolvedEnvironment });
  const main = { ...parent.resolvedExecution.main, memoryGb: 8, cpus: 2 };
  const selection: RetainedExecutionSelection = {
    profileId: 'qualified-local',
    parentDigest: parent.digest,
    environment,
    resolvedEnvironment,
    target: 'local',
    main,
    resolvedExecution: {
      ...parent.resolvedExecution,
      target: 'local',
      main,
      sidecars: {},
      totalMemoryGb: 8,
      totalCpus: 2,
    },
    digest: '',
  };
  selection.digest = retainedContinuationLaunch(parent, f.podId, selection).digest;
  f.deps.readLaunch = launch.read;
  f.deps.executionSettings = launch.executionSettings;
  f.deps.executionForPod = () => launch.executionSettings(launch.read(f.podId)!);
  f.deps.previewExecution = async () => structuredClone(selection);
  f.worktrees.selectRetainedContinuationSource = async () => ({
    head: f.prepared.head,
    tree: f.prepared.tree,
    baseCommitSha: '1'.repeat(40),
  });
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  return { f, parent, selection, launch };
}

describe('retained execution selection', () => {
  it('changes only explicitly selected software and resources, preserving all task authority', async () => {
    const { f, parent, selection } = await fixture();
    const next = retainedContinuationLaunch(parent, f.podId, selection);
    expect(next.environment.template).toBe('node24');
    expect(next.resolvedExecution.main.memoryGb).toBe(8);
    expect(next.execution.target).toBe('local');
    for (const key of [
      'repository',
      'ai',
      'agentAccounts',
      'credentialReferences',
      'workflow',
      'pim',
      'toolPacks',
      'toolContents',
      'githubAccess',
      'references',
      'work',
      'task',
    ] as const)
      expect(next[key]).toEqual(parent[key]);
    expect(next.execution.networkPolicy).toEqual(parent.execution.networkPolicy);
    expect(parent.environment.template).not.toBe('node24');
  });

  it('records the selected execution before atomically detaching; active reads retain original snapshot history', async () => {
    const { f, parent, selection, launch } = await fixture();
    const original = f.pod();
    const taskId = f.ctx.podRepo.taskExecutions!.snapshot(f.podId).taskId;
    await f.recovery.continueRetained(
      f.podId,
      {
        ...f.input,
        executionProfileId: selection.profileId,
        expectedExecutionDigest: selection.digest,
      },
      f.actor,
    );
    await f.recovery.wait(f.input.id);
    const record = f.recovery.list(f.podId)[0]!;
    expect(record.blocked, JSON.stringify(f.deps.logger.error)).toBeNull();
    expect(record.containerId).toBe(original.containerId);
    expect(record.binding.continuation?.execution).toMatchObject({
      digest: selection.digest,
      parentDigest: parent.digest,
    });
    expect(f.pod()).toMatchObject({
      executionTarget: 'local',
      launchConfigDigest: selection.digest,
      skipAgent: true,
      status: 'queued',
      validationAttempts: original.validationAttempts,
    });
    expect(launch.read(f.podId)?.digest).toBe(selection.digest);
    expect(launch.read(f.podId)?.workflow).toEqual(parent.workflow);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).taskId).toBe(taskId);
    expect(
      resolveLaunchExecutionSettings(launch.read(f.podId)!, {
        image: selection.resolvedEnvironment.pinnedBase,
      }).containerMemoryGb,
    ).toBe(8);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
  });

  it('rejects stale execution previews before claiming or detaching the original', async () => {
    const { f, selection } = await fixture();
    const original = f.pod();
    await expect(
      f.recovery.continueRetained(
        f.podId,
        {
          ...f.input,
          executionProfileId: selection.profileId,
          expectedExecutionDigest: 'f'.repeat(64),
        },
        f.actor,
      ),
    ).rejects.toThrow('preview changed');
    expect(f.pod()).toEqual(original);
    expect(f.recovery.list(f.podId)).toEqual([]);
  });

  it.each(['parent', 'digest', 'sidecars', 'resources', 'image'] as const)(
    'refuses inconsistent %s evidence',
    async (kind) => {
      const { f, parent, selection } = await fixture();
      if (kind === 'parent') selection.parentDigest = 'f'.repeat(64);
      if (kind === 'digest') selection.digest = 'f'.repeat(64);
      if (kind === 'sidecars') selection.resolvedExecution.sidecars = { unsafe: selection.main };
      if (kind === 'resources')
        selection.resolvedExecution.main = { ...selection.main, memoryGb: 4 };
      if (kind === 'image') selection.resolvedEnvironment.imageKey = 'f'.repeat(64);
      expect(() => retainedContinuationLaunch(parent, f.podId, selection)).toThrow();
    },
  );
});
