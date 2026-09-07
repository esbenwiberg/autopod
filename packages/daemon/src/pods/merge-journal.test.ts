import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { MergePrResult } from '../interfaces/pr-manager.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createMergeJournal } from './merge-journal.js';
import { createPodRepository } from './pod-repository.js';
import { createSourcePublicationLedger } from './source-publication-ledger.js';

function fixture(
  db = createTestDb(),
  confirmed = true,
  repository = 'https://github.com/org/repo',
) {
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: 'merge-source',
    profileName: 'test-profile',
    task: 'Merge retained source',
    model: 'model',
    runtime: 'codex',
    branch: 'feature',
    userId: 'user',
    status: 'validated',
    executionTarget: 'local',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('merge-source', { worktreePath: '/tmp/source', containerId: 'source-container' });
  const publicationPod = repo.getOrThrow('merge-source');
  const publications = createSourcePublicationLedger(db);
  const proof = {
    branch: 'feature',
    repository,
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    remoteRef: 'refs/heads/feature',
    observedRemoteCommitSha: 'a'.repeat(40),
    worktreeClean: true as const,
    observedAt: '2026-09-08T00:00:00Z',
  };
  const publicationId = publications.admit(publicationPod, proof);
  if (confirmed) publications.confirm(publicationPod, publicationId, proof);
  repo.update('merge-source', {
    status: 'merging',
    prUrl: `${repository}/${repository.includes('github.com') ? 'pull' : 'pullrequest'}/42`,
  });
  const pod = repo.getOrThrow('merge-source');
  const config = {
    prUrl: pod.prUrl ?? '',
    expectedHeadSha: proof.commitSha,
    expectedTarget: { repository: proof.repository, branch: proof.branch, baseBranch: 'main' },
  };
  const result: MergePrResult = {
    merged: true,
    autoMergeScheduled: false,
    source: {
      headSha: proof.commitSha,
      target: config.expectedTarget,
      observedAt: '2026-09-08T00:01:00Z',
    },
  };
  return {
    db,
    repo,
    pod,
    publicationPod,
    publicationId,
    proof,
    config,
    result,
    journal: createMergeJournal(db),
  };
}

describe('durable merge journal', () => {
  it('retains ambiguous admission across independent connections and close/reopen, then records one immutable confirmation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopod-merge-journal-'));
    const path = join(dir, 'journal.db');
    let db = new Database(path);
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, new URL('../db/migrations', import.meta.url).pathname, logger);
      const f = fixture(db);
      const attempt = f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      const second = new Database(path);
      try {
        expect(() =>
          createMergeJournal(second).claim(f.pod, f.publicationPod, f.publicationId, f.config),
        ).toThrow('ambiguous');
        expect(createMergeJournal(second).find(f.pod)?.state).toBe('admitted');
      } finally {
        second.close();
      }
      db.close();
      db = new Database(path);
      const restarted = createMergeJournal(db);
      expect(restarted.find(f.pod)?.state).toBe('admitted');
      expect(() => restarted.claim(f.pod, f.publicationPod, f.publicationId, f.config)).toThrow(
        'ambiguous',
      );
      restarted.observe(attempt, f.result, 'provider_lookup');
      restarted.observe(attempt, f.result, 'provider_lookup');
      expect(restarted.find(f.pod)).toMatchObject({ state: 'merged', result: f.result });
      expect(db.prepare('SELECT count(*) AS n FROM merge_intents').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT count(*) AS n FROM merge_observations').get()).toEqual({ n: 1 });
      for (const table of ['merge_intents', 'merge_attempts', 'merge_observations'])
        expect(() =>
          db
            .prepare(
              `UPDATE ${table} SET ${table === 'merge_intents' ? 'request = request' : table === 'merge_attempts' ? 'admitted_at = admitted_at' : 'result = result'}`,
            )
            .run(),
        ).toThrow('immutable');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['generation', 'decision', 'wrong-source', 'unconfirmed', 'outer-transaction'] as const)(
    'refuses unproven or stale admission (%s)',
    (change) => {
      const f = fixture(undefined, change !== 'unconfirmed');
      try {
        if (change === 'generation') f.repo.incrementLifecycleGeneration(f.pod.id);
        if (change === 'decision')
          f.db.prepare("UPDATE pods SET pending_escalation = '{}' WHERE id = ?").run(f.pod.id);
        const claim = () =>
          f.journal.claim(
            f.pod,
            f.publicationPod,
            f.publicationId,
            change === 'wrong-source' ? { ...f.config, expectedHeadSha: 'c'.repeat(40) } : f.config,
          );
        expect(change === 'outer-transaction' ? () => f.db.transaction(claim)() : claim).toThrow();
        expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 0 });
      } finally {
        f.db.close();
      }
    },
  );

  it('requires reconciliation of an already scheduled merge before another admission', () => {
    const f = fixture();
    try {
      const first = f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      f.journal.observe(first, { merged: false, autoMergeScheduled: true }, 'merge_response');
      expect(() => f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config)).toThrow(
        'already scheduled',
      );
      expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  });

  it('does not bypass a scheduled merge by creating a new lifecycle publication', () => {
    const f = fixture();
    try {
      const attempt = f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      f.journal.observe(attempt, { merged: false, autoMergeScheduled: true }, 'merge_response');
      f.repo.incrementLifecycleGeneration(f.pod.id);
      const current = f.repo.getOrThrow(f.pod.id);
      const publications = createSourcePublicationLedger(f.db);
      const newPublication = publications.admit(current, f.proof);
      publications.confirm(current, newPublication, f.proof);
      expect(() => f.journal.claim(current, current, newPublication, f.config)).toThrow(
        'already scheduled',
      );
      expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  });

  it.each([
    'https://dev.azure.com/ORG/Project/_git/Repo/pullrequest/42',
    'https://org.visualstudio.com/Project/_git/Repo/pullrequest/42',
    'https://dev.azure.com/org/%50roject/_git/Repo/pullrequest/42',
  ])('does not admit an ambiguous duplicate through an equivalent ADO address (%s)', (alias) => {
    const f = fixture(undefined, true, 'https://dev.azure.com/org/Project/_git/Repo');
    try {
      f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      f.repo.incrementLifecycleGeneration(f.pod.id);
      f.repo.update(f.pod.id, { prUrl: alias });
      const current = f.repo.getOrThrow(f.pod.id);
      const publications = createSourcePublicationLedger(f.db);
      const publicationId = publications.admit(current, f.proof);
      publications.confirm(current, publicationId, f.proof);
      expect(() =>
        f.journal.claim(current, current, publicationId, {
          ...f.config,
          prUrl: alias,
        }),
      ).toThrow('ambiguous');
      expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  });

  it('separates acknowledged pending attempts from a single confirmed logical merge', () => {
    const f = fixture();
    try {
      const first = f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      f.journal.observe(first, { merged: false, autoMergeScheduled: false }, 'merge_response');
      const second = f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      f.journal.observe(second, f.result, 'merge_response');
      f.journal.observe(first, f.result, 'provider_lookup');
      expect(f.journal.find(f.pod)?.state).toBe('merged');
      expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 2 });
      expect(
        f.db
          .prepare("SELECT count(*) AS n FROM merge_observations WHERE disposition = 'merged'")
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  });

  it('preserves source-bound external confirmation after the worker is deleted without granting a current lifecycle', () => {
    const f = fixture();
    try {
      const attempt = f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      f.repo.delete(f.pod.id);
      f.journal.observe(attempt, f.result, 'merge_response');
      expect(f.db.prepare('SELECT disposition FROM merge_observations').all()).toEqual([
        { disposition: 'merged' },
      ]);
      expect(() => f.journal.find(f.pod)).toThrow();
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it.each(['missing', 'head', 'target'] as const)(
    'does not record an unconfirmed merge result (%s)',
    (change) => {
      const f = fixture();
      try {
        const attempt = f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
        const source = {
          headSha: change === 'head' ? 'c'.repeat(40) : f.config.expectedHeadSha,
          target: {
            ...f.config.expectedTarget,
            baseBranch: change === 'target' ? 'release' : 'main',
          },
          observedAt: '2026-09-08T00:01:00Z',
        };
        expect(() =>
          f.journal.observe(
            attempt,
            {
              merged: true,
              autoMergeScheduled: false,
              ...(change === 'missing' ? {} : { source }),
            },
            'merge_response',
          ),
        ).toThrow();
        expect(f.journal.find(f.pod)?.state).toBe('admitted');
      } finally {
        f.db.close();
      }
    },
  );
});
