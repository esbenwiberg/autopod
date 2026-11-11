import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { runHostRecoveryReader } from './recovery-file-reader.js';
import type { SandboxApiClient, SandboxExecOptions } from './sandbox-api-client.js';
import { SandboxContainerManager } from './sandbox-container-manager.js';

const roots: string[] = [];
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sandbox-files-'));
  roots.push(root);
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 255, 1, 200]));
  const client = {
    getStatus: vi.fn<SandboxApiClient['getStatus']>(async () => 'running'),
    resume: vi.fn(),
    delete: vi.fn(),
    exec: vi.fn(async (_id: string, command: string[], options?: SandboxExecOptions) => {
      options?.beforeSend?.();
      expect(options).toMatchObject({
        singleAttempt: true,
        timeoutMs: 15000,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      });
      const args = [...command];
      const index = args.indexOf('/workspace');
      expect(index).toBeGreaterThan(0);
      args[index] = root;
      return { stdout: await runHostRecoveryReader(args), stderr: '', exitCode: 0 };
    }),
  };
  const manager = new SandboxContainerManager(
    client as unknown as SandboxApiClient,
    pino({ level: 'silent' }),
  );
  return { client, manager };
}
it('executes the actual bounded descriptor reader behind the sandbox seam and returns byte-exact data', async () => {
  const f = await fixture();
  const guard = vi.fn();
  const options = { assertCurrent: guard };
  const list = await f.manager.listRecoveryFiles('exact-original', options);
  const file = list.files[0]!;
  const result = await f.manager.readRecoveryFile(
    'exact-original',
    file.path,
    file.version,
    options,
  );
  expect(Buffer.from(result.content, 'base64')).toEqual(Buffer.from([0, 255, 1, 200]));
  expect(f.client.exec).toHaveBeenCalledTimes(2);
  expect(guard).toHaveBeenCalled();
  expect(f.client.resume).not.toHaveBeenCalled();
  expect(f.client.delete).not.toHaveBeenCalled();
});
it('refuses stopped machines and changed ownership without dispatching a read or waking them', async () => {
  const f = await fixture();
  f.client.getStatus.mockResolvedValue('stopped');
  await expect(f.manager.listRecoveryFiles('s', {})).rejects.toThrow('not running');
  await expect(
    f.manager.listRecoveryFiles('s', {
      assertCurrent: () => {
        throw new Error('source changed');
      },
    }),
  ).rejects.toThrow('source changed');
  expect(f.client.exec).not.toHaveBeenCalled();
  expect(f.client.resume).not.toHaveBeenCalled();
});
it('does not replay a lost read command or substitute a saved-source result', async () => {
  const f = await fixture();
  f.client.exec.mockRejectedValue(new Error('transport lost'));
  await expect(f.manager.listRecoveryFiles('s', {})).rejects.toThrow('transport lost');
  expect(f.client.exec).toHaveBeenCalledTimes(1);
  expect(f.client.resume).not.toHaveBeenCalled();
});
