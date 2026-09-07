import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { CreatePrConfig, PrManager } from '../interfaces/pr-manager.js';
import { createDeliveryLedger } from '../pods/delivery-ledger.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createDurablePrManagerFactory } from './durable-pr-manager.js';

function requireValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing fixture capability');
  return value;
}

function fixture(db = createTestDb()) {
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: 'pod',
    profileName: 'test-profile',
    task: 'deliver',
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
  repo.update('pod', { status: 'validated' });
  const config = {
    podId: 'pod',
    repoUrl: 'https://github.com/org/repo',
    profile: { repoUrl: 'https://github.com/org/repo' },
    branch: 'feature',
    baseBranch: 'main',
    worktreePath: '/tmp/fixture',
  } as CreatePrConfig;
  const provider = {
    findPr: vi.fn(async () => null),
    createPr: vi.fn(async () => ({
      url: 'https://github.com/org/repo/pull/1',
      usedFallback: false,
    })),
    mergePr: vi.fn(),
    getPrStatus: vi.fn(),
  } as unknown as PrManager;
  const ledger = createDeliveryLedger(db);
  const manager = requireValue(
    createDurablePrManagerFactory(ledger, () => provider)(config.profile),
  );
  return { db, repo, config, provider, ledger, manager };
}

describe('durable PR delivery boundary', () => {
  it('does not create while an unanswered earlier decision is hidden by legacy pointer drift', async () => {
    const f = fixture();
    const decision = {
      id: 'saved-decision',
      podId: 'pod',
      type: 'ask_human' as const,
      timestamp: new Date().toISOString(),
      response: null,
      payload: { question: 'Deliver the reviewed work?' },
    };
    try {
      vi.mocked(requireValue(f.provider.findPr)).mockImplementationOnce(async () => {
        f.repo.update('pod', { status: 'awaiting_input', pendingEscalation: decision });
        f.repo.completionJournal?.settle(f.repo.getOrThrow('pod'), 'Preserved settlement');
        f.repo.update('pod', { status: 'validated', pendingEscalation: null });
        f.db
          .prepare(
            "INSERT INTO pod_finalizations(pod_id,generation,cycle,phase,updated_at) SELECT pod_id,generation,cycle+1,'ready',updated_at FROM pod_finalizations WHERE pod_id = 'pod' ORDER BY cycle DESC LIMIT 1",
          )
          .run();
        expect(f.repo.hasUnansweredDecision?.('pod')).toBe(true);
        return null;
      });
      await expect(f.manager.createPr(f.config)).rejects.toThrow(/reconciliation/);
      expect(f.provider.createPr).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT state FROM delivery_intents').get()).toEqual({
        state: 'reserved',
      });
      expect(f.repo.hasUnansweredDecision?.('pod')).toBe(true);
      // A durable explicit answer resolves the gate; a lost pointer does not.
      f.repo.completionJournal?.recordReply(
        { ...f.repo.getOrThrow('pod'), pendingEscalation: decision },
        'Deliver the reviewed work',
        { type: 'human', userId: 'reviewer' },
      );
      expect(await f.manager.createPr(f.config)).toMatchObject({
        url: 'https://github.com/org/repo/pull/1',
      });
      expect(f.provider.createPr).toHaveBeenCalledTimes(1);
    } finally {
      f.db.close();
    }
  });

  it.each(['merged', 'pending', 'rejected'] as const)(
    'records only confirmed merge responses as durable disposition: %s',
    async (outcome) => {
      const f = fixture();
      try {
        const created = await f.manager.createPr(f.config);
        if (outcome === 'rejected')
          vi.mocked(f.provider.mergePr).mockRejectedValue(new Error('ambiguous merge request'));
        else
          vi.mocked(f.provider.mergePr).mockResolvedValue({
            merged: outcome === 'merged',
            autoMergeScheduled: outcome === 'pending',
          });
        const call = () => f.manager.mergePr({ prUrl: created.url });
        if (outcome === 'rejected') await expect(call()).rejects.toThrow('ambiguous merge request');
        else {
          await call();
          await call();
        }
        expect(f.db.prepare('SELECT disposition FROM delivery_observations').all()).toEqual(
          outcome === 'merged' ? [{ disposition: 'merged' }] : [],
        );
        expect(f.db.prepare('SELECT disposition FROM delivery_receipts').get()).toEqual({
          disposition: 'open',
        });
        expect(f.repo.taskExecutions?.snapshot('pod').delivery?.receiptCount).toBe(1);
      } finally {
        f.db.close();
      }
    },
  );
  it('retains a confirmed merge across database close/reopen without another creation receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-disposition-restart-'));
    const databasePath = join(dir, 'test.db');
    let db = new Database(databasePath);
    try {
      runMigrations(db, new URL('../db/migrations', import.meta.url).pathname, logger);
      const f = fixture(db);
      const created = await f.manager.createPr(f.config);
      vi.mocked(f.provider.mergePr).mockResolvedValue({ merged: true, autoMergeScheduled: false });
      await f.manager.mergePr({ prUrl: created.url });
      db.close();
      db = new Database(databasePath);
      const restarted = requireValue(
        createDurablePrManagerFactory(createDeliveryLedger(db), () => f.provider)(f.config.profile),
      );
      expect(await restarted.createPr(f.config)).toEqual(created);
      expect(f.provider.createPr).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT disposition FROM delivery_receipts').all()).toEqual([
        { disposition: 'open' },
      ]);
      expect(db.prepare('SELECT disposition FROM delivery_observations').all()).toEqual([
        { disposition: 'merged' },
      ]);
      expect(createPodRepository(db).taskExecutions?.snapshot('pod').delivery?.receiptCount).toBe(
        1,
      );
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes duplicate completion across wrappers and counts one immutable receipt', async () => {
    const f = fixture();
    try {
      const results = await Promise.all([
        f.manager.createPr(f.config),
        f.manager.createPr(f.config),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(f.provider.createPr).toHaveBeenCalledTimes(1);
      expect(f.repo.taskExecutions?.snapshot('pod').delivery).toEqual({
        intentCount: 1,
        receiptCount: 1,
        unresolvedCount: 0,
        scope: 'durable-receipts-only',
        disposition: {
          openCount: 1,
          mergedCount: 0,
          closedCount: 0,
          unavailableCount: 0,
          basis: 'last-recorded',
          liveVerified: false,
        },
      });
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM delivery_receipts').get()).toEqual({ n: 1 });
      const restarted = requireValue(
        createDurablePrManagerFactory(
          createDeliveryLedger(f.db),
          () => f.provider,
        )(f.config.profile),
      );
      expect(await restarted.createPr(f.config)).toEqual(results[0]);
      expect(f.provider.createPr).toHaveBeenCalledTimes(1);
      expect(() => f.db.exec("UPDATE delivery_receipts SET pr_url = 'different'")).toThrow(
        'immutable',
      );
    } finally {
      f.db.close();
    }
  });

  it('records later external disposition without rewriting creation evidence or counting another delivery', async () => {
    const f = fixture();
    try {
      const created = await f.manager.createPr(f.config);
      vi.mocked(f.provider.getPrStatus).mockResolvedValue({
        merged: true,
        open: false,
        blockReason: null,
        ciFailures: [],
        reviewComments: [],
      });
      await f.manager.getPrStatus({ prUrl: created.url });
      await f.manager.getPrStatus({ prUrl: created.url });
      expect(f.db.prepare('SELECT disposition FROM delivery_receipts').get()).toEqual({
        disposition: 'open',
      });
      expect(f.db.prepare('SELECT disposition FROM delivery_observations').all()).toEqual([
        { disposition: 'merged' },
      ]);
      expect(f.repo.taskExecutions?.snapshot('pod').delivery?.receiptCount).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it('blocks stale generations and unanswered human input before provider create', async () => {
    const f = fixture();
    try {
      vi.mocked(requireValue(f.provider.findPr)).mockImplementationOnce(async () => {
        f.repo.incrementLifecycleGeneration('pod');
        return null;
      });
      await expect(f.manager.createPr(f.config)).rejects.toThrow(/lifecycle/);
      expect(f.provider.createPr).not.toHaveBeenCalled();
      const second = { ...f.config, branch: 'separate-execution' };
      f.repo.update('pod', { status: 'awaiting_input' });
      await expect(f.manager.createPr(second)).rejects.toThrow(/reconciliation/);
      expect(f.provider.createPr).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });

  it('does not turn lookup failure, unsupported lookup or closed PRs into permission to create', async () => {
    const f = fixture();
    try {
      vi.mocked(requireValue(f.provider.findPr)).mockRejectedValueOnce(
        new Error('lookup unavailable'),
      );
      await expect(f.manager.createPr(f.config)).rejects.toThrow('lookup unavailable');
      vi.mocked(requireValue(f.provider.findPr)).mockResolvedValueOnce({
        url: 'https://github.com/org/repo/pull/2',
        disposition: 'closed',
      });
      await expect(f.manager.createPr(f.config)).rejects.toThrow('closed');
      const unsupported = { ...f.provider, findPr: undefined };
      const manager = requireValue(
        createDurablePrManagerFactory(f.ledger, () => unsupported)(f.config.profile),
      );
      await expect(manager.createPr(f.config)).rejects.toThrow('cannot reconcile');
      expect(f.provider.createPr).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });

  it.each([139, 153])(
    'upgrades schema %s and reconciles in-flight delivery after actual close/reopen',
    async (version) => {
      const dir = mkdtempSync(join(tmpdir(), 'delivery-restart-'));
      const migrations = new URL('../db/migrations', import.meta.url).pathname;
      for (const file of readdirSync(migrations))
        if (Number.parseInt(file, 10) <= version)
          copyFileSync(join(migrations, file), join(dir, file));
      let db = new Database(join(dir, 'test.db'));
      try {
        runMigrations(db, dir, logger);
        runMigrations(db, migrations, logger);
        const f = fixture(db);
        const intent = f.ledger.reserve(f.config);
        expect(f.ledger.claim(intent)).toBe(true);
        db.close();
        db = new Database(join(dir, 'test.db'));
        const ledger = createDeliveryLedger(db);
        const provider = f.provider;
        vi.mocked(requireValue(provider.findPr)).mockResolvedValue({
          url: 'https://github.com/org/repo/pull/1',
          disposition: 'merged',
        });
        const restarted = requireValue(
          createDurablePrManagerFactory(ledger, () => provider)(f.config.profile),
        );
        expect((await restarted.createPr(f.config)).url).toContain('/pull/1');
        expect(provider.createPr).not.toHaveBeenCalled();
        expect(db.prepare('SELECT evidence, disposition FROM delivery_receipts').get()).toEqual({
          evidence: 'provider_lookup',
          disposition: 'merged',
        });
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
