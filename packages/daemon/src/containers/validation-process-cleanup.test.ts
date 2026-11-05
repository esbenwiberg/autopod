import { execFile, spawn } from 'node:child_process';
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  cancelStreamExecScript,
  processGroupProbeScript,
  streamExecScript,
  terminatePidFileScript,
} from './azure-sandbox-api-client.js';

const exec = promisify(execFile);

it.each([
  'gone',
  'unreadable',
  'member',
  'zombie',
] as const)('process-group proof distinguishes vanished entries from unknown/live members: %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'validation-proc-fixture-'));
  const directory = join(root, '222');
  await mkdir(directory);
  const statFile = join(directory, 'stat');
  await writeFile(
    statFile,
    `222 (fixture process) ${mode === 'zombie' ? 'Z' : 'S'} 1 111 1 0${' 0'.repeat(15)}\n`,
  );
  try {
    const probe = processGroupProbeScript().replaceAll('/proc/', `${root}/`);
    const readOverride =
      mode === 'gone'
        ? `read_proc_stat() { rm -f '${statFile}'; rmdir '${directory}'; return 1; }`
        : mode === 'unreadable'
          ? 'read_proc_stat() { return 1; }'
          : '';
    const result = await exec('sh', [
      '-c',
      `pid=111; ${probe}; ${readOverride || ':'}; if group_alive; then echo held; else echo absent; fi`,
    ]);
    expect(result.stdout.trim()).toBe(
      mode === 'member' || mode === 'unreadable' ? 'held' : 'absent',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  'owned-newline',
  'foreign-newline',
  'truncated',
] as const)('reads complete proc records without per-PID external commands: %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'validation-proc-builtin-'));
  await mkdir(join(root, '222'));
  const body =
    mode === 'truncated'
      ? '222 (partial) S 1 999\n'
      : `222 (fixture\nprocess) S 1 ${mode === 'owned-newline' ? 111 : 999} 1 0${' 0'.repeat(15)}\n`;
  await writeFile(join(root, '222/stat'), body);
  try {
    const probe = processGroupProbeScript().replaceAll('/proc/', `${root}/`);
    const result = await exec(
      '/bin/sh',
      ['-c', `pid=111; ${probe}; if group_alive; then echo held; else echo absent; fi`],
      { env: { ...process.env, PATH: '/no-external-probe-commands' } },
    );
    expect(result.stdout.trim()).toBe(mode === 'foreign-newline' ? 'absent' : 'held');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  'pid',
  'state',
  'group',
  'start',
] as const)('retains unknown ownership for a full-length proc record with malformed %s', async (field) => {
  const root = await mkdtemp(join(tmpdir(), 'validation-proc-malformed-'));
  await mkdir(join(root, '222'));
  const fields = ['S', '1', '999', ...Array<string>(17).fill('0')];
  if (field === 'state') fields[0] = 'invalid';
  if (field === 'group') fields[2] = 'unknown';
  if (field === 'start') fields[19] = 'unknown';
  await writeFile(
    join(root, '222/stat'),
    `${field === 'pid' ? 'unknown' : '222'} (fixture) ${fields.join(' ')}\n`,
  );
  try {
    const probe = processGroupProbeScript().replaceAll('/proc/', `${root}/`);
    const result = await exec('/bin/sh', [
      '-c',
      `pid=111; ${probe}; if group_alive; then echo held; else echo absent; fi`,
    ]);
    expect(result.stdout.trim()).toBe('held');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
          'umask 077',
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

// Runs only in a disposable root-capable Linux fixture; never elevates the test runner.
it
  .skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)
  .each(['root', 'worker'] as const)(
  '%s stream keeps its group and is cancelled with receipt-matched authority',
  async (mode, context) => {
    let workerUid: number;
    let workerGid: number;
    try {
      workerUid = Number((await exec('id', ['-u', 'autopod'])).stdout.trim());
      workerGid = Number((await exec('id', ['-g', 'autopod'])).stdout.trim());
    } catch {
      context.skip();
      return;
    }
    if (workerUid === 0) {
      context.skip();
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'validation-cross-uid-'));
    await chmod(directory, 0o755);
    const work = join(directory, 'work');
    await mkdir(work, { mode: 0o777 });
    await chmod(work, 0o1777);
    const script = join(mode === 'root' ? directory : work, 'stream.sh');
    const receipt = `${script}.pid`;
    const ready = join(work, 'child.pid');
    await writeFile(
      script,
      streamExecScript(
        ['sh', '-c', `trap '' TERM; echo $$ > '${ready}'; while :; do sleep 1; done`],
        work,
      ),
      { mode: 0o755 },
    );
    const child = spawn(script, [], {
      detached: true,
      stdio: 'ignore',
      ...(mode === 'worker' ? { uid: workerUid, gid: workerGid } : {}),
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    let leader: number | undefined;
    try {
      let workerPid = '';
      for (let i = 0; i < 200; i++) {
        try {
          workerPid = (await readFile(ready, 'utf8')).trim();
        } catch {
          /* startup */
        }
        if (workerPid) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(workerPid).toMatch(/^[0-9]+$/);
      leader = Number((await readFile(receipt, 'utf8')).split(' ')[0]);
      const forged = join(directory, 'forged.pid');
      await writeFile(forged, await readFile(receipt), { mode: 0o600 });
      await chown(forged, 65534, 65534);
      await expect(exec('sh', ['-c', terminatePidFileScript(forged)])).rejects.toThrow(
        /Untrusted sandbox exec receipt/,
      );
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      const ownership = await stat(receipt);
      expect(ownership.uid).toBe(mode === 'root' ? 0 : workerUid);
      expect(ownership.mode & 0o777).toBe(0o600);
      await expect(exec('cat', [receipt], { uid: 65534, gid: 65534 })).rejects.toThrow();
      const worker = await readFile(`/proc/${workerPid}/status`, 'utf8');
      expect(worker).not.toMatch(/Uid:\s+0\s/);
      const proc = await readFile(`/proc/${workerPid}/stat`, 'utf8');
      expect(Number(proc.slice(proc.lastIndexOf(') ') + 2).split(' ')[2])).toBe(leader);
      await exec('sh', ['-c', cancelStreamExecScript(receipt)], { timeout: 6000 });
      await exited;
      await expect(readFile(receipt)).rejects.toThrow();
      // Confirmation probes all live group members, including the su child and sleep.
      const probe = await exec('sh', [
        '-c',
        `pid=${leader}; ${processGroupProbeScript()}; if group_alive; then exit 1; fi`,
      ]);
      expect(probe.stderr).toBe('');
    } finally {
      if (leader) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

it.skipIf(process.platform !== 'linux').each(['existing', 'symlink'] as const)(
  'does not overwrite or follow a preexisting %s PID receipt',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'validation-exclusive-receipt-'));
    const script = join(directory, 'stream.sh');
    const receipt = `${script}.pid`;
    const target = join(directory, 'protected');
    await writeFile(target, 'retain original bytes');
    if (mode === 'symlink') await symlink(target, receipt);
    else await writeFile(receipt, 'retain receipt');
    await writeFile(script, streamExecScript(['echo', 'must not dispatch']), { mode: 0o755 });
    try {
      await expect(exec(script)).rejects.toMatchObject({ code: 1, stdout: '' });
      expect(await readFile(target, 'utf8')).toBe('retain original bytes');
      expect(await readFile(receipt, 'utf8')).toBe(
        mode === 'symlink' ? 'retain original bytes' : 'retain receipt',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
