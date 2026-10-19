import { createHash } from 'node:crypto';
import type { Pod, ReasoningEffort } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { createProfileStore } from '../profiles/index.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import {
  nativeSessionId,
  profileReferenceForAttempt,
  reasoningEffortFromSnapshot,
  redactedProfileSnapshot,
  resolvedReasoningEffort,
} from './provider-attempt-policy.js';
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  try {
    const repo = createPodRepository(db);
    repo.insert({
      id: 'policy',
      profileName: 'test-profile',
      task: 'Task',
      status: 'running',
      runtime: 'claude',
      model: 'opus',
      executionTarget: 'local',
      branch: 'branch',
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    return { pod: repo.getOrThrow('policy'), profile: createProfileStore(db).get('test-profile') };
  } finally {
    db.close();
  }
}
describe('provider attempt snapshot policy', () => {
  it('redacts nested sensitive keys and URLs without mutating the supplied snapshot', () => {
    const { pod, profile } = fixture();
    const snapshot = {
      name: 'retained',
      credentials: { apiKey: 'synthetic' },
      nested: {
        PASSWORD: 'synthetic',
        clientSecret: 'synthetic',
        accessToken: 'synthetic',
        apiKey: 'synthetic',
        api_key: 'synthetic',
        authorization: 'synthetic',
        extraHeaders: ['synthetic'],
        env: { A: 'synthetic' },
        githubPat: 'synthetic',
        auth: 'synthetic',
        safe: [
          { endpoint: 'https://user:pass@example.test/path?q=synthetic#fragment', count: 3 },
          null,
        ],
      },
      ordinary: 'ordinary :// text',
    };
    const before = structuredClone(snapshot);
    const result = redactedProfileSnapshot(
      { ...pod, profileSnapshot: snapshot as unknown as Pod['profileSnapshot'] },
      profile,
    );
    expect(result).toEqual({
      name: 'retained',
      credentials: null,
      nested: {
        PASSWORD: null,
        clientSecret: null,
        accessToken: null,
        apiKey: null,
        api_key: null,
        authorization: null,
        extraHeaders: null,
        env: null,
        githubPat: null,
        auth: null,
        safe: [{ endpoint: 'https://example.test/path', count: 3 }, null],
      },
      ordinary: 'ordinary :// text',
    });
    expect(snapshot).toEqual(before);
    expect(result).not.toBe(snapshot);
  });
  it('uses a pod snapshot before current defaults and hashes only the supplied redacted bytes', () => {
    const { pod, profile } = fixture();
    const snapshot = { name: 'saved', reasoningEffort: 'high' };
    const saved = { ...pod, profileSnapshot: snapshot as unknown as Pod['profileSnapshot'] };
    expect(redactedProfileSnapshot(saved, profile)).toEqual(snapshot);
    const redacted = redactedProfileSnapshot({ ...pod, profileSnapshot: null }, profile);
    expect(redacted.name).toBe('test-profile');
    expect(redacted.providerCredentials).toBeNull();
    const reference = profileReferenceForAttempt(pod, snapshot);
    expect(reference).toBe(
      `pod:policy@profile-snapshot#${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16)}`,
    );
    expect(reference).toMatch(/^pod:policy@profile-snapshot#[a-f0-9]{16}$/);
    expect(profileReferenceForAttempt(pod, { ...snapshot, name: 'changed' })).not.toBe(reference);
  });
  it.each(['claude', 'codex', 'pi', 'copilot'] as const)(
    'selects the %s native session',
    (runtime) => {
      const { pod } = fixture();
      expect(
        nativeSessionId({
          ...pod,
          runtime,
          claudeSessionId: 'claude',
          codexSessionId: 'codex',
          piSessionId: 'pi',
        }),
      ).toBe(runtime === 'copilot' ? null : runtime);
    },
  );
  it.each(['auto', 'low', 'medium', 'high', 'xhigh'] as const)(
    'retains valid %s snapshot reasoning over defaults',
    (effort) => {
      const { profile } = fixture();
      expect(reasoningEffortFromSnapshot({ reasoningEffort: effort })).toBe(effort);
      expect(
        resolvedReasoningEffort(
          { ...profile, reasoningEffort: 'low' },
          { reasoningEffort: effort },
        ),
      ).toBe(effort);
    },
  );
  it.each([undefined, null, '', 'max', 3, false, {}])(
    'falls back from invalid snapshot reasoning %j',
    (effort) => {
      const { profile } = fixture();
      expect(reasoningEffortFromSnapshot({ reasoningEffort: effort })).toBeNull();
      expect(
        resolvedReasoningEffort(
          { ...profile, reasoningEffort: 'medium' },
          { reasoningEffort: effort },
        ),
      ).toBe('medium');
      expect(
        resolvedReasoningEffort({ ...profile, reasoningEffort: null as ReasoningEffort | null }),
      ).toBe('auto');
    },
  );
});
