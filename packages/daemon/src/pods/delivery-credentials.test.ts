import { describe, expect, it } from 'vitest';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import { createEscalationRepository } from './escalation-repository.js';
describe('host push credential parking', () => {
  for (const service of ['github', 'ado'] as const)
    it(`persists ${service} escalation and retained resources through private SQLite reopen`, () => {
      const f = createDeliveryFixture(true);
      f.validating();
      const profile = f.profiles.get('test-profile');
      expect(
        f
          .credentials()
          .parkOnCredentialFailure(
            'prepare',
            new GitCredentialError('synthetic', service, 'push', 'synthetic'),
          ),
      ).toBe(true);
      const saved = f.pod();
      expect(saved).toMatchObject({
        status: 'awaiting_input',
        containerId: 'container-123',
        worktreePath: f.directory,
        escalationCount: 1,
      });
      expect(saved.pendingEscalation?.payload).toMatchObject({ service, source: 'host_push' });
      const id = saved.pendingEscalation?.id;
      if (!id) throw new Error('Missing parked escalation');
      expect(JSON.stringify(saved.pendingEscalation?.payload)).toContain(
        service === 'github' ? 'gh auth login' : 'Azure CLI',
      );
      const next = f.reopen();
      expect(next.pods.getOrThrow('prepare')).toEqual(saved);
      expect(createEscalationRepository(f.db).getOrThrow(id).payload).toEqual(
        saved.pendingEscalation?.payload,
      );
      expect(next.profiles.get('test-profile')).toEqual(profile);
      expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
    });
});
