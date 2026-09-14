import { describe, expect, it } from 'vitest';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { resolveLaunch } from './launch-resolver.js';
import { ConfigurationSecurityPolicyStore } from './security-policy.js';

describe('independent operator restrictions', () => {
  it('narrows frozen GitHub rules across restart, preserves reusable settings and fences concurrent edits', async () => {
    const db = createTestDb();
    try {
      const { services, store } = createTestConfiguration(db);
      const frozen = await resolveLaunch({ repositoryId: 'repo-a', task: 'Fix' }, services);
      const policy = new ConfigurationSecurityPolicyStore(db);
      const original = policy.get();
      expect(policy.githubCeiling(frozen)).toEqual(frozen.githubAccess);
      const saved = policy.write(
        { ...original.payload, blockedGitHubOperations: ['code.read'] },
        original.revision,
        'user',
      );
      expect(
        new ConfigurationSecurityPolicyStore(db).githubCeiling(frozen)[0]?.rule.operations,
      ).toEqual([]);
      expect(frozen.githubAccess[0]?.rule.operations).toEqual(['code.read']);
      expect(store.get('githubAccess', 'access').revision).toBe(1);
      expect(() => policy.write({}, original.revision, 'other')).toThrow('changed');
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM configuration_security_policy_history').get(),
      ).toEqual({ n: 1 });
      policy.write({ ...saved.payload, suspended: true }, saved.revision, 'user');
      expect(() => policy.assertLaunch(frozen)).toThrow('suspended');
    } finally {
      db.close();
    }
  });
});
