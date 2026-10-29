import { describe, expect, it, vi } from 'vitest';
import * as providers from '../providers/index.js';
import { createMemoryBriefingSdkFixture } from '../test-utils/admission-memory-briefing-helpers.js';
import { createAdmissionFixture } from '../test-utils/admission-queries-helpers.js';
import {
  approvedMemoriesForPod,
  podMemoryScopeIds,
  selectMemoryBriefingForPod,
} from './admission-memory-briefing.js';
import { createMemoryUsageRepository } from './memory-usage-repository.js';
describe('complete original memory briefing', () => {
  it('uses the actual default factory binding and forwards a usable reviewer to memory ranking', async () => {
    const s = createMemoryBriefingSdkFixture();
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-key-not-real');
    vi.stubGlobal('fetch', s.fetch);
    const factory = vi
      .spyOn(providers, 'createProfileAnthropicClient')
      .mockResolvedValue({ ok: true, client: s.client, model: 'claude-haiku-4-5' });
    try {
      const profile = s.f.profiles.get('test-profile');
      const result = await selectMemoryBriefingForPod({
        pod: { ...s.f.pod(), task: 'Authentication token refresh' },
        profile,
        memoryRepo: s.f.memoryRepo,
        logger: s.f.deps.logger,
      });
      expect(factory).toHaveBeenCalledOnce();
      expect(s.fetch).toHaveBeenCalledOnce();
      expect(result.unavailableReason).toBeNull();
      expect(result.selected.map((entry) => entry.memory.id)).toEqual([s.memory.id]);
      expect(result.selected[0]?.relevanceReason).toContain('Fixture reviewer selected');
    } finally {
      factory.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      s.f.db.close();
    }
  });
  it('deduplicates parent scopes and excludes shared profile memory for native pods', () => {
    const f = createAdmissionFixture();
    const list = vi.spyOn(f.memoryRepo, 'list');
    const pod = { ...f.pod(), dependsOnPodIds: ['prepare', 'parent', 'parent'] };
    expect(podMemoryScopeIds(pod)).toEqual(['prepare', 'parent']);
    approvedMemoriesForPod({ ...pod, launchConfigDigest: 'native' }, f.memoryRepo);
    expect(list.mock.calls).toEqual([
      ['pod', 'prepare', true],
      ['pod', 'parent', true],
      ['global', null, true],
    ]);
  });
  it('does not initialize a reviewer for interactive or empty candidate sets', async () => {
    const f = createAdmissionFixture();
    const createReviewerClient = vi.fn(async () => {
      throw new Error('Must not run');
    });
    const base = {
      pod: f.pod(),
      profile: f.profiles.get('test-profile'),
      memoryRepo: f.memoryRepo,
      logger: f.deps.logger,
      createReviewerClient,
    };
    await expect(
      selectMemoryBriefingForPod({
        ...base,
        pod: { ...base.pod, options: { ...base.pod.options, agentMode: 'interactive' } },
      }),
    ).resolves.toEqual({ selected: [], unavailableReason: null });
    await expect(selectMemoryBriefingForPod(base)).resolves.toEqual({
      selected: [],
      unavailableReason: null,
    });
    expect(createReviewerClient).not.toHaveBeenCalled();
  });
  it('uses original deterministic fail-soft ranking after an injected reviewer failure', async () => {
    const f = createAdmissionFixture();
    const memory = f.memoryRepo.insert({
      id: 'memory',
      scope: 'profile',
      scopeId: 'test-profile',
      path: '/auth-token.md',
      content: 'Authentication token refresh workflow',
      rationale: null,
      kind: 'workflow',
      tags: ['auth'],
      appliesWhen: null,
      avoidWhen: null,
      confidence: 0.9,
      sourceEvidence: [],
      impactSummary: null,
      approved: true,
      createdByPodId: null,
    });
    const createReviewerClient = vi.fn(async () => {
      throw new Error('Synthetic unavailable');
    });
    const usageRepo = createMemoryUsageRepository(f.db);
    const result = await selectMemoryBriefingForPod({
      usageRepo,
      pod: { ...f.pod(), task: 'Authentication token refresh' },
      profile: f.profiles.get('test-profile'),
      memoryRepo: f.memoryRepo,
      logger: f.deps.logger,
      createReviewerClient,
    });
    expect(result.unavailableReason).toBe('reviewer_model_client_unavailable');
    expect(result.selected.map((e) => e.memory.id)).toEqual([memory.id]);
    expect(createReviewerClient).toHaveBeenCalledOnce();
    expect(
      usageRepo
        .listByPod('prepare')
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['injected', 'selected']);
  });
});
