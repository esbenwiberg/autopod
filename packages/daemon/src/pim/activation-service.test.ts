import type { PimEligibility, PimSelection } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createPimActivationRepository } from './activation-repository.js';
import {
  type PimActivationProvider,
  type PimProviderActivation,
  createPimActivationService,
} from './activation-service.js';

const selection: PimSelection = {
  type: 'group',
  tenantId: 'tenant',
  principalId: 'user',
  eligibilityId: 'eligibility',
  roleId: 'member',
  scope: 'group',
  displayName: 'Sandbox',
  timing: 'when-needed',
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
function fixture() {
  const db = createTestDb();
  let time = Date.parse('2026-09-13T00:00:00Z');
  const now = () => time;
  const repository = createPimActivationRepository(db, now);
  const active: PimProviderActivation = {
    status: 'active',
    requestId: 'provider-request',
    assignmentId: 'assignment',
    expiresAt: '2026-09-13T01:00:00Z',
  };
  const provider: PimActivationProvider = {
    existing: vi.fn(async () => null),
    submit: vi.fn(async () => active),
    reconcile: vi.fn(async () => active),
  };
  const eligibility = { selected: vi.fn(async () => exact), discover: vi.fn() };
  const service = createPimActivationService(repository, eligibility, provider, now);
  return {
    db,
    repository,
    provider,
    eligibility,
    service,
    active,
    now,
    advance: () => {
      time += 3600_001;
    },
  };
}
describe('PIM activation leases', () => {
  it('shares one activation and releasing one pod does not revoke another lease', async () => {
    const f = fixture();
    try {
      const a = await f.service.request('a', 'request', selection, () => {});
      const b = await f.service.request('b', 'request', selection, () => {});
      expect(a.id).toBe(b.id);
      expect(f.provider.submit).toHaveBeenCalledOnce();
      expect(f.repository.usable('a', 'request')).toBe(true);
      f.service.release('a');
      expect(f.repository.usable('a', 'request')).toBe(false);
      expect(f.repository.usable('b', 'request')).toBe(true);
      f.advance();
      expect(f.repository.usable('b', 'request')).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it('reuses pre-existing access without claiming ownership or issuing a mutation', async () => {
    const f = fixture();
    try {
      vi.mocked(f.provider.existing).mockResolvedValue({ ...f.active, requestId: null });
      const result = await f.service.request('a', 'request', selection, () => {});
      expect(result.ownership).toBe('pre-existing');
      expect(f.provider.submit).not.toHaveBeenCalled();
      f.service.release('a');
      expect(f.repository.get(result.id).ownership).toBe('pre-existing');
    } finally {
      f.db.close();
    }
  });
  it('does not repeat an uncertain activation and keeps pending approval unusable', async () => {
    const f = fixture();
    try {
      vi.mocked(f.provider.submit).mockRejectedValueOnce(new Error('Response lost'));
      let result = await f.service.request('a', 'request', selection, () => {});
      expect(result.status).toBe('uncertain');
      expect(f.repository.usable('a', 'request')).toBe(false);
      vi.mocked(f.provider.reconcile).mockResolvedValue({
        status: 'pending',
        requestId: result.id,
        assignmentId: null,
        expiresAt: null,
      });
      result = await f.service.request('a', 'request', selection, () => {});
      expect(result.status).toBe('pending');
      expect(f.provider.submit).toHaveBeenCalledOnce();
      expect(f.repository.usable('a', 'request')).toBe(false);
      await expect(
        f.service.request('a', 'request', { ...selection, justification: 'Changed' }, () => {}),
      ).rejects.toThrow('reused');
    } finally {
      f.db.close();
    }
  });
  it('preserves uncertainty across restart and rechecks authorization immediately before effects', async () => {
    const f = fixture();
    try {
      const reserved = f.repository.reserve('a', 'request', selection, exact);
      f.repository.claim(reserved.id);
      const restarted = createPimActivationRepository(f.db, f.now);
      expect(restarted.recoverInterrupted()).toBe(1);
      expect(restarted.get(reserved.id).status).toBe('uncertain');
      const authorize = vi
        .fn()
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw new Error('Revoked');
        });
      await expect(
        f.service.request('b', 'other', { ...selection, eligibilityId: 'other' }, authorize),
      ).rejects.toThrow();
      expect(f.provider.submit).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('rejects a duration above the actual provider policy before reserving or activating', async () => {
    const f = fixture();
    try {
      await expect(
        f.service.request('a', 'request', { ...selection, duration: 'PT8H' }, () => {}),
      ).rejects.toThrow('duration');
      expect(f.provider.submit).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
});
