import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExternalDeliveryFixture } from '../test-utils/external-delivery-helpers.js';
import { createExternalDeliveryRepository } from './external-delivery-repository.js';

const fixtures: ReturnType<typeof createExternalDeliveryFixture>[] = [];
function fixture(disk = false) {
  const f = createExternalDeliveryFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

function noMutation(f: ReturnType<typeof fixture>) {
  expect(f.cm.start).not.toHaveBeenCalled();
  expect(f.cm.kill).not.toHaveBeenCalled();
  expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
  expect(f.provider.createPr).not.toHaveBeenCalled();
  expect(f.provider.mergePr).not.toHaveBeenCalled();
  expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
  expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
  expect(f.captured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
}

describe('source-verified external delivery before sandbox preservation', () => {
  it('records actual delivery with reports pending, without fabricating requests or deleting the sandbox', async () => {
    const f = fixture();
    const original = f.pod();
    await f.approve();
    expect(f.pod()).toMatchObject({
      status: 'complete',
      containerId: original.containerId,
      worktreePath: original.worktreePath,
      lastValidationResult: original.lastValidationResult,
      validationWaiver: null,
    });
    expect(f.podRepo.externalDeliveries?.get('prepare')).toMatchObject({
      podId: 'prepare',
      generation: original.lifecycleGeneration,
      headSha: f.source.commitSha,
      treeSha: f.source.treeSha,
      actor: { type: 'human', userId: 'operator' },
      reports: 'pending',
      retainedSandboxId: original.containerId,
    });
    expect(f.pod().readinessReview?.findings).toContainEqual(
      expect.objectContaining({ id: 'external-delivery-reports-pending' }),
    );
    expect(f.pod().readinessReview?.approval?.actor).toEqual({ type: 'human', userId: 'operator' });
    expect(f.db.prepare('SELECT count(*) AS n FROM source_publication_intents').get()).toEqual({
      n: 0,
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM merge_intents').get()).toEqual({ n: 0 });
    noMutation(f);
  });
  it('keeps observations immutable and retains the resource across repository reconstruction', async () => {
    const f = fixture(true);
    await f.approve();
    const receipt = f.podRepo.externalDeliveries?.get('prepare');
    expect(createExternalDeliveryRepository(f.db).get('prepare')).toEqual(receipt);
    expect(createExternalDeliveryRepository(f.db).retainedSandboxIds()).toEqual(['container-123']);
    expect(() =>
      f.db.prepare("UPDATE external_delivery_observations SET sandbox_id='other'").run(),
    ).toThrow('immutable');
    expect(() => f.db.prepare('DELETE FROM external_delivery_observations').run()).toThrow(
      'immutable',
    );
    f.refresh.refreshReadiness('prepare', { advisoryQaInFlight: false });
    expect(
      f
        .pod()
        .readinessReview?.findings.filter(
          (finding) => finding.id === 'external-delivery-reports-pending',
        ),
    ).toHaveLength(1);
  });
  it.each(['repository', 'branch', 'baseBranch'] as const)(
    'rejects another %s before wakeup',
    async (field) => {
      const f = fixture();
      f.provider.getPrStatus.mockResolvedValue({
        ...f.status,
        sourceTarget: {
          ...f.target,
          [field]: field === 'repository' ? 'https://github.com/other/repo' : 'other',
        },
      });
      await expect(f.approve()).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
      expect(f.pod().status).toBe('validated');
      expect(f.podRepo.externalDeliveries?.get('prepare')).toBeNull();
      noMutation(f);
    },
  );
  it.each([
    'dirty',
    'different-head',
    'different-branch',
    'unavailable-inspector',
    'missing-head',
    'missing-target',
  ])('refuses %s proof', async (scenario) => {
    const f = fixture();
    if (scenario === 'dirty') f.source.worktreeClean = false;
    if (scenario === 'different-head') f.source.commitSha = 'c'.repeat(40);
    if (scenario === 'different-branch') f.source.branch = 'other';
    if (scenario === 'unavailable-inspector') f.worktreeManager.inspectSource = undefined;
    if (scenario === 'missing-head')
      f.provider.getPrStatus.mockResolvedValue({ ...f.status, headSha: undefined });
    if (scenario === 'missing-target')
      f.provider.getPrStatus.mockResolvedValue({ ...f.status, sourceTarget: undefined });
    await expect(f.approve()).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    expect(f.podRepo.externalDeliveries?.get('prepare')).toBeNull();
    noMutation(f);
  });
  it('rejects closed/unmerged disposition and unavailable provider rather than mutating or waking', async () => {
    const f = fixture();
    f.provider.getPrStatus.mockResolvedValue({ ...f.status, merged: false });
    await expect(f.approve()).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    noMutation(f);
    f.provider.getPrStatus.mockRejectedValue(new Error('Provider unavailable'));
    await expect(f.approve()).rejects.toThrow('Provider unavailable');
    noMutation(f);
  });
  it.each(['deleted', 'unknown'] as const)(
    'does not claim a %s sandbox was retained',
    async (state) => {
      const f = fixture();
      vi.mocked(f.cm.getStatus).mockResolvedValue(state);
      await expect(f.approve()).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
      expect(f.podRepo.externalDeliveries?.get('prepare')).toBeNull();
      noMutation(f);
    },
  );

  it('records public repository identity without embedded legacy credentials', async () => {
    const f = fixture();
    const profile = f.captured.executionForPod(f.pod());
    const url = new URL(profile.repoUrl);
    url.username = 'private-user';
    url.password = 'private-placeholder';
    f.captured.executionForPod = () => ({ ...profile, repoUrl: url.toString() });
    await f.approve();
    expect(f.podRepo.externalDeliveries?.get('prepare')?.repository).not.toContain('private-');
  });

  it('does not accept an automated legacy adoption', async () => {
    const f = fixture();
    await expect(
      f.workflow().approveSession('prepare', { automation: true }),
    ).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    noMutation(f);
  });
  it.each(['generation', 'pr', 'validation'] as const)(
    'fences a changed %s during provider observation',
    async (change) => {
      const f = fixture();
      f.provider.getPrStatus.mockImplementation(async () => {
        if (change === 'generation') f.podRepo.incrementLifecycleGeneration('prepare');
        if (change === 'pr')
          f.podRepo.update('prepare', { prUrl: 'https://github.com/org/repo/pull/99' });
        if (change === 'validation') {
          const previous = f.pod().lastValidationResult;
          if (!previous) throw new Error('Missing validation fixture');
          f.podRepo.update('prepare', { lastValidationResult: { ...previous, overall: 'fail' } });
        }
        return f.status;
      });
      await expect(f.approve()).rejects.toThrow();
      expect(f.podRepo.externalDeliveries?.get('prepare')).toBeNull();
      noMutation(f);
    },
  );
  it('rolls back observation, approval and all status changes when settlement fails', async () => {
    const f = fixture();
    const transition = f.captured.transition;
    vi.spyOn(f.captured, 'transition').mockImplementation((pod, next, changes) => {
      if (next === 'merging') throw new Error('Synthetic settlement failure');
      return transition(pod, next, changes);
    });
    await expect(f.approve()).rejects.toThrow('Synthetic settlement failure');
    expect(f.pod().status).toBe('validated');
    expect(f.podRepo.externalDeliveries?.get('prepare')).toBeNull();
    noMutation(f);
  });
});
