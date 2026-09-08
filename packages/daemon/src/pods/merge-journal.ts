import { createHash, randomUUID } from 'node:crypto';
import type { Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type {
  MergePrConfig,
  MergePrResult,
  MergePrTarget,
  PrMergeStatus,
} from '../interfaces/pr-manager.js';
import { canonicalMergePrIdentity as prIdentity } from '../worktrees/merge-pr-identity.js';
import {
  assertMergeRepository,
  assertMergeSource,
  assertMergeTarget,
  mergeReconciliation,
} from '../worktrees/merge-source-identity.js';
import { ensureMergeIdentityProjection } from './merge-identity-projection.js';
import { createSourcePublicationLedger } from './source-publication-ledger.js';

export interface BoundMergeConfig {
  prUrl: string;
  expectedHeadSha: string;
  expectedTarget: MergePrTarget;
  squash: boolean;
}
interface MergeRequest {
  config: BoundMergeConfig;
  publicationPrUrl: string | null;
}
export interface MergeJournalEntry {
  id: string;
  publicationId: string;
  attemptId: string | null;
  request: MergeRequest;
  state: 'planned' | 'admitted' | 'pending' | 'merged';
  result: MergePrResult | null;
  prDisposition?: 'open' | 'closed';
}
export interface MergeJournal {
  plan(
    pod: Pod,
    publicationPod: Pod,
    publicationId: string,
    config: MergePrConfig,
  ): MergeJournalEntry;
  find(pod: Pod): MergeJournalEntry | null;
  check(pod: Pod, entry: MergeJournalEntry): void;
  claim(pod: Pod, publicationPod: Pod, publicationId: string, config: MergePrConfig): string;
  observeDisposition(intentId: string, result: MergePrResult): void;
  observeStatus(intentId: string, status: PrMergeStatus): void;
  observe(
    attemptId: string,
    result: MergePrResult,
    evidence: 'merge_response' | 'provider_lookup',
  ): void;
}
interface IntentRow {
  id: string;
  publicationId: string;
  request: string;
}
function requestFrom(row: IntentRow): MergeRequest {
  try {
    if (!row.request || row.request.length > 16384) throw new Error('Unbounded request');
    return JSON.parse(row.request) as MergeRequest;
  } catch {
    return mergeReconciliation('Durable merge identity is unavailable.');
  }
}

export function createMergeJournal(db: Database.Database): MergeJournal {
  ensureMergeIdentityProjection(db);
  const publications = createSourcePublicationLedger(db);
  const columns = 'id, publication_id AS publicationId, request';
  function verify(pod: Pod, row: IntentRow) {
    const request = requestFrom(row);
    if (!pod.prUrl || prIdentity(pod.prUrl) !== prIdentity(request.config.prUrl))
      mergeReconciliation('The PR assigned to this lifecycle changed.');
    const source = publications.confirmedForMerge(
      { ...pod, prUrl: request.publicationPrUrl },
      pod,
      row.publicationId,
    );
    assertMergeSource(source.commitSha, request.config.expectedHeadSha);
    assertMergeRepository(request.config.expectedTarget, source.repository);
    if (
      !request.config.expectedTarget ||
      request.config.expectedTarget.branch !== source.branch ||
      (pod.baseBranch !== null && request.config.expectedTarget.baseBranch !== pod.baseBranch)
    )
      mergeReconciliation('The durable merge target differs from its source publication.');
    assertMergeTarget(request.config.expectedTarget, request.config.expectedTarget);
  }
  function entry(row: IntentRow): MergeJournalEntry {
    const attempt = db
      .prepare('SELECT id FROM merge_attempts WHERE intent_id = ? ORDER BY sequence DESC LIMIT 1')
      .get(row.id) as { id: string } | undefined;
    const observation = (db
      .prepare(
        "SELECT disposition, result FROM merge_observations WHERE intent_id = ? AND disposition = 'merged'",
      )
      .get(row.id) ??
      db
        .prepare(
          'SELECT disposition, result FROM merge_observations WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1',
        )
        .get(attempt?.id ?? null) ??
      db
        .prepare(
          'SELECT disposition, result FROM merge_disposition_observations WHERE intent_id = ?',
        )
        .get(row.id)) as { disposition: 'pending' | 'merged'; result: string } | undefined;
    const status = db
      .prepare(
        'SELECT o.disposition, o.intent_id AS intentId FROM merge_status_observations o JOIN canonical_merge_intents i ON i.id = o.intent_id WHERE i.pr_identity = (SELECT pr_identity FROM canonical_merge_intents WHERE id = ?) ORDER BY o.sequence DESC LIMIT 1',
      )
      .get(row.id) as { disposition: 'open' | 'closed' } | undefined;
    return {
      id: row.id,
      publicationId: row.publicationId,
      ...(status ? { prDisposition: status.disposition } : {}),
      attemptId: attempt?.id ?? null,
      request: requestFrom(row),
      state: observation?.disposition ?? (attempt ? 'admitted' : 'planned'),
      result: observation ? (JSON.parse(observation.result) as MergePrResult) : null,
    };
  }
  function prepare(
    pod: Pod,
    publicationPod: Pod,
    publicationId: string,
    config: MergePrConfig,
  ): IntentRow {
    if (
      !['merging', 'merge_pending'].includes(pod.status) ||
      !pod.prUrl ||
      !config.expectedHeadSha ||
      !config.expectedTarget
    )
      return mergeReconciliation(
        'Merge admission requires a current lifecycle and complete source identity.',
      );
    const source = publications.confirmedForMerge(publicationPod, pod, publicationId);
    if (prIdentity(pod.prUrl) !== prIdentity(config.prUrl))
      return mergeReconciliation('The requested PR is no longer assigned to this lifecycle.');
    assertMergeSource(source.commitSha, config.expectedHeadSha);
    assertMergeRepository(config.expectedTarget, source.repository);
    assertMergeTarget(config.expectedTarget, {
      repository: source.repository,
      branch: source.branch,
      baseBranch: pod.baseBranch ?? config.expectedTarget.baseBranch,
    });
    const task = db
      .prepare(
        'SELECT i.task_id AS taskId FROM source_publication_intents i JOIN task_executions e ON e.task_id = i.task_id WHERE i.id = ? AND e.pod_id = ?',
      )
      .get(publicationId, pod.id) as { taskId: string } | undefined;
    if (!task) return mergeReconciliation('The logical task changed after source publication.');
    const request: MergeRequest = {
      publicationPrUrl: publicationPod.prUrl,
      config: {
        prUrl: config.prUrl,
        expectedHeadSha: source.commitSha,
        expectedTarget: {
          repository: source.repository,
          branch: source.branch,
          baseBranch: config.expectedTarget.baseBranch,
        },
        squash: config.squash === true,
      },
    };
    // Unknown retained identities might refer to this same PR. Do not infer
    // absence of an earlier request from a failed comparison.
    if (db.prepare('SELECT 1 FROM canonical_merge_intents WHERE pr_identity IS NULL LIMIT 1').get())
      return mergeReconciliation(
        'A retained merge identity is unavailable; reconcile its journal before admission.',
      );
    const resource = prIdentity(config.prUrl);
    const hash = createHash('sha256')
      .update(JSON.stringify([publicationId, request]))
      .digest('hex');
    const prior = db
      .prepare(`SELECT ${columns} FROM canonical_merge_intents WHERE identity = ?`)
      .get(hash) as IntentRow | undefined;
    const scheduled = db
      .prepare(
        `SELECT i.id FROM canonical_merge_intents i JOIN merge_observations o ON o.intent_id = i.id
     WHERE i.pr_identity = ? AND o.disposition = 'pending'
       AND json_extract(o.result, '$.autoMergeScheduled') = 1
       AND NOT EXISTS (SELECT 1 FROM merge_observations done
         WHERE done.intent_id = i.id AND done.disposition = 'merged') LIMIT 1`,
      )
      .get(resource);
    if (scheduled)
      return mergeReconciliation(
        'The earlier merge is already scheduled; reconcile its disposition.',
      );
    const confirmed = db
      .prepare(`SELECT i.id FROM canonical_merge_intents i WHERE i.pr_identity = ?
      AND (EXISTS (SELECT 1 FROM merge_observations o WHERE o.intent_id = i.id AND o.disposition = 'merged')
        OR EXISTS (SELECT 1 FROM merge_disposition_observations o WHERE o.intent_id = i.id)) LIMIT 1`)
      .get(resource);
    if (confirmed) return mergeReconciliation('This merge is already confirmed.');
    const lastStatus = db
      .prepare(`SELECT o.disposition FROM merge_status_observations o
      JOIN canonical_merge_intents i ON i.id = o.intent_id WHERE i.pr_identity = ? ORDER BY o.sequence DESC LIMIT 1`)
      .get(resource) as { disposition: string } | undefined;
    if (lastStatus?.disposition === 'closed')
      return mergeReconciliation(
        'The PR was observed closed; reconcile its source-bound status before another request.',
      );
    const uncertain = db
      .prepare(
        'SELECT a.id FROM merge_attempts a JOIN canonical_merge_intents i ON i.id = a.intent_id WHERE i.pr_identity = ? AND NOT EXISTS (SELECT 1 FROM merge_observations o WHERE o.attempt_id = a.id) LIMIT 1',
      )
      .get(resource);
    if (uncertain)
      return mergeReconciliation(
        'An earlier merge request is still ambiguous; no duplicate mutation was admitted.',
      );
    const id = prior?.id ?? randomUUID();
    if (!prior)
      db.prepare(
        'INSERT INTO merge_intents(id, identity, publication_id, pod_id, task_id, generation, pr_identity, request, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        hash,
        publicationId,
        pod.id,
        task.taskId,
        pod.lifecycleGeneration,
        resource,
        JSON.stringify(request),
        new Date().toISOString(),
      );
    return { id, publicationId, request: JSON.stringify(request) };
  }
  return {
    plan(pod, publicationPod, publicationId, config) {
      if (db.inTransaction)
        return mergeReconciliation('Merge planning cannot share an uncommitted transaction.');
      return db
        .transaction(() => entry(prepare(pod, publicationPod, publicationId, config)))
        .immediate();
    },
    find(pod) {
      const row = db
        .prepare(
          `SELECT ${columns} FROM canonical_merge_intents WHERE pod_id = ? AND generation = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(pod.id, pod.lifecycleGeneration) as IntentRow | undefined;
      if (!row) return null;
      verify(pod, row);
      return entry(row);
    },
    check(pod, value) {
      const row = db
        .prepare(`SELECT ${columns} FROM canonical_merge_intents WHERE id = ?`)
        .get(value.id) as IntentRow | undefined;
      if (!row) return mergeReconciliation('Merge admission is missing.');
      verify(pod, row);
    },
    claim(pod, publicationPod, publicationId, config) {
      if (db.inTransaction)
        return mergeReconciliation('Merge admission cannot share an uncommitted transaction.');
      return db
        .transaction(() => {
          const { id } = prepare(pod, publicationPod, publicationId, config);
          const attemptId = randomUUID();
          db.prepare('INSERT INTO merge_attempts(id, intent_id, admitted_at) VALUES (?, ?, ?)').run(
            attemptId,
            id,
            new Date().toISOString(),
          );
          return attemptId;
        })
        .immediate();
    },
    observeStatus(intentId, status) {
      if (db.inTransaction)
        return mergeReconciliation('PR status cannot share an uncommitted transaction.');
      db.transaction(() => {
        const row = db
          .prepare(`SELECT ${columns} FROM canonical_merge_intents WHERE id = ?`)
          .get(intentId) as IntentRow | undefined;
        if (
          !row ||
          status.merged !== false ||
          typeof status.open !== 'boolean' ||
          !status.headSha ||
          !status.sourceTarget
        )
          return mergeReconciliation(
            'The provider did not confirm the planned PR source and target.',
          );
        const request = requestFrom(row);
        assertMergeSource(request.config.expectedHeadSha, status.headSha);
        assertMergeTarget(request.config.expectedTarget, status.sourceTarget);
        const disposition = status.open ? 'open' : 'closed';
        const last = db
          .prepare(
            'SELECT o.disposition, o.intent_id AS intentId FROM merge_status_observations o JOIN canonical_merge_intents i ON i.id = o.intent_id WHERE i.pr_identity = (SELECT pr_identity FROM canonical_merge_intents WHERE id = ?) ORDER BY o.sequence DESC LIMIT 1',
          )
          .get(intentId) as { disposition: string; intentId: string } | undefined;
        if (last?.disposition === disposition && last.intentId === intentId) return;
        db.prepare(
          'INSERT INTO merge_status_observations (intent_id, disposition, source, observed_at) VALUES (?, ?, ?, ?)',
        ).run(
          intentId,
          disposition,
          JSON.stringify({ headSha: status.headSha, target: { ...request.config.expectedTarget } }),
          new Date().toISOString(),
        );
      }).immediate();
    },
    observeDisposition(intentId, result) {
      if (db.inTransaction)
        return mergeReconciliation('Merge disposition cannot share an uncommitted transaction.');
      db.transaction(() => {
        const row = db
          .prepare(`SELECT ${columns} FROM canonical_merge_intents WHERE id = ?`)
          .get(intentId) as IntentRow | undefined;
        if (
          !row ||
          result.merged !== true ||
          result.autoMergeScheduled !== false ||
          !result.source ||
          !Number.isFinite(Date.parse(result.source.observedAt))
        )
          return mergeReconciliation('The provider did not confirm the planned source and target.');
        if (db.prepare('SELECT 1 FROM merge_attempts WHERE intent_id = ? LIMIT 1').get(intentId))
          return mergeReconciliation(
            'A merge request was admitted; reconcile that request instead.',
          );
        const request = requestFrom(row);
        assertMergeSource(request.config.expectedHeadSha, result.source.headSha);
        assertMergeTarget(request.config.expectedTarget, result.source.target);
        const canonical: MergePrResult = {
          merged: true,
          autoMergeScheduled: false,
          source: {
            headSha: result.source.headSha,
            target: { ...request.config.expectedTarget },
            observedAt: result.source.observedAt,
          },
        };
        // Keep a historical fact even if the worker disappears during lookup.
        // Consuming it still requires current authority and retained source checks.
        db.prepare(`INSERT OR IGNORE INTO merge_disposition_observations
          (intent_id, disposition, evidence, result, observed_at) VALUES (?, 'merged', 'provider_lookup', ?, ?)`).run(
          intentId,
          JSON.stringify(canonical),
          new Date().toISOString(),
        );
      }).immediate();
    },
    observe(attemptId, result, evidence) {
      if (db.inTransaction)
        return mergeReconciliation('Merge confirmation cannot share an uncommitted transaction.');
      db.transaction(() => {
        const row = db
          .prepare(
            'SELECT i.id, i.publication_id AS publicationId, i.request FROM merge_attempts a JOIN canonical_merge_intents i ON i.id = a.intent_id WHERE a.id = ?',
          )
          .get(attemptId) as IntentRow | undefined;
        if (
          !row ||
          typeof result.merged !== 'boolean' ||
          typeof result.autoMergeScheduled !== 'boolean'
        )
          return mergeReconciliation('Provider merge confirmation is unavailable.');
        const request = requestFrom(row);
        if (result.merged) {
          if (!result.source || !Number.isFinite(Date.parse(result.source.observedAt)))
            return mergeReconciliation(
              'The provider did not confirm the admitted source and target.',
            );
          assertMergeSource(request.config.expectedHeadSha, result.source.headSha);
          assertMergeTarget(request.config.expectedTarget, result.source.target);
        }
        const canonical: MergePrResult = {
          merged: result.merged,
          autoMergeScheduled: result.autoMergeScheduled,
          ...(result.merged && result.source
            ? {
                source: {
                  headSha: result.source.headSha,
                  target: { ...request.config.expectedTarget },
                  observedAt: result.source.observedAt,
                },
              }
            : {}),
        };
        // This records an external fact even if the worker was replaced/deleted.
        // Current lifecycle ownership is checked separately before consuming it.
        db.prepare(
          'INSERT OR IGNORE INTO merge_observations(attempt_id, intent_id, disposition, evidence, result, observed_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          attemptId,
          row.id,
          result.merged ? 'merged' : 'pending',
          evidence,
          JSON.stringify(canonical),
          new Date().toISOString(),
        );
      }).immediate();
    },
  };
}
