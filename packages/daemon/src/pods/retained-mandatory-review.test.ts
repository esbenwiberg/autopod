import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeCheckpointFixture,
  recordPreValidationInfrastructure,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';

const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture(independentRoute = true) {
  const f = await retainedCheckpointFixture('validation', true, false, independentRoute);
  fixtures.push(f);
  const launch = f.ctx.deps.launchConfiguration;
  if (!launch) throw new Error('Missing native launch fixture');
  f.deps.readLaunch = launch.read;
  f.deps.executionForPod = () => {
    const config = launch.read(f.podId);
    if (!config) throw new Error('Missing frozen launch');
    return launch.executionSettings(config);
  };
  const evidence = recordPreValidationInfrastructure(f);
  await materializeCheckpointFixture(f);
  vi.stubEnv('DATA_DIR', f.root);
  f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
    const source = await f.worktrees.inspectSourceAdoption(input.worktreePath, input.branch);
    return { head: source.commitSha, tree: source.treeSha, baseCommitSha: f.input.checkpointHead };
  });
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  const retries = f.ctx.podRepo.taskRetries;
  if (!retries) throw new Error('Missing retry ledger');
  retries.authorize(
    f.podId,
    'mandatory-review-checks',
    'One exact-source checks execution with a fresh independent review',
    f.actor,
  );
  return { ...f, launch, evidence };
}

describe('additive retained-continuation independent review', () => {
  it('runs mandatory fresh review despite its absence from the frozen native workflow, without changing that workflow', async () => {
    const f = await fixture();
    const parent = f.launch.read(f.podId);
    expect(parent?.workflow.validationPhases).not.toContain('review');
    expect(parent?.ai.reviewer.mode).toBe('independent');
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation();
    if (!validate) throw new Error('Missing validation mock');
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => {
      expect(config.skipPhases).not.toContain('review');
      expect(config.task).toContain('Mandatory additional recovery check: independent-v1');
      expect(config.skipPhases).toContain('lint');
      expect(config.preSubmitReview).toBeUndefined();
      return {
        ...(await validate(config)),
        taskReview: {
          status: 'pass',
          reasoning: 'Fresh isolated review',
          issues: [],
          model: 'fixture-independent',
          screenshots: [],
          diff: config.diff,
        },
      };
    });
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.recovery.list(f.podId)[0]?.binding.continuation).toMatchObject({
      reviewPolicy: 'independent-v1',
    });
    await f.manager.processPod(f.podId).catch((error) => {
      throw new Error(`status=${f.pod().status}; ${f.pod().failureReason}`, { cause: error });
    });
    expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      blocked: null,
      originalEvidence: { result: null },
      checked: { result: { overall: 'pass', taskReview: { status: 'pass' } } },
    });
    expect(f.launch.read(f.podId)).toEqual(parent);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    // Same-generation legacy force/validationOnly is not a supported second
    // invocation of retained source. It must refuse before preparing inputs.
    await expect(
      f.manager.triggerValidation(f.podId, { force: true, validationOnly: true }),
    ).rejects.toMatchObject({ code: 'CONTINUATION_SOURCE_HELD' });
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.recovery.list(f.podId)[0]?.checked?.result.taskReview?.status).toBe('pass');
  });

  it('does not admit an apparent pass without a new independent review', async () => {
    const f = await fixture();
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    await expect(f.manager.processPod(f.podId)).rejects.toMatchObject({
      code: 'CONTINUATION_REVIEW_UNVERIFIED',
    });
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      checked: null,
      blocked: { code: 'CONTINUATION_REVIEW_UNVERIFIED' },
    });
  });

  it('admits the review obligation only in its owned, activated, exact-source checking scope', async () => {
    const f = await fixture();
    const repo = f.ctx.podRepo.retainedCheckpoints;
    if (!repo) throw new Error('Missing retained ledger');
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    const operation = f.recovery.list(f.podId)[0];
    if (!operation?.activated) throw new Error('Missing activated operation');
    expect(() => repo.requiredReview(f.pod())).toThrow();
    repo.owned(operation.id, () => {
      repo.append(operation.id, 'checking', { generation: operation.activated?.generation });
      f.ctx.podRepo.update(f.podId, { status: 'validating', containerId: 'replacement-resource' });
      expect(repo.requiredReview(f.pod())).toBe(true);
      for (const drift of [
        { lifecycleGeneration: f.pod().lifecycleGeneration + 1 },
        { worktreePath: '/unselected/source' },
        { containerId: operation.containerId },
        { status: 'running' as const },
      ])
        expect(() => repo.requiredReview({ ...f.pod(), ...drift })).toThrow();
    });
    expect(() => repo.requiredReview(f.pod())).toThrow();
  });

  it('keeps thin validation blocked even with a frozen independent reviewer', async () => {
    const f = await fixture();
    f.ctx.podRepo.update(f.podId, { options: { ...f.pod().options, validationSuite: 'thin' } });
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toThrow(
      'independent review',
    );
    expect(f.recovery.list(f.podId)).toEqual([]);
  });

  it('does not manufacture an independent route for a self-review-only launch', async () => {
    const f = await fixture(false);
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toThrow(
      'independent review',
    );
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });
});
