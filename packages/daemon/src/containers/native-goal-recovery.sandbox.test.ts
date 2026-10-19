import { randomUUID } from 'node:crypto';
import type { NativeGoalProcessIdentity } from '@autopod/shared';
import pino from 'pino';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';
import { SandboxContainerManager } from './sandbox-container-manager.js';

/** Opt-in actual Azure proof. Creates and deletes one isolated, credential-free sandbox. */
it.skipIf(!process.env.AUTOPOD_GOAL_SANDBOX_FIXTURE)(
  'recovers an exact owned process on a fresh client and fences a delayed start',
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
      .parse(JSON.parse(process.env.AUTOPOD_GOAL_SANDBOX_FIXTURE ?? '{}'));
    const logger = pino({ level: 'silent' });
    const config = { ...settings, assumeGroupExists: true };
    const client = new AzureSandboxApiClient(config, logger);
    const id = await client.createSandbox({
      image: settings.image,
      tier: 'M',
      podId: `native-goal-proof-${randomUUID()}`,
      egressPolicy: { defaultAction: 'Deny', hostRules: [] },
    });
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const manager = new SandboxContainerManager(client, logger);
      let identity: NativeGoalProcessIdentity | undefined;
      const stream = await manager.execStreaming(id, ['sh', '-c', 'echo READY; sleep 240 & wait'], {
        onProcessCreated(value) {
          identity = structuredClone(value);
        },
      });
      const ready = (async () => {
        for await (const value of stream.stdout) {
          if (value.toString().includes('READY')) return true;
        }
        return false;
      })();
      expect(
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            readyTimer = setTimeout(
              () => reject(new Error('Sandbox fixture did not start')),
              20000,
            );
          }),
        ]),
      ).toBe(true);
      clearTimeout(readyTimer);
      if (!identity) throw new Error('Missing recorded process identity');
      const restarted = new AzureSandboxApiClient(config, logger);
      const code = await restarted.terminateRecordedExec(identity);
      expect(await stream.exitCode).toBe(code);
      expect(await restarted.terminateRecordedExec(identity)).toBe(code);
      expect(await restarted.getStatus(id)).toBe('running');
      const privateState = await restarted.exec(id, [
        'sh',
        '-c',
        `test ! -r ${identity.pidPath} && test ! -w ${identity.pidPath}`,
      ]);
      expect(privateState.exitCode).toBe(0);
      let late: NativeGoalProcessIdentity | undefined;
      const unstarted = restarted.execStream(id, ['sh', '-c', 'echo must-not-run'], {
        onProcessCreated(value) {
          late = value;
          throw new Error('Persistence refused');
        },
      });
      await expect(unstarted.next()).rejects.toThrow('Persistence refused');
      if (!late) throw new Error('Missing delayed-start fixture identity');
      expect(await restarted.terminateRecordedExec(late)).toBe(0);
      const delayed = await restarted.exec(
        id,
        [late.pidPath.replace('/state.json', '/supervisor.py')],
        { user: 'root' },
      );
      expect(delayed.stdout).toBe('');
      expect(delayed.exitCode).toBe(0);
    } finally {
      clearTimeout(readyTimer);
      await client.destroy(id);
    }
  },
  180000,
);
