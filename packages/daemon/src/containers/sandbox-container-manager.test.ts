import { AutopodError } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { SandboxContainerManager } from './sandbox-container-manager.js';

const logger = pino({ level: 'silent' });

function makeManager(): SandboxContainerManager {
  return new SandboxContainerManager(
    { subscriptionId: 'sub-1', resourceGroup: 'rg-1', location: 'westeurope' },
    logger,
  );
}

describe('SandboxContainerManager (scaffold)', () => {
  it('throws NOT_IMPLEMENTED with actionable guidance until the backend is wired', async () => {
    const mgr = makeManager();
    const config: ContainerSpawnConfig = { image: 'img', podId: 'p1', env: {} };

    await expect(mgr.spawn(config)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      statusCode: 501,
    });
    await expect(mgr.spawn(config)).rejects.toThrow(/spikes\/aca-sandbox/);
    await expect(mgr.spawn(config)).rejects.toBeInstanceOf(AutopodError);
  });

  it('rejects every ContainerManager method (not yet wired)', async () => {
    const mgr = makeManager();
    const calls: Promise<unknown>[] = [
      mgr.kill('c1'),
      mgr.stop('c1'),
      mgr.start('c1'),
      mgr.refreshFirewall('c1', 'script'),
      mgr.writeFile('c1', '/tmp/x', 'data'),
      mgr.readFile('c1', '/tmp/x'),
      mgr.readFileBinary('c1', '/tmp/x'),
      mgr.extractDirectoryFromContainer('c1', '/src', '/dst'),
      mgr.getStatus('c1'),
      mgr.execInContainer('c1', ['echo', 'hi']),
      mgr.execStreaming('c1', ['echo', 'hi']),
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
