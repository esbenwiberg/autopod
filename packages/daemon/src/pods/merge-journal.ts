import { createHash, randomUUID } from 'node:crypto';
import type { Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { MergePrConfig, MergePrResult, MergePrTarget } from '../interfaces/pr-manager.js';
import { parseGitHubPrUrl } from '../worktrees/github-url-identity.js';
import {
  assertMergeRepository,
  assertMergeSource,
  assertMergeTarget,
  mergeReconciliation,
} from '../worktrees/merge-source-identity.js';
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
  attemptId: string;
  request: MergeRequest;
  state: 'admitted' | 'pending' | 'merged';
  result: MergePrResult | null;
}
export interface MergeJournal {
  find(pod: Pod): MergeJournalEntry | null;
  check(pod: Pod, entry: MergeJournalEntry): void;
  claim(pod: Pod, publicationPod: Pod, publicationId: string, config: MergePrConfig): string;
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
function prIdentity(raw: string): string {
  try {
    const url = new URL(raw);
    if (
      raw.length > 4096 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return mergeReconciliation('A canonical PR address is required for durable merge admission.');
    const path = url.pathname.replace(/\/$/, '');
    if (url.hostname === 'github.com') {
      const pr = parseGitHubPrUrl(raw);
      return `https://github.com/${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}/pull/${pr.number}`;
    }
    const canonical = url.hostname === 'dev.azure.com';
    const match = path.match(
      canonical
        ? /^\/[^/]+\/[^/]+\/_git\/[^/]+\/pullrequest\/([1-9][0-9]*)$/
        : /^\/[^/]+\/_git\/[^/]+\/pullrequest\/([1-9][0-9]*)$/,
    );
    if (!match || !Number.isSafeInteger(Number(match[1])))
      return mergeReconciliation('The durable PR address is not an exact supported pull request.');
    if (url.hostname.endsWith('.visualstudio.com'))
      return `https://dev.azure.com/${url.hostname.slice(0, -'.visualstudio.com'.length)}${path}`;
    if (url.hostname === 'dev.azure.com') return `${url.origin}${path}`;
  } catch {
    return mergeReconciliation('The durable PR identity is unsupported.');
  }
  return mergeReconciliation('The durable PR identity is unsupported.');
}

export function createMergeJournal(db: Database.Database): MergeJournal {
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
    if (!attempt) return mergeReconciliation('Merge admission is missing.');
    const observation = (db
      .prepare(
        "SELECT disposition, result FROM merge_observations WHERE intent_id = ? AND disposition = 'merged'",
      )
      .get(row.id) ??
      db
        .prepare(
          'SELECT disposition, result FROM merge_observations WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1',
        )
        .get(attempt.id)) as { disposition: 'pending' | 'merged'; result: string } | undefined;
    return {
      id: row.id,
      publicationId: row.publicationId,
      attemptId: attempt.id,
      request: requestFrom(row),
      state: observation?.disposition ?? 'admitted',
      result: observation ? (JSON.parse(observation.result) as MergePrResult) : null,
    };
  }
  return {
    find(pod) {
      const row = db
        .prepare(
          `SELECT ${columns} FROM merge_intents WHERE pod_id = ? AND generation = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(pod.id, pod.lifecycleGeneration) as IntentRow | undefined;
      if (!row) return null;
      verify(pod, row);
      return entry(row);
    },
    check(pod, value) {
      const row = db.prepare(`SELECT ${columns} FROM merge_intents WHERE id = ?`).get(value.id) as
        | IntentRow
        | undefined;
      if (!row) return mergeReconciliation('Merge admission is missing.');
      verify(pod, row);
    },
    claim(pod, publicationPod, publicationId, config) {
      if (db.inTransaction)
        return mergeReconciliation('Merge admission cannot share an uncommitted transaction.');
      return db
        .transaction(() => {
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
          if (!task)
            return mergeReconciliation('The logical task changed after source publication.');
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
          const resource = prIdentity(config.prUrl);
          const hash = createHash('sha256')
            .update(JSON.stringify([publicationId, request]))
            .digest('hex');
          const prior = db
            .prepare(`SELECT ${columns} FROM merge_intents WHERE identity = ?`)
            .get(hash) as IntentRow | undefined;
          if (prior && entry(prior).result?.autoMergeScheduled)
            return mergeReconciliation(
              'The earlier merge is already scheduled; reconcile its disposition.',
            );
          if (prior && entry(prior).state === 'merged')
            return mergeReconciliation('This merge is already confirmed.');
          const uncertain = db
            .prepare(
              'SELECT a.id FROM merge_attempts a JOIN merge_intents i ON i.id = a.intent_id WHERE i.pr_identity = ? AND NOT EXISTS (SELECT 1 FROM merge_observations o WHERE o.attempt_id = a.id) LIMIT 1',
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
    observe(attemptId, result, evidence) {
      if (db.inTransaction)
        return mergeReconciliation('Merge confirmation cannot share an uncommitted transaction.');
      db.transaction(() => {
        const row = db
          .prepare(
            'SELECT i.id, i.publication_id AS publicationId, i.request FROM merge_attempts a JOIN merge_intents i ON i.id = a.intent_id WHERE a.id = ?',
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
