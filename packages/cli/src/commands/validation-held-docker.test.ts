import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerValidationHeldDockerCommand } from './validation-held-docker.js';

const close: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
  process.exitCode = 0;
});
it('defaults to preview and journals one exact request before an uncertain write', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const root = await mkdtemp(path.join(os.tmpdir(), 'held-cli-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'request.json'),
    daemon = 'https://fixture.invalid';
  const call = vi.fn(async (_id: string, request?: unknown) => {
    if (typeof request === 'object') {
      expect(JSON.parse(await readFile(file, 'utf8')).request).toEqual(request);
      throw new Error('fixture lost reply');
    }
    return { podId: 'held-fixture', state: 'eligible', blockers: [], message: 'fixture' };
  });
  const client = {
    cleanupDaemonIdentity: daemon,
    validationHeldDocker: call,
  } as unknown as AutopodClient;
  const run = async (args: string[]) => {
    const program = new Command();
    registerValidationHeldDockerCommand(program, () => client);
    await program.parseAsync(['node', 'ap', 'stop-validation-held', 'held-fixture', ...args]);
  };
  await run([]);
  expect(call).toHaveBeenLastCalledWith('held-fixture', undefined);
  await run([
    '--apply',
    '--request-file',
    file,
    '--request-id',
    'exact-stop',
    '--daemon-identity',
    daemon,
    '--generation',
    '1',
    '--binding',
    'a'.repeat(64),
    '--reason',
    'Stop exactly this execution and retain evidence',
  ]);
  expect(call).toHaveBeenCalledTimes(2);
  await run(['--observe', '--request-file', file]);
  expect(call).toHaveBeenLastCalledWith('held-fixture', 'exact-stop');
  expect(call.mock.calls.filter((c) => typeof c[1] === 'object')).toHaveLength(1);
});
