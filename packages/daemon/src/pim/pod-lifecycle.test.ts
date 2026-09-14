import type { EffectiveLaunchConfig, PimEligibility, PimSelection, Pod } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createPimActivationRepository } from './activation-repository.js';
import { type PimActivationProvider, createPimActivationService } from './activation-service.js';
import { createPimPodLifecycle } from './pod-lifecycle.js';

function fixture() {
  const db = createTestDb();
  const now = () => Date.parse('2026-09-13T00:00:00Z');
  const selection: PimSelection = {
    type: 'group',
    tenantId: 'tenant',
    principalId: 'user',
    eligibilityId: 'eligible',
    roleId: 'member',
    scope: 'group',
    displayName: 'Sandbox access',
    timing: 'startup',
    duration: 'PT1H',
    justification: 'Debug',
  };
  const exact: PimEligibility = {
    ...selection,
    scopeName: 'Sandbox',
    startsAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    maximumDurationMinutes: 60,
    provider: { scheduleId: 'schedule', roleDefinitionId: 'member' },
  };
  const active = {
    status: 'active' as const,
    requestId: 'provider-request',
    assignmentId: 'assignment',
    expiresAt: '2026-09-13T01:00:00Z',
  };
  const provider: PimActivationProvider = {
    existing: vi.fn(async () => null),
    submit: vi.fn(async () => active),
    reconcile: vi.fn(async () => active),
  };
  const eligibility = {
    discover: vi.fn(),
    selected: vi.fn<(_selection: PimSelection) => Promise<PimEligibility>>(async () => exact),
  };
  const repository = createPimActivationRepository(db, now);
  const activation = createPimActivationService(repository, eligibility, provider, now);
  const config = { digest: 'a'.repeat(64), pim: [selection] } as EffectiveLaunchConfig;
  const pod = {
    id: 'pod',
    status: 'provisioning',
    lifecycleGeneration: 1,
    launchConfigDigest: config.digest,
  } as Pod;
  const assertAllowed = vi.fn();
  const lifecycle = createPimPodLifecycle({
    readPod: () => pod,
    readSnapshot: () => config,
    assertAllowed,
    activation,
    repository,
  });
  return { db, config, pod, provider, eligibility, lifecycle, assertAllowed, exact };
}

describe('PIM pod startup', () => {
  it('activates only startup selections and reuses the same request on provisioning retry', async () => {
    const f = fixture();
    try {
      f.config.pim.push({ ...f.config.pim[0]!, eligibilityId: 'manual', timing: 'when-needed' });
      await f.lifecycle.startup('pod', f.config);
      await f.lifecycle.startup('pod', f.config);
      expect(f.provider.submit).toHaveBeenCalledOnce();
      expect(
        f.eligibility.selected.mock.calls.every(([item]) => item.eligibilityId === 'eligible'),
      ).toBe(true);
      f.lifecycle.release('pod');
      expect(f.provider.submit).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });
  it('blocks provisioning while uncertain, then reconciles without a second activation', async () => {
    const f = fixture();
    try {
      vi.mocked(f.provider.submit).mockRejectedValueOnce(new Error('Response lost'));
      await expect(f.lifecycle.startup('pod', f.config)).rejects.toThrow('uncertain');
      await f.lifecycle.startup('pod', f.config);
      expect(f.provider.submit).toHaveBeenCalledOnce();
      expect(f.provider.reconcile).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });
  it('rechecks pod ownership after discovery before submitting an activation', async () => {
    const f = fixture();
    try {
      f.eligibility.selected.mockImplementation(async () => {
        f.pod.lifecycleGeneration += 1;
        return f.exact;
      });
      await expect(f.lifecycle.startup('pod', f.config)).rejects.toThrow('authority changed');
      expect(f.provider.submit).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('rechecks operator revocation and refuses pending approval as active access', async () => {
    const f = fixture();
    try {
      f.assertAllowed.mockImplementation(() => {
        throw new Error('Revoked');
      });
      await expect(f.lifecycle.startup('pod', f.config)).rejects.toThrow('Revoked');
      expect(f.provider.submit).not.toHaveBeenCalled();
      f.assertAllowed.mockReset();
      vi.mocked(f.provider.submit).mockResolvedValue({
        status: 'pending',
        requestId: 'approval',
        assignmentId: null,
        expiresAt: null,
      });
      await expect(f.lifecycle.startup('pod', f.config)).rejects.toThrow('pending');
    } finally {
      f.db.close();
    }
  });
});
