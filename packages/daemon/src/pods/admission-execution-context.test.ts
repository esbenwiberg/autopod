import { describe, expect, it, vi } from 'vitest';
import { createAdmissionFixture } from '../test-utils/admission-queries-helpers.js';
describe('admission execution context', () => {
  it('uses captured legacy profile and isolates frozen daemon injections', () => {
    const f = createAdmissionFixture();
    expect(f.context.executionForPod(f.pod())).toEqual(f.profiles.get('test-profile'));
    expect(f.context.injectionsForPod(f.pod())).toBe(f.deps.daemonConfig);
    expect(f.context.injectionsForPod({ ...f.pod(), launchConfigDigest: 'frozen' })).toEqual({
      mcpServers: [],
      claudeMdSections: [],
      skills: [],
    });
  });
  it('fails closed for a missing native launch and uses the live replacement read/projector', async () => {
    const f = createAdmissionFixture();
    const pod = { ...f.pod(), launchConfigDigest: 'missing' };
    expect(() => f.context.executionForPod(pod)).toThrow('Immutable launch');
    const n = await f.native();
    const profile = f.profiles.get('test-profile');
    f.live.launchConfiguration = {
      read: () => n.config,
      executionSettings: () => profile,
      assertCurrentCapabilities: async () => {},
    };
    expect(f.context.executionForPod(pod)).toBe(profile);
  });
  it('requires a scoped secret adapter only when frozen references require it', async () => {
    const f = createAdmissionFixture();
    const n = await f.native();
    expect(f.context.executionCredentialsFor(n.config)).toBeUndefined();
    expect(() =>
      f.context.executionCredentialsFor({
        ...n.config,
        credentialReferences: {
          secret: {
            secretId: 'synthetic',
            createdAt: '2026-10-19T00:00:00Z',
            purposes: ['build-env'],
            origins: [],
          },
        },
      }),
    ).toThrow('Scoped execution credentials');
  });
  it('validates exact GitHub hostname before consulting live canonical auth and never uses a profile PAT', async () => {
    const f = createAdmissionFixture();
    const profile = f.profiles.get('test-profile');
    await expect(
      f.context.resolveGitCredential({
        ...profile,
        repoUrl: 'https://github.com.attacker.invalid/o/r',
      }),
    ).rejects.toThrow('exact github.com');
    await expect(
      f.context.resolveGitCredential({ ...profile, repoUrl: 'invalid' }),
    ).rejects.toThrow('invalid repository URL');
    f.live.githubAuth = {
      resolveCredential: vi.fn(async () => ({ token: 'synthetic-token', username: 'fixture' })),
    };
    await expect(
      f.context.resolveGitCredential({ ...profile, repoUrl: 'https://GitHub.com/o/r' }),
    ).resolves.toBe('synthetic-token');
  });
  it('routes ADO through the live token adapter without GitHub repository checks', async () => {
    const f = createAdmissionFixture();
    const token = vi.fn(async () => 'synthetic-ado');
    f.live.azureDevOpsAuth = { getToken: token };
    await expect(
      f.context.resolveGitCredential({
        ...f.profiles.get('test-profile'),
        prProvider: 'ado',
        repoUrl: null,
      }),
    ).resolves.toBe('synthetic-ado');
    expect(token).toHaveBeenCalledOnce();
  });
});
