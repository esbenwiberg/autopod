import { AutopodError } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';

const logger = pino({ level: 'silent' });

function makeClient(): AzureSandboxApiClient {
  return new AzureSandboxApiClient(
    { subscriptionId: 'sub-1', resourceGroup: 'rg-1', location: 'westeurope' },
    logger,
  );
}

describe('AzureSandboxApiClient (stub)', () => {
  it('throws NOT_IMPLEMENTED with actionable guidance from createSandbox', async () => {
    const client = makeClient();
    await expect(
      client.createSandbox({
        image: 'img',
        tier: 'L',
        egressPolicy: { defaultAction: 'Allow', rules: [] },
      }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED', statusCode: 501 });
    await expect(
      client.createSandbox({
        image: 'img',
        tier: 'L',
        egressPolicy: { defaultAction: 'Allow', rules: [] },
      }),
    ).rejects.toThrow(/spikes\/aca-sandbox\/probe\.py/);
  });

  it('rejects every data-plane method until the preview SDK is wired', async () => {
    const client = makeClient();
    const calls: Promise<unknown>[] = [
      client.destroy('s1'),
      client.exec('s1', ['echo', 'hi']),
      client.writeFile('s1', '/tmp/x', Buffer.from('data')),
      client.readFile('s1', '/tmp/x'),
      client.updateEgress('s1', { defaultAction: 'Deny', rules: [] }),
      client.suspend('s1'),
      client.resume('s1'),
      client.getStatus('s1'),
    ];
    const results = await Promise.allSettled(calls);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(AutopodError);
        expect(r.reason.code).toBe('NOT_IMPLEMENTED');
      }
    }
  });
});
