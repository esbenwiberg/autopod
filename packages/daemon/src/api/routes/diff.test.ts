import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../../interfaces/container-manager.js';
import type { WorktreeManager } from '../../interfaces/worktree-manager.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';
import type { ProfileStore } from '../../profiles/index.js';
import { errorHandler } from '../error-handler.js';
import { diffRoutes } from './diff.js';

function makePodManager(podOverrides: Record<string, unknown> = {}): PodManager {
  return {
    getSession: vi.fn().mockReturnValue({
      id: 'pod-1',
      profileName: 'p',
      executionTarget: 'docker',
      containerId: 'c1',
      worktreePath: '/host/worktree',
      startCommitSha: 'start-sha',
      baseBranch: 'main',
      ...podOverrides,
    }),
  } as unknown as PodManager;
}

function makeContainerFactory(cm: ContainerManager): ContainerManagerFactory {
  return {
    get: vi.fn().mockReturnValue(cm),
  } as unknown as ContainerManagerFactory;
}

function makeProfileStore(): ProfileStore {
  return { get: vi.fn().mockReturnValue({ defaultBranch: 'main' }) } as unknown as ProfileStore;
}

describe('diff route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.setErrorHandler(errorHandler);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns parsed files + stats from the container diff', async () => {
    const sample =
      'diff --git a/src/foo.ts b/src/foo.ts\n' +
      '--- a/src/foo.ts\n' +
      '+++ b/src/foo.ts\n' +
      '@@ -1,2 +1,3 @@\n' +
      ' line1\n' +
      '+added\n' +
      '-removed\n';
    const cm = {
      execInContainer: vi.fn().mockResolvedValue({ stdout: sample, stderr: '', exitCode: 0 }),
    } as unknown as ContainerManager;

    diffRoutes(app, makePodManager(), makeContainerFactory(cm), makeProfileStore());
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/pods/pod-1/diff' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: unknown[]; stats: { changed: number } };
    expect(body.files).toHaveLength(1);
    expect(body.stats).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  // Regression: previously tryWorktreeDiff (and tryContainerDiff) ran
  // `git diff base HEAD` followed by `git diff HEAD` and concatenated the two,
  // producing duplicate `diff --git` blocks for any file that was committed
  // AND modified in the worktree. The unified single-ref `git diff <base>`
  // path yields one block per file.
  it('does not double-count a file that is committed-then-modified', async () => {
    const wtDiff =
      'diff --git a/src/foo.ts b/src/foo.ts\n' +
      '--- a/src/foo.ts\n' +
      '+++ b/src/foo.ts\n' +
      '@@ -1,2 +1,3 @@\n' +
      ' line1\n' +
      '+committed-and-modified\n';
    const wm = {
      getDiff: vi.fn().mockResolvedValue(wtDiff),
    } as unknown as WorktreeManager;

    diffRoutes(
      app,
      makePodManager({ containerId: null }),
      makeContainerFactory({} as ContainerManager),
      makeProfileStore(),
      wm,
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/pods/pod-1/diff' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: { path: string }[] };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.path).toBe('src/foo.ts');
  });

  it('returns empty files + zero stats when there is nothing to diff', async () => {
    diffRoutes(
      app,
      makePodManager({ containerId: null, worktreePath: null }),
      makeContainerFactory({} as ContainerManager),
      makeProfileStore(),
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/pods/pod-1/diff' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ files: [], stats: { added: 0, removed: 0, changed: 0 } });
  });
});
