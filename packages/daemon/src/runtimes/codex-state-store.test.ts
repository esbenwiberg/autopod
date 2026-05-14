import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupCodexState,
  codexStateDirForPod,
  ensureCodexStateDir,
} from './codex-state-store.js';

describe('codex-state-store', () => {
  let tmpRoot: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'autopod-codex-state-test-'));
    originalEnv = process.env.AUTOPOD_CODEX_STATE_DIR;
    process.env.AUTOPOD_CODEX_STATE_DIR = tmpRoot;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: must actually unset
      delete process.env.AUTOPOD_CODEX_STATE_DIR;
    } else {
      process.env.AUTOPOD_CODEX_STATE_DIR = originalEnv;
    }
  });

  it('places each pod in its own subdir under the configured root', () => {
    expect(codexStateDirForPod('pod-a')).toBe(path.join(tmpRoot, 'pod-a'));
    expect(codexStateDirForPod('pod-b')).toBe(path.join(tmpRoot, 'pod-b'));
  });

  it('creates the dir on ensureCodexStateDir and is idempotent', async () => {
    const first = await ensureCodexStateDir('pod-1');
    const second = await ensureCodexStateDir('pod-1');
    expect(first).toBe(second);
    await expect(access(first)).resolves.toBeUndefined();
  });

  it('cleanupCodexState removes the dir even when it contains session files', async () => {
    const dir = await ensureCodexStateDir('pod-2');
    await writeFile(path.join(dir, 'fake-rollout.jsonl'), '{"type":"session"}\n');
    await cleanupCodexState('pod-2');
    await expect(access(dir)).rejects.toThrow();
  });

  it('cleanupCodexState is a no-op when the dir was never created', async () => {
    // Should not throw even if the directory does not exist.
    await expect(cleanupCodexState('pod-never-existed')).resolves.toBeUndefined();
  });
});
