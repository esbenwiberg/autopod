import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { AutopodClient } from './client.js';

it.each([307, 401, 421])('dispatches one retained cleanup POST on HTTP %i', async (status) => {
  const observed: Array<{ method?: string; url?: string; reason: string }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    observed.push({
      method: request.method,
      url: request.url,
      reason: String(JSON.parse(body).reason),
    });
    response.writeHead(status, { 'Content-Type': 'application/json', Location: '/redirected' });
    response.end(JSON.stringify({ message: 'Fixture refused submission' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener address');
    const getToken = vi.fn(async () => 'test-only');
    const client = new AutopodClient({ baseUrl: `http://127.0.0.1:${address.port}`, getToken });
    await expect(
      client.submitRetainedCleanup('exact-pod', {
        id: 'exact-key',
        expectedGeneration: 3,
        expectedBinding: 'a'.repeat(64),
        expectedSessionId: 'session-3',
        reason: 'Discard the unpublished experiment',
        acknowledgeDataLoss: true,
      }),
    ).rejects.toThrow('Fixture refused submission');
    expect(observed).toEqual([
      {
        method: 'POST',
        url: '/pods/exact-pod/retained-cleanup',
        reason: 'Discard the unpublished experiment',
      },
    ]);
    expect(getToken).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
