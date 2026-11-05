import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentFileChangeEvent } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecOptions, ExecResult } from '../interfaces/container-manager.js';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import {
  createWorkspaceFileObserver,
  FILE_OBSERVATION_INTERVAL_MS,
} from './workspace-file-observer.js';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'file-observation-'));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    });
  git('init', '-q');
  git('config', 'user.name', 'File Observer Test');
  git('config', 'user.email', 'observer@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(cwd, 'source.ts'), 'initial\n');
  writeFileSync(join(cwd, '.gitignore'), '*.ignored\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const cm = createMockContainerManager();
  vi.mocked(cm.execInContainer).mockImplementation(async (_id, command, options) => {
    options?.assertCurrent?.();
    try {
      const stdout = execFileSync(process.execPath, command.slice(1), {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { stdout, stderr: '', exitCode: 0 };
    } catch {
      return { stdout: '', stderr: 'snapshot rejected', exitCode: 1 };
    }
  });
  const events: AgentFileChangeEvent[] = [];
  const unavailable = vi.fn();
  let current = true;
  const observer = createWorkspaceFileObserver({
    containerManager: cm,
    containerId: 'worker',
    isCurrent: () => current,
    emit: (event) => events.push(event),
    unavailable,
  });
  return {
    cwd,
    git,
    cm,
    observer,
    events,
    unavailable,
    supersede: () => {
      current = false;
    },
  };
}
const manifest = (entries: [string, string][]) => ({
  stdout: JSON.stringify({ version: 1, complete: true, files: entries }),
  stderr: '',
  exitCode: 0,
});
const fingerprint = (digit: string) => `100644:${digit.repeat(40)}`;

async function tick() {
  await vi.advanceTimersByTimeAsync(FILE_OBSERVATION_INTERVAL_MS);
}

describe('workspace file observation', () => {
  it('detects shell/Python edits, staged/committed changes and repeat edits without status-list inference', async () => {
    vi.useFakeTimers();
    const f = repository();
    await f.observer.start();
    expect(f.events).toEqual([]);
    execFileSync('/bin/sh', ['-c', 'printf "shell edit\\n" > source.ts'], { cwd: f.cwd });
    await tick();
    expect(f.events).toMatchObject([{ path: 'source.ts', action: 'modify', source: 'workspace' }]);
    // The path is still dirty, but its bytes changed again.
    execFileSync(
      'python3',
      ['-c', 'from pathlib import Path; Path("source.ts").write_text("python edit\\n")'],
      { cwd: f.cwd },
    );
    f.git('add', 'source.ts');
    await tick();
    expect(f.events).toHaveLength(2);
    f.git('commit', '-qm', 'agent commit');
    await tick();
    expect(f.events).toHaveLength(2); // Committing identical bytes is not another edit.
    writeFileSync(join(f.cwd, 'source.ts'), 'committed between scans\n');
    f.git('add', '.');
    f.git('commit', '-qm', 'second agent commit');
    expect(f.git('status', '--porcelain')).toBe('');
    await f.observer.finish();
    expect(f.events).toHaveLength(3);
    expect(f.unavailable).not.toHaveBeenCalled();
  });

  it('does not report another edit when committing CRLF bytes that Git normalizes', async () => {
    vi.useFakeTimers();
    const f = repository();
    f.git('config', 'core.autocrlf', 'true');
    writeFileSync(join(f.cwd, 'source.ts'), 'initial\r\n');
    await f.observer.start();
    writeFileSync(join(f.cwd, 'source.ts'), 'changed\r\n');
    await tick();
    expect(f.events).toHaveLength(1);
    f.git('add', 'source.ts');
    f.git('commit', '-qm', 'canonical CRLF commit');
    await f.observer.finish();
    expect(f.events).toHaveLength(1);
  });

  it('disables configured clean filters and fsmonitor rather than executing repository commands', async () => {
    const f = repository();
    writeFileSync(join(f.cwd, '.gitattributes'), 'source.ts filter=unsafe\n');
    f.git('add', '.gitattributes');
    f.git('commit', '-qm', 'filter attribute');
    f.git('config', 'filter.unsafe.clean', 'touch filter-ran; cat');
    f.git('config', 'filter.unsafe.required', 'true');
    f.git('config', 'core.fsmonitor', 'touch monitor-ran');
    writeFileSync(join(f.cwd, 'source.ts'), 'changed');
    await f.observer.start();
    await f.observer.finish();
    expect(f.unavailable).not.toHaveBeenCalled();
    expect(existsSync(join(f.cwd, 'filter-ran'))).toBe(false);
    expect(existsSync(join(f.cwd, 'monitor-ran'))).toBe(false);
  });

  it('handles unusual filenames, untracked creates, deletes and rename-as-delete/create; ignores ignored files', async () => {
    const f = repository();
    await f.observer.start();
    const unusual = '-quote"\tline\nfile.ts';
    writeFileSync(join(f.cwd, unusual), 'new file');
    writeFileSync(join(f.cwd, 'build.ignored'), 'generated');
    f.git('mv', 'source.ts', 'renamed.ts');
    const indexBefore = readFileSync(join(f.cwd, '.git/index'));
    await f.observer.finish();
    expect(f.events.map(({ path, action }) => ({ path, action }))).toEqual([
      { path: 'renamed.ts', action: 'create' },
      { path: unusual, action: 'create' },
      { path: 'source.ts', action: 'delete' },
    ]);
    expect(readFileSync(join(f.cwd, '.git/index'))).toEqual(indexBefore);
    expect(f.events.every((event) => !('diff' in event))).toBe(true);
  });

  it('baselines pre-existing dirty and untracked files, and emits no event for failed/no-op attempts', async () => {
    const f = repository();
    writeFileSync(join(f.cwd, 'source.ts'), 'existing changes');
    writeFileSync(join(f.cwd, 'existing.txt'), 'existing untracked');
    await f.observer.start();
    writeFileSync(join(f.cwd, 'source.ts'), 'existing changes'); // No-op rewrite, new timestamps.
    await f.observer.finish();
    expect(f.events).toEqual([]);
    expect(f.unavailable).not.toHaveBeenCalled();
  });

  it('hashes a symlink itself without reading its external target', async () => {
    const f = repository();
    const target = join(tmpdir(), `observer-external-${Date.now()}`);
    // Target deliberately does not exist: a successful snapshot proves it was not followed.
    symlinkSync(target, join(f.cwd, 'link'));
    await f.observer.start();
    unlinkSync(join(f.cwd, 'link'));
    symlinkSync(`${target}-other`, join(f.cwd, 'link'));
    await f.observer.finish();
    expect(f.events).toMatchObject([{ path: 'link', action: 'modify' }]);
    expect(f.unavailable).not.toHaveBeenCalled();
  });

  it('rejects oversized dirty files without publishing partial changes or dropping its baseline', async () => {
    vi.useFakeTimers();
    const f = repository();
    await f.observer.start();
    writeFileSync(join(f.cwd, 'too-large.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
    writeFileSync(join(f.cwd, 'source.ts'), 'small real edit');
    await tick();
    expect(f.events).toEqual([]);
    expect(f.unavailable).toHaveBeenCalledOnce();
    unlinkSync(join(f.cwd, 'too-large.bin'));
    await f.observer.finish();
    expect(f.events).toMatchObject([{ path: 'source.ts', action: 'modify' }]);
  });

  it('refuses to read tracked files through a replaced symlink parent', async () => {
    vi.useFakeTimers();
    const f = repository();
    f.git('mv', 'source.ts', 'original.ts');
    // Restore a tracked directory in HEAD, then replace it with an external link.
    mkdirSync(join(f.cwd, 'src'));
    writeFileSync(join(f.cwd, 'src/app.ts'), 'tracked');
    f.git('add', '.');
    f.git('commit', '-qm', 'directory fixture');
    await f.observer.start();
    rmSync(join(f.cwd, 'src'), { recursive: true });
    symlinkSync(tmpdir(), join(f.cwd, 'src'));
    await f.observer.finish();
    expect(f.events).toEqual([]);
    expect(f.unavailable).toHaveBeenCalledOnce();
  });

  it('retains the last good baseline across incomplete/nonzero/malformed observations', async () => {
    vi.useFakeTimers();
    const f = repository();
    await f.observer.start();
    writeFileSync(join(f.cwd, 'source.ts'), 'real edit');
    vi.mocked(f.cm.execInContainer)
      .mockResolvedValueOnce({ stdout: '{"version":1,"files":[]}', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: '{', stderr: '', exitCode: 0 });
    await tick();
    await tick();
    await tick();
    expect(f.events).toEqual([]);
    expect(f.unavailable).toHaveBeenCalledTimes(1);
    await f.observer.finish();
    expect(f.events).toMatchObject([{ path: 'source.ts', action: 'modify' }]);
  });

  it('does not fail the run when both observation and its diagnostics sink fail', async () => {
    const f = repository();
    vi.mocked(f.cm.execInContainer).mockRejectedValueOnce(new Error('transport failed'));
    f.unavailable.mockImplementationOnce(() => {
      throw new Error('log store failed');
    });
    await expect(f.observer.start()).resolves.toBeUndefined();
    await expect(f.observer.finish()).resolves.toBeUndefined();
    expect(f.observer.active).toBe(false);
  });

  it('keeps native fallback for the whole run when the initial baseline is unavailable', async () => {
    vi.useFakeTimers();
    const f = repository();
    vi.mocked(f.cm.execInContainer).mockRejectedValueOnce(new Error('transport failure'));
    await f.observer.start();
    expect(f.observer.active).toBe(false);
    await tick();
    await f.observer.finish();
    expect(f.cm.execInContainer).toHaveBeenCalledTimes(1);
    expect(f.unavailable).toHaveBeenCalledOnce();
  });

  it.each([
    'supersede',
    'stop',
  ] as const)('does not publish an in-flight scan after %s', async (action) => {
    vi.useFakeTimers();
    const f = repository();
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce(manifest([]));
    await f.observer.start();
    let resolve!: (value: ExecResult) => void;
    let options: ExecOptions | undefined;
    vi.mocked(f.cm.execInContainer).mockImplementationOnce(async (_id, _cmd, opts) => {
      options = opts;
      return new Promise((done) => {
        resolve = done;
      });
    });
    await tick();
    const stopped = action === 'stop' ? f.observer.stop() : undefined;
    if (action === 'supersede') f.supersede();
    expect(() => options?.assertCurrent?.()).toThrow();
    resolve(manifest([['late.ts', fingerprint('a')]]));
    await stopped;
    await f.observer.stop();
    expect(f.events).toEqual([]);
  });

  it('serializes scans and takes a fresh terminal snapshot after an older scan drains', async () => {
    vi.useFakeTimers();
    const f = repository();
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce(manifest([]));
    await f.observer.start();
    let resolve!: (value: ExecResult) => void;
    vi.mocked(f.cm.execInContainer).mockImplementationOnce(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await tick();
    await tick();
    expect(f.cm.execInContainer).toHaveBeenCalledTimes(2);
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce(
      manifest([['last.ts', fingerprint('b')]]),
    );
    const finished = f.observer.finish();
    resolve(manifest([]));
    await finished;
    expect(f.cm.execInContainer).toHaveBeenCalledTimes(3);
    expect(f.events).toMatchObject([{ path: 'last.ts', action: 'create' }]);
    await tick();
    expect(f.cm.execInContainer).toHaveBeenCalledTimes(3);
  });

  it.each(
    [
      [['../escape', fingerprint('a')]],
      [['/outside', fingerprint('a')]],
      [['.git/config', fingerprint('a')]],
      [
        ['duplicate', fingerprint('a')],
        ['duplicate', fingerprint('b')],
      ],
      [['bad', 'invalid']],
    ].map((entries) => ({ entries })),
  )('rejects unsafe/incomplete manifest entries %# without inferring deletions', async ({
    entries,
  }) => {
    const f = repository();
    await f.observer.start();
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce(manifest(entries as [string, string][]));
    await f.observer.finish();
    expect(f.events).toEqual([]);
    expect(f.unavailable).toHaveBeenCalledOnce();
  });
});
