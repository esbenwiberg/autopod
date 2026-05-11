import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeStateDirForPod,
  cleanupClaudeState,
  ensureClaudeStateDir,
} from './claude-state-store.js';

describe('claude-state-store', () => {
  let tmpRoot: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'autopod-claude-state-test-'));
    originalEnv = process.env.AUTOPOD_CLAUDE_STATE_DIR;
    process.env.AUTOPOD_CLAUDE_STATE_DIR = tmpRoot;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: must actually unset
      delete process.env.AUTOPOD_CLAUDE_STATE_DIR;
    } else {
      process.env.AUTOPOD_CLAUDE_STATE_DIR = originalEnv;
    }
  });

  it('places each pod in its own subdir under the configured root', () => {
    expect(claudeStateDirForPod('pod-a')).toBe(path.join(tmpRoot, 'pod-a'));
    expect(claudeStateDirForPod('pod-b')).toBe(path.join(tmpRoot, 'pod-b'));
  });

  it('creates the dir on ensureClaudeStateDir and is idempotent', async () => {
    const first = await ensureClaudeStateDir('pod-1');
    const second = await ensureClaudeStateDir('pod-1');
    expect(first).toBe(second);
    await expect(access(first)).resolves.toBeUndefined();
  });

  it('cleanupClaudeState removes the dir even when it contains conversation files', async () => {
    const dir = await ensureClaudeStateDir('pod-2');
    await writeFile(path.join(dir, 'fake-session.jsonl'), '{"type":"user"}\n');
    await cleanupClaudeState('pod-2');
    await expect(access(dir)).rejects.toThrow();
  });

  it('cleanupClaudeState is a no-op when the dir was never created', async () => {
    // Should not throw even if the directory does not exist.
    await expect(cleanupClaudeState('pod-never-existed')).resolves.toBeUndefined();
  });
});
