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
  it('requires a fresh source-bound reopening across equivalent intents for the same PR', () => {
    const f = fixture();
    try {
      const first = f.journal.plan(f.pod, f.publicationPod, f.publicationId, f.config);
      const second = f.journal.plan(f.pod, f.publicationPod, f.publicationId, {
        ...f.config,
        squash: true,
      });
      const status = {
        merged: false,
        open: false,
        headSha: f.proof.commitSha,
        sourceTarget: f.config.expectedTarget,
        blockReason: null,
        ciFailures: [],
        reviewComments: [],
      };
      f.journal.observeStatus(second.id, { ...status, open: true });
      f.journal.observeStatus(first.id, status);
      expect(f.journal.find(f.pod)).toMatchObject({ id: second.id, prDisposition: 'closed' });
      expect(() =>
        f.journal.claim(f.pod, f.publicationPod, f.publicationId, { ...f.config, squash: true }),
      ).toThrow('closed');
      f.journal.observeStatus(second.id, { ...status, open: true });
      expect(f.journal.find(f.pod)).toMatchObject({ id: second.id, prDisposition: 'open' });
      f.journal.claim(f.pod, f.publicationPod, f.publicationId, { ...f.config, squash: true });
      expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  });

  it('preserves closed and reopened source observations without treating closure as merge or retry permission', () => {
    const f = fixture();
    try {
      const planned = f.journal.plan(f.pod, f.publicationPod, f.publicationId, f.config);
      const status = {
        merged: false,
        open: false,
        headSha: f.proof.commitSha,
        sourceTarget: f.config.expectedTarget,
        blockReason: 'Closed',
        ciFailures: [],
        reviewComments: [],
      };
      f.journal.observeStatus(planned.id, status);
      f.journal.observeStatus(planned.id, status);
      const reopened = createMergeJournal(f.db);
      expect(reopened.find(f.pod)).toMatchObject({
        state: 'planned',
        prDisposition: 'closed',
        attemptId: null,
      });
      expect(f.repo.taskExecutions?.snapshot(f.pod.id).merge).toMatchObject({
        mergedPrCount: 0,
        closedPrCount: 1,
        unresolvedPrCount: 0,
        requestCount: 0,
      });
      expect(() => reopened.claim(f.pod, f.publicationPod, f.publicationId, f.config)).toThrow(
        'closed',
      );
      reopened.observeStatus(planned.id, { ...status, open: true });
      expect(f.repo.taskExecutions?.snapshot(f.pod.id).merge).toMatchObject({
        mergedPrCount: 0,
        closedPrCount: 0,
        unresolvedPrCount: 1,
      });
      const attempt = reopened.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      reopened.observeStatus(planned.id, status);
      reopened.observeStatus(planned.id, { ...status, open: true });
      expect(() => reopened.claim(f.pod, f.publicationPod, f.publicationId, f.config)).toThrow(
        'ambiguous',
      );
      expect(reopened.find(f.pod)).toMatchObject({
        attemptId: attempt,
        state: 'admitted',
        prDisposition: 'open',
      });
      expect(
        f.db.prepare('SELECT disposition FROM merge_status_observations ORDER BY sequence').all(),
      ).toEqual([
        { disposition: 'closed' },
        { disposition: 'open' },
        { disposition: 'closed' },
        { disposition: 'open' },
      ]);
      expect(() =>
        f.db.prepare('UPDATE merge_status_observations SET observed_at = observed_at').run(),
      ).toThrow('immutable');
    } finally {
      f.db.close();
    }
  });

  it('counts duplicate source-bound dispositions for one canonical PR once and isolates intentional reruns', () => {
    const f = fixture();
    try {
      const first = f.journal.plan(f.pod, f.publicationPod, f.publicationId, f.config);
      const second = f.journal.plan(f.pod, f.publicationPod, f.publicationId, {
        ...f.config,
        squash: true,
      });
      expect(first.id).not.toBe(second.id);
      f.journal.observeDisposition(first.id, f.result);
      f.journal.observeDisposition(second.id, f.result);
      const snapshot = f.repo.taskExecutions?.snapshot(f.pod.id);
      expect(snapshot?.merge).toEqual({
        prCount: 1,
        requestCount: 0,
        mergedPrCount: 1,
        mergedWithoutRecordedRequestCount: 1,
        unresolvedPrCount: 0,
        closedPrCount: 0,
        scope: 'source-bound-journal-only',
        basis: 'last-recorded',
        liveVerified: false,
      });
      expect(snapshot?.delivery?.receiptCount).toBe(0);
      expect(snapshot?.agentRunCount).toBe(0);
      expect(
        f.db.prepare('SELECT count(*) AS n FROM merge_disposition_observations').get(),
      ).toEqual({ n: 2 });
      f.repo.insert({
        id: 'independent',
        profileName: 'test-profile',
        task: 'Intentional rerun',
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
      expect(f.repo.taskExecutions?.snapshot('independent').merge).toMatchObject({
        prCount: 0,
        requestCount: 0,
        mergedPrCount: 0,
      });
    } finally {
      f.db.close();
    }
  });

  it('retains a source-bound merged observation across disk restart without inventing a request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopod-merge-disposition-'));
    const path = join(dir, 'journal.db');
    let db = new Database(path);
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, new URL('../db/migrations', import.meta.url).pathname, logger);
      const f = fixture(db);
      const planned = f.journal.plan(f.pod, f.publicationPod, f.publicationId, f.config);
      db.close();
      db = new Database(path);
      const restarted = createMergeJournal(db);
      const closed = {
        merged: false,
        open: false,
        headSha: f.proof.commitSha,
        sourceTarget: f.config.expectedTarget,
        blockReason: null,
        ciFailures: [],
        reviewComments: [],
      };
      restarted.observeStatus(planned.id, closed);
      db.close();
      db = new Database(path);
      const afterClosure = createMergeJournal(db);
      expect(afterClosure.find(f.pod)).toMatchObject({ state: 'planned', prDisposition: 'closed' });
      expect(() =>
        afterClosure.observeStatus(planned.id, { ...closed, open: true, headSha: 'c'.repeat(40) }),
      ).toThrow();
      expect(() => afterClosure.claim(f.pod, f.publicationPod, f.publicationId, f.config)).toThrow(
        'closed',
      );
      afterClosure.observeStatus(planned.id, { ...closed, open: true });
      afterClosure.observeDisposition(planned.id, f.result);
      afterClosure.observeDisposition(planned.id, f.result);
      db.close();
      db = new Database(path);
      const recovered = createMergeJournal(db);
      expect(recovered.find(f.pod)).toMatchObject({
        state: 'merged',
        attemptId: null,
        result: f.result,
      });
      expect(db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM merge_observations').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM merge_disposition_observations').get()).toEqual({
        n: 1,
      });
      expect(() =>
        db.prepare('UPDATE merge_disposition_observations SET result = result').run(),
      ).toThrow('immutable');
      expect(() => recovered.claim(f.pod, f.publicationPod, f.publicationId, f.config)).toThrow(
        'already confirmed',
      );
      const repo = createPodRepository(db);
      repo.incrementLifecycleGeneration(f.pod.id);
      const current = repo.getOrThrow(f.pod.id);
      const publications = createSourcePublicationLedger(db);
      const publicationId = publications.admit(current, f.proof);
      publications.confirm(current, publicationId, f.proof);
      expect(() => recovered.claim(current, current, publicationId, f.config)).toThrow(
        'already confirmed',
      );
      expect(repo.taskExecutions?.snapshot(f.pod.id).merge).toMatchObject({
        prCount: 1,
        requestCount: 0,
        mergedPrCount: 1,
        mergedWithoutRecordedRequestCount: 1,
        unresolvedPrCount: 0,
      });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['missing-source', 'wrong-head', 'wrong-target', 'pending', 'admitted'] as const)(
    'rejects unproven or misclassified planned disposition (%s)',
    (change) => {
      const f = fixture();
      try {
        const planned = f.journal.plan(f.pod, f.publicationPod, f.publicationId, f.config);
        if (change === 'admitted')
          f.journal.claim(f.pod, f.publicationPod, f.publicationId, f.config);
        const result = structuredClone(f.result);
        if (change === 'missing-source') result.source = undefined;
        if (change === 'wrong-head' && result.source) result.source.headSha = 'c'.repeat(40);
        if (change === 'wrong-target' && result.source) result.source.target.baseBranch = 'other';
        if (change === 'pending') result.merged = false;
        expect(() => f.journal.observeDisposition(planned.id, result)).toThrow();
        expect(
          f.db.prepare('SELECT count(*) AS n FROM merge_disposition_observations').get(),
        ).toEqual({ n: 0 });
      } finally {
        f.db.close();
      }
    },
  );

  it('persists a planned source binding without inventing an attempt, then admits exactly one request', () => {
    const f = fixture();
    try {
      const planned = f.journal.plan(f.pod, f.publicationPod, f.publicationId, f.config);
      expect(planned).toMatchObject({ state: 'planned', attemptId: null, result: null });
      expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 0 });
      const reopened = createMergeJournal(f.db);
      expect(reopened.find(f.pod)).toEqual(planned);
      expect(reopened.plan(f.pod, f.publicationPod, f.publicationId, f.config).id).toBe(planned.id);
      const attemptId = reopened.claim(f.pod, f.publicationPod, f.publicationId, f.config);
      expect(reopened.find(f.pod)).toMatchObject({ id: planned.id, state: 'admitted', attemptId });
      expect(f.db.prepare('SELECT count(*) AS n FROM merge_intents').get()).toEqual({ n: 1 });
      expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 1 });
    } finally {
      f.db.close();
    }
  });

  it('retains ambiguous admission across independent connections and close/reopen, then records one immutable confirmation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopod-merge-journal-'));
    const path = join(dir, 'journal.db');
    let db = new Database(path);
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, new URL('../db/migrations', import.meta.url).pathname, logger);
      const f = fixture(db);
      const planned = f.journal.plan(f.pod, f.publicationPod, f.publicationId, f.config);
      db.close();
      db = new Database(path);
      db.pragma('foreign_keys = ON');
      const beforeAdmission = createMergeJournal(db);
      expect(beforeAdmission.find(f.pod)).toMatchObject({
        id: planned.id,
        state: 'planned',
        attemptId: null,
      });
      expect(db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 0 });
      const attempt = beforeAdmission.claim(f.pod, f.publicationPod, f.publicationId, f.config);
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
      expect(f.repo.taskExecutions?.snapshot(f.pod.id).merge).toMatchObject({
        prCount: 1,
        requestCount: 2,
        mergedPrCount: 1,
        mergedWithoutRecordedRequestCount: 0,
        unresolvedPrCount: 0,
      });
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
