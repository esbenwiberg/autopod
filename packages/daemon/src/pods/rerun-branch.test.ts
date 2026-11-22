import type { EffectiveLaunchConfig, Pod } from '@autopod/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../api/error-handler.js';
import type { ConfigurationRouteDependencies } from '../api/routes/configuration.js';
import { podRoutes } from '../api/routes/pods.js';
import type { PodManager } from './pod-manager.js';
import type { PodRepository } from './pod-repository.js';
import { selectRerunBranch } from './rerun-branch.js';

describe('selectRerunBranch (#647)', () => {
  const base = { sourcePodId: 'pod-b', baseBranch: 'main' };
  it('keeps the requested branch when no other unfinished pod holds it', () => {
    expect(
      selectRerunBranch({
        ...base,
        requested: 'feature/requested',
        // The failed rerun source itself still records the branch; it does not hold it.
        unfinished: [
          { id: 'pod-b', branch: 'feature/requested' },
          { id: 'pod-a', branch: 'autopod/pod-a' },
        ],
      }),
    ).toEqual({ branch: 'feature/requested', heldBy: [] });
  });
  it('falls back deterministically when another unfinished pod holds the branch', () => {
    expect(
      selectRerunBranch({
        ...base,
        requested: 'feature/requested',
        unfinished: [
          { id: 'pod-x', branch: 'feature/requested' },
          { id: 'pod-y', branch: 'feature/requested' },
        ],
      }),
    ).toEqual({ heldBy: ['pod-x', 'pod-y'] });
  });
  it('never reuses the base branch and has nothing to keep without a request', () => {
    expect(selectRerunBranch({ ...base, requested: 'main', unfinished: [] })).toEqual({
      heldBy: [],
    });
    expect(selectRerunBranch({ ...base, requested: undefined, unfinished: [] })).toEqual({
      heldBy: [],
    });
  });
});

describe('GET /pods/:podId/rerun-template branch (#647)', () => {
  async function template(unfinished: Array<Pick<Pod, 'id' | 'branch'>>) {
    const source = {
      repository: {
        id: 'repo',
        config: { remote: 'https://github.com/org/repo' },
        setup: { id: 'web', defaultBranch: 'main' },
      },
      profileId: 'profile',
      task: 'Repeat the spec',
      digest: 'd'.repeat(64),
      work: { branch: 'feature/requested', contract: undefined },
    } as unknown as EffectiveLaunchConfig;
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    app.addHook('preHandler', async (request) => {
      request.user = { oid: 'operator', name: 'Operator' };
    });
    podRoutes(
      app,
      {} as PodManager,
      undefined,
      undefined,
      { listNonTerminal: () => unfinished } as unknown as PodRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        resolution: { readLaunch: (id: string) => (id === 'pod-b' ? source : null) },
      } as unknown as ConfigurationRouteDependencies,
    );
    try {
      const response = await app.inject({ method: 'GET', url: '/pods/pod-b/rerun-template' });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    } finally {
      await app.close();
    }
  }
  it('keeps the requested output branch when free', async () => {
    const body = await template([{ id: 'pod-b', branch: 'feature/requested' }]);
    expect(body).toMatchObject({
      repositoryId: 'repo',
      source: { podId: 'pod-b', configuration: 'original' },
      work: { branch: 'feature/requested' },
    });
  });
  it('omits it when another unfinished pod holds it', async () => {
    const body = await template([{ id: 'pod-x', branch: 'feature/requested' }]);
    expect(body.work.branch).toBeUndefined();
  });
});
