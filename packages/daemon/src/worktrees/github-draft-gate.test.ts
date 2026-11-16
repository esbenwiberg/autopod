import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrManager } from '../interfaces/pr-manager.js';
import { createMergeJournal } from '../pods/merge-journal.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { createSourcePublicationLedger } from '../pods/source-publication-ledger.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { mergePublishedSource } from './durable-merge.js';
import { GhPrManager, GitHubApiPrManager } from './pr-manager.js';

const cli = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:util', async () => ({
  ...(await vi.importActual<typeof import('node:util')>('node:util')),
  promisify: () => cli.exec,
}));

const url = 'https://github.com/org/repo/pull/42';
const sha = 'a'.repeat(40);
const target = { repository: 'https://github.com/org/repo', branch: 'feature', baseBranch: 'main' };
beforeEach(() => {
  cli.exec.mockReset();
});
afterEach(() => vi.restoreAllMocks());

function fixture(kind: 'cli' | 'api', draft = true) {
  const db = createTestDb();
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Deliver retained source',
    model: 'model',
    runtime: 'codex',
    branch: 'feature',
    userId: 'operator',
    status: 'validated',
    executionTarget: 'local',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('worker', { worktreePath: '/retained/source', containerId: 'retained-container' });
  const publicationPod = repo.getOrThrow('worker');
  const proof = {
    branch: 'feature',
    repository: target.repository,
    commitSha: sha,
    treeSha: 'b'.repeat(40),
    remoteRef: 'refs/heads/feature',
    observedRemoteCommitSha: sha,
    worktreeClean: true as const,
    observedAt: new Date().toISOString(),
  };
  const publications = createSourcePublicationLedger(db);
  const publicationId = publications.admit(publicationPod, proof);
  publications.confirm(publicationPod, publicationId, proof);
  repo.update('worker', { status: 'merging', prUrl: url });
  const pod = repo.getOrThrow('worker');
  const journal = createMergeJournal(db);
  const state = { draft, merged: false, mutations: 0, refusal: null as Error | null };
  const observed = () => ({
    number: 42,
    url,
    state: state.merged ? 'MERGED' : 'OPEN',
    headRefOid: sha,
    headRefName: 'feature',
    baseRefName: 'main',
    isCrossRepository: false,
    isDraft: state.draft,
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [],
    reviewDecision: 'APPROVED',
    mergedAt: state.merged ? 'now' : null,
  });
  const mutate = () => {
    state.mutations++;
    if (state.refusal) throw state.refusal;
    state.merged = true;
  };
  let provider: PrManager;
  if (kind === 'cli') {
    cli.exec.mockImplementation(async (_binary, args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'merge') {
        expect(args).toEqual(expect.arrayContaining(['--match-head-commit', sha]));
        mutate();
        return { stdout: '', stderr: '' };
      }
      expect(args.slice(0, 2)).toEqual(['pr', 'view']);
      return { stdout: JSON.stringify(observed()), stderr: '' };
    });
    provider = new GhPrManager({
      logger,
      githubAuth: {
        resolveCredential: vi.fn(async () => ({ token: 'fixture', username: 'x-access-token' })),
        getStatus: vi.fn(),
      },
    });
  } else {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input);
      if (init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toMatchObject({ sha });
        mutate();
        return Response.json({ merged: true });
      }
      if (path.endsWith('/check-runs')) return Response.json({ check_runs: [] });
      if (path.endsWith('/reviews')) return Response.json([]);
      expect(path).toBe('https://api.github.com/repos/org/repo/pulls/42');
      return Response.json({
        number: 42,
        state: state.merged ? 'closed' : 'open',
        merged: state.merged,
        draft: state.draft,
        mergeable: true,
        mergeable_state: 'clean',
        head: { sha, ref: 'feature', repo: { full_name: 'org/repo' } },
        base: { ref: 'main', repo: { full_name: 'org/repo' } },
      });
    });
    provider = new GitHubApiPrManager({ logger, pat: 'fixture' });
  }
  const onPrepared = vi.fn();
  const config = { prUrl: url, expectedHeadSha: sha, expectedTarget: target, onPrepared };
  const deliver = () =>
    mergePublishedSource(
      journal,
      pod,
      publicationPod,
      { ...proof, publicationId },
      provider,
      config,
    );
  return { db, repo, pod, journal, provider, state, config, onPrepared, deliver };
}

describe.each(['cli', 'api'] as const)('GitHub %s draft admission', (kind) => {
  it('exposes CLEAN plus draft as a concrete blocker with zero admissions or mutations', async () => {
    const f = fixture(kind);
    try {
      expect(await f.provider.getPrStatus({ prUrl: url })).toMatchObject({
        mergeBlocked: true,
        blockReason: expect.stringMatching(/draft/i),
        headSha: sha,
      });
      await expect(f.deliver()).rejects.toThrow(/draft/i);
      expect(f.onPrepared).not.toHaveBeenCalled();
      expect(f.journal.find(f.pod)).toBeNull();
      expect(f.state.mutations).toBe(0);
    } finally {
      f.db.close();
    }
  });

  it('catches a ready-status to draft-merge race before journal admission', async () => {
    const f = fixture(kind, false);
    try {
      expect((await f.provider.getPrStatus({ prUrl: url })).mergeBlocked).not.toBe(true);
      f.state.draft = true;
      await expect(f.deliver()).rejects.toThrow(/draft/i);
      expect(f.onPrepared).not.toHaveBeenCalled();
      expect(f.journal.find(f.pod)).toBeNull();
      expect(f.state.mutations).toBe(0);
    } finally {
      f.db.close();
    }
  });

  it('delivers a ready exact-source merge with one immutable admission', async () => {
    const f = fixture(kind, false);
    try {
      expect(await f.deliver()).toMatchObject({ merged: true, source: { headSha: sha, target } });
      expect(f.onPrepared).toHaveBeenCalledOnce();
      expect(f.state.mutations).toBe(1);
      expect(f.journal.find(f.pod)?.state).toBe('merged');
    } finally {
      f.db.close();
    }
  });

  it.each([
    'lost-response',
    'untyped-403',
    'draft-refusal',
  ] as const)('retains an admitted %s despite open draft status, without replay', async (failure) => {
    const f = fixture(kind, false);
    try {
      f.state.refusal =
        failure === 'draft-refusal'
          ? Object.assign(new Error('provider refused'), {
              stderr: 'GraphQL: Pull Request is still a draft (mergePullRequest)',
            })
          : new Error(failure === 'untyped-403' ? 'HTTP 403' : 'response lost');
      const first = f.deliver();
      await expect(first).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
      if (failure === 'draft-refusal' && kind === 'cli')
        await expect(first).rejects.toThrow(/still a draft/);
      const admitted = f.journal.find(f.pod);
      expect(admitted?.state).toBe('admitted');
      f.state.draft = true;
      await expect(f.deliver()).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
      expect(f.journal.find(f.pod)).toEqual(admitted);
      expect(f.state.mutations).toBe(1);
      expect(f.onPrepared).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });
});
