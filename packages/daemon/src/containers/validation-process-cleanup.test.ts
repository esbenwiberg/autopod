import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { processGroupProbeScript, terminatePidFileScript } from './azure-sandbox-api-client.js';

const exec = promisify(execFile);

it.each(['gone', 'unreadable', 'member', 'zombie'] as const)(
  'process-group proof distinguishes vanished entries from unknown/live members: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'validation-proc-fixture-'));
    const directory = join(root, '222');
    await mkdir(directory);
    const statFile = join(directory, 'stat');
    await writeFile(statFile, `222 (fixture process) ${mode === 'zombie' ? 'Z' : 'S'} 1 111 1 0\n`);
    try {
      const probe = processGroupProbeScript().replaceAll('/proc/', `${root}/`);
      const cat =
        mode === 'gone'
          ? `cat() { rm -f '${statFile}'; rmdir '${directory}'; /bin/cat "$@"; }`
          : mode === 'unreadable'
            ? 'cat() { return 1; }'
            : 'cat() { /bin/cat "$@"; }';
      const result = await exec('sh', [
        '-c',
        `pid=111; ${cat}; ${probe}; if group_alive; then echo held; else echo absent; fi`,
      ]);
      expect(result.stdout.trim()).toBe(
        mode === 'member' || mode === 'unreadable' ? 'held' : 'absent',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux').each(['graceful', 'forced', 'stale'] as const)(
  'verifies owned process group cleanup: %s',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'validation-cleanup-'));
    const receipt = join(dir, 'process.pid');
    const child = spawn(
      'sh',
      [
        '-c',
        [
          'stat=$(cat /proc/$$/stat); rest=${stat##*) }; set -- $rest',
          mode === 'forced' ? "trap '' TERM" : "trap 'exit 0' TERM",
          // Publish readiness only once the requested signal disposition exists.
          `printf '%s %s\\n' "$$" "\${20}" > '${receipt}'`,
          'while :; do sleep 0.1; done',
        ].join('; '),
      ],
      { detached: true, stdio: 'ignore' },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    try {
      let identity = '';
      for (let i = 0; i < 100; i++) {
        try {
          identity = await readFile(receipt, 'utf8');
        } catch {
          /* await startup */
        }
        if (identity.trim()) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(identity.trim()).not.toBe('');
      if (mode === 'stale') {
        await writeFile(receipt, `${child.pid} 0\n`);
        await expect(exec('sh', ['-c', terminatePidFileScript(receipt)])).rejects.toThrow();
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
      } else {
        await exec('sh', ['-c', terminatePidFileScript(receipt)], { timeout: 6000 });
        await exited;
        expect(child.exitCode === 0 || child.signalCode === 'SIGKILL').toBe(true);
        if (mode === 'forced') expect(child.signalCode).toBe('SIGKILL');
        else expect(child.exitCode).toBe(0);
      }
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid, 'SIGKILL');
      }
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  },
  10_000,
);
