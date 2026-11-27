import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';
import { SandboxContainerManager } from './sandbox-container-manager.js';

/** Parent-only opt-in witness. Never targets an existing pod/profile/resource. */
it.skipIf(!process.env.AUTOPOD_PREPARATION_SANDBOX_FIXTURE)(
  'witnesses one-start long preparation, failure and timeout in a disposable Sandbox',
  async () => {
    const settings = z
      .object({
        subscriptionId: z.string().uuid(),
        resourceGroup: z.string().min(1),
        location: z.string().min(1),
        sandboxGroup: z.string().min(1),
        image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .parse(JSON.parse(process.env.AUTOPOD_PREPARATION_SANDBOX_FIXTURE ?? '{}'));
    const logger = pino({ level: 'silent' });
    const client = new AzureSandboxApiClient({ ...settings, assumeGroupExists: true }, logger);
    const id = await client.createSandbox({
      image: settings.image,
      tier: 'M',
      podId: `preparation-proof-${randomUUID()}`,
      egressPolicy: { defaultAction: 'Deny', hostRules: [] },
    });
    try {
      const manager = new SandboxContainerManager(client, logger);
      const marker = `/tmp/preparation-starts-${randomUUID()}`;
      const command = (tail: string) => ['sh', '-c', `echo start >> '${marker}'; ${tail}`];
      const options = { timeout: 120000, maxOutputBytes: 65536, requireObservedExit: true };
      const started = Date.now();
      expect(await manager.execObserved(id, command('sleep 35; printf prepared'), options)).toEqual(
        { exitCode: 0, stdout: 'prepared', stderr: '' },
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(35000);
      expect(await manager.execObserved(id, command('printf failed >&2; exit 7'), options)).toEqual(
        { exitCode: 7, stdout: '', stderr: 'failed' },
      );
      await expect(
        manager.execObserved(id, command('sleep 120'), { ...options, timeout: 30000 }),
      ).rejects.toMatchObject({ execution: { cause: 'timeout', cleanup: 'confirmed' } });
      const count = await manager.execInContainer(id, ['sh', '-c', `wc -l < '${marker}'`], {
        timeout: 5000,
        maxOutputBytes: 256,
      });
      expect(count.exitCode).toBe(0);
      expect(count.stdout.trim()).toBe('3');
    } finally {
      await client.destroy(id);
    }
  },
  180000,
);
