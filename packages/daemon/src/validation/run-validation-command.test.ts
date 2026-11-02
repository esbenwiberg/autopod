import { PassThrough } from 'node:stream';
import { AutopodError } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import type { ContainerManager, ExecOptions } from '../interfaces/container-manager.js';
import { runValidationCommand } from './run-validation-command.js';

it.each(['exit', 'timeout', 'transport'] as const)(
  'collects streaming output and preserves the native %s outcome without redispatch',
  async (mode) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const failure = new AutopodError(mode, 'EXEC_EXIT_UNVERIFIED', 500);
    const exitCode = new Promise<number>((resolve, reject) => {
      setImmediate(() => {
        stdout.write('x'.repeat(60_000));
        stdout.end('last stdout');
        stderr.write('first stderr');
        stderr.end(' last stderr');
        if (mode === 'exit') resolve(7);
        else reject(failure);
      });
    });
    const execStreaming = vi.fn(async () => ({ stdout, stderr, exitCode, kill: vi.fn() }));
    const execInContainer = vi.fn();
    const manager = { execStreaming, execInContainer } as unknown as ContainerManager;
    const options: ExecOptions = {
      cwd: '/workspace/nested',
      timeout: 900_000,
      env: { SCOPED_FILE: '/run/secrets/scoped', QUOTED: "value ' ; $(false)" },
      assertCurrent: vi.fn(),
    };
    const command = ['sh', '/run/autopod/agent-shim.sh', 'sh', '-c', 'pnpm test'];
    const result = runValidationCommand(manager, 'sandbox', 'exact-container', command, options);
    if (mode === 'exit') {
      const observed = await result;
      expect(observed.exitCode).toBe(7);
      expect(observed.stdout).toHaveLength(50_000);
      expect(observed.stdout).toMatch(/last stdout$/);
      expect(observed.stderr).toBe('first stderr last stderr');
    } else {
      await expect(result).rejects.toBe(failure);
      expect((failure as Error & { partialOutput: string }).partialOutput).toMatch(
        /last stdout\nfirst stderr last stderr$/,
      );
    }
    expect(execStreaming).toHaveBeenCalledExactlyOnceWith('exact-container', command, options);
    expect(execInContainer).not.toHaveBeenCalled();
  },
);

it('retains the Docker buffered execution contract', async () => {
  const expected = { stdout: 'native', stderr: '', exitCode: 0 };
  const execInContainer = vi.fn(async () => expected);
  const execStreaming = vi.fn();
  const manager = { execInContainer, execStreaming } as unknown as ContainerManager;
  const options = { cwd: '/workspace', timeout: 42, env: { VALUE: 'scoped' } };
  await expect(runValidationCommand(manager, 'local', 'docker', ['true'], options)).resolves.toBe(
    expected,
  );
  expect(execInContainer).toHaveBeenCalledExactlyOnceWith('docker', ['true'], options);
  expect(execStreaming).not.toHaveBeenCalled();
});
