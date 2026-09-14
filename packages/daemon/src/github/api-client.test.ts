import { describe, expect, it, vi } from 'vitest';
import { createGitHubApiClient } from './api-client.js';
import type { DaemonGitHubAuth } from './daemon-github-auth.js';

const auth: DaemonGitHubAuth = {
  resolveCredential: async () => ({ token: 'fixture-auth-value', username: 'x-access-token' }),
  getStatus: async () => ({ available: true, login: 'operator', setup: '' }),
};
describe('GitHub API transport', () => {
  it('rejects other origins and prevents authenticated redirect following', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"id":1}', { status: 200 }));
    const client = createGitHubApiClient(auth, fetcher);
    expect(await client.get('/repositories/1')).toEqual({ id: 1 });
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://api.github.com/repositories/1'),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-auth-value' }),
      }),
    );
    await expect(client.get('//example.com')).rejects.toThrow('could not read');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds responses and does not retry an uncertain write', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    const client = createGitHubApiClient(auth, fetcher);
    await expect(client.get('/repositories/1')).rejects.toThrow('could not read');
    fetcher.mockRejectedValue(new Error('connection lost'));
    await expect(
      client.mutate('POST', '/repos/org/repo/actions/workflows/1/dispatches', { ref: 'main' }),
    ).rejects.toThrow('connection lost');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
