import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { GhPrManager } from './pr-manager.js';

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util');
  return {
    ...actual,
    promisify: vi.fn(() => {
      return async () => {
        return { stdout: 'https://github.com/org/repo/pull/42\n', stderr: '' };
      };
    }),
  };
});

const logger = pino({ level: 'silent' });

describe('GhPrManager', () => {
  it('can be instantiated', () => {
    const manager = new GhPrManager({ logger });
    expect(manager).toBeDefined();
  });

  it('createPr returns trimmed PR URL', async () => {
    const manager = new GhPrManager({ logger });

    const prUrl = await manager.createPr({
      worktreePath: '/tmp/worktree',
      branch: 'autopod/abc123',
      baseBranch: 'main',
      sessionId: 'abc123',
      task: 'Add dark mode',
      profileName: 'my-app',
      validationResult: null,
      filesChanged: 3,
      linesAdded: 50,
      linesRemoved: 10,
      previewUrl: null,
    });

    expect(prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('mergePr resolves without error', async () => {
    const manager = new GhPrManager({ logger });

    await expect(
      manager.mergePr({
        worktreePath: '/tmp/worktree',
        prUrl: 'https://github.com/org/repo/pull/42',
      }),
    ).resolves.toBeUndefined();
  });
});
