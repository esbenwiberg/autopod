import { createHash, randomUUID } from 'node:crypto';
import {
  AutopodError,
  type CreatePodRequest,
  type DispatchPreflightEvidence,
  type IntentionalRerun,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface DispatchPreflightLedger {
  registerRequest(podId: string, repository?: string): void;
  findRerun(request: CreatePodRequest, userId: string): string | null;
  registerRerun(
    podId: string,
    request: IntentionalRerun,
    userId: string,
    requestHash: string,
  ): void;
  inspect(
    podId: string,
    generation: number,
    repository: string,
    baseBranch: string,
    baseCommitSha: string,
  ): DispatchPreflightEvidence;
  latest(podId: string): DispatchPreflightEvidence | null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const dispatchRequestHash = (request: CreatePodRequest): string =>
  createHash('sha256').update(canonical(request)).digest('hex');
/** Credential-free exact repository identity; no inferred aliases across hosts. */
function repositoryIdentity(raw: string): string {
  const ssh = raw.match(/^git@([^:]+):(.+)$/);
  let url: URL;
  try {
    url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : raw);
  } catch {
    throw new AutopodError(
      'Repository identity is invalid; reconcile before dispatch',
      'DISPATCH_IDENTITY_UNAVAILABLE',
      409,
    );
  }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol))
    throw new AutopodError(
      'Repository identity unavailable for dispatch',
      'DISPATCH_IDENTITY_UNAVAILABLE',
      409,
    );
  return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`;
}
interface RequestRow {
  id: string;
  rowNumber: number;
  task: string;
  contract: string | null;
  taskId: string;
  executionId: string;
  generation: number;
  linkedPodId: string | null;
  status: string;
  baseBranch: string;
  repository: string;
  profileSnapshot: string | null;
  frozenRepository: string | null;
}
const hash = (row: Pick<RequestRow, 'task' | 'contract'>): string => {
  if (row.task.length > 50000 || (row.contract?.length ?? 0) > 1048576)
    throw new AutopodError(
      'Existing dispatch request exceeds its evidence bound; reconcile the record',
      'DISPATCH_IDENTITY_UNAVAILABLE',
      409,
    );
  try {
    return createHash('sha256')
      .update(
        canonical({
          task: row.task,
          contract: row.contract ? JSON.parse(row.contract) : null,
        }),
      )
      .digest('hex');
  } catch {
    throw new AutopodError(
      'Existing dispatch contract is unreadable; reconcile the record',
      'DISPATCH_IDENTITY_UNAVAILABLE',
      409,
    );
  }
};
const requestRepository = (row: RequestRow): string => {
  if (row.frozenRepository) return row.frozenRepository;
  if ((row.profileSnapshot?.length ?? 0) > 1048576)
    throw new AutopodError(
      'Profile identity exceeds its evidence bound',
      'DISPATCH_IDENTITY_UNAVAILABLE',
      409,
    );
  try {
    const snapshot = row.profileSnapshot
      ? (JSON.parse(row.profileSnapshot) as { repoUrl?: string })
      : null;
    if (!snapshot?.repoUrl) throw new Error('No historical repository binding');
    return repositoryIdentity(snapshot.repoUrl);
  } catch {
    throw new AutopodError(
      'Historical repository binding is unreadable; reconcile before dispatch',
      'DISPATCH_IDENTITY_UNAVAILABLE',
      409,
    );
  }
};
const selectRequest = `SELECT p.id, p.rowid AS rowNumber, substr(p.task,1,50001) AS task, substr(p.contract,1,1048577) AS contract, p.status, p.linked_pod_id AS linkedPodId,
  p.lifecycle_generation AS generation, e.task_id AS taskId, e.execution_id AS executionId,
  COALESCE(b.base_branch, p.base_branch, json_extract(CASE WHEN json_valid(p.profile_snapshot) THEN p.profile_snapshot ELSE NULL END, '$.defaultBranch')) AS baseBranch, f.repo_url AS repository, b.repository AS frozenRepository, substr(p.profile_snapshot,1,1048577) AS profileSnapshot
  FROM pods p JOIN task_executions e ON e.pod_id = p.id LEFT JOIN profiles f ON f.name = p.profile_name LEFT JOIN execution_dispatch_bindings b ON b.execution_id = e.execution_id`;
export function createDispatchPreflightLedger(db: Database.Database): DispatchPreflightLedger {
  const get = (id: string): RequestRow => {
    const row = db.prepare(`${selectRequest} WHERE p.id = ?`).get(id) as RequestRow | undefined;
    if (!row)
      throw new AutopodError(
        'Dispatch task identity unavailable',
        'DISPATCH_IDENTITY_UNAVAILABLE',
        409,
      );
    return row;
  };
  const decode = (row: Record<string, unknown>): DispatchPreflightEvidence => ({
    id: row.id as string,
    version: 1,
    podId: row.pod_id as string,
    executionId: row.execution_id as string,
    taskId: row.task_id as string,
    generation: row.generation as number,
    repository: row.repository as string,
    baseBranch: row.base_branch as string,
    baseCommitSha: row.base_commit_sha as string,
    workHash: row.work_hash as string,
    status: row.status as DispatchPreflightEvidence['status'],
    conflicts: JSON.parse(row.conflicts as string),
    rerun: row.rerun_intent ? JSON.parse(row.rerun_intent as string) : null,
    checkedAt: row.checked_at as string,
  });
  return {
    registerRequest(podId, repository) {
      const pod = get(podId);
      const profile = db
        .prepare(
          'SELECT default_branch AS baseBranch FROM profiles WHERE name = (SELECT profile_name FROM pods WHERE id = ?)',
        )
        .get(podId) as { baseBranch: string } | undefined;
      db.prepare(
        'INSERT INTO execution_dispatch_bindings(execution_id,repository,base_branch,recorded_at) VALUES (?,?,?,?)',
      ).run(
        pod.executionId,
        repositoryIdentity(repository ?? pod.repository),
        pod.baseBranch ?? profile?.baseBranch ?? 'main',
        new Date().toISOString(),
      );
    },
    findRerun(request, userId) {
      if (!request.intentionalRerun) return null;
      const row = db
        .prepare(
          'SELECT pod_id AS podId, execution_id AS executionId, request_hash AS requestHash FROM execution_rerun_intents WHERE user_id = ? AND request_key = ?',
        )
        .get(userId, request.intentionalRerun.requestKey) as
        | { podId: string; executionId: string; requestHash: string }
        | undefined;
      if (!row) return null;
      if (row.requestHash !== dispatchRequestHash(request))
        throw new AutopodError(
          'Rerun request key already records a different request',
          'RERUN_REQUEST_CONFLICT',
          409,
        );
      const current = get(row.podId);
      if (current.executionId !== row.executionId)
        throw new AutopodError(
          'Prior rerun execution no longer available; reconcile the existing decision',
          'RERUN_REQUEST_CONFLICT',
          409,
        );
      return row.podId;
    },
    registerRerun(podId, request, userId, requestHash) {
      if (
        !request.requestKey ||
        request.requestKey.length > 128 ||
        !/^[a-f0-9]{64}$/.test(requestHash) ||
        !request.reason.trim() ||
        request.reason.length > 4000 ||
        !userId ||
        request.ofPodId === podId
      )
        throw new AutopodError(
          'Intentional rerun requires a prior pod and a human reason',
          'INVALID_RERUN',
          400,
        );
      const pod = get(podId);
      const source = get(request.ofPodId);
      if (pod.linkedPodId || pod.taskId === source.taskId || hash(pod) !== hash(source))
        throw new AutopodError(
          'Intentional rerun must preserve the referenced request and have a distinct logical execution',
          'INVALID_RERUN',
          409,
        );
      db.prepare(`INSERT INTO execution_rerun_intents(execution_id,pod_id,source_pod_id,source_execution_id,source_repository,source_base_branch,work_hash,reason,user_id,request_key,request_hash,actor,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        pod.executionId,
        podId,
        source.id,
        source.executionId,
        requestRepository(source),
        source.baseBranch,
        hash(pod),
        request.reason.trim(),
        userId,
        request.requestKey,
        requestHash,
        JSON.stringify({ type: 'human', userId }),
        new Date().toISOString(),
      );
    },
    inspect: db.transaction(
      (
        podId: string,
        generation: number,
        rawRepository: string,
        baseBranch: string,
        baseCommitSha: string,
      ) => {
        const pod = get(podId);
        if (pod.generation !== generation)
          throw new AutopodError('Stale dispatch lifecycle', 'DISPATCH_IDENTITY_UNAVAILABLE', 409);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommitSha))
          throw new AutopodError(
            'Fresh base SHA unavailable',
            'DISPATCH_IDENTITY_UNAVAILABLE',
            409,
          );
        const repository = repositoryIdentity(rawRepository);
        if (requestRepository(pod) !== repository || pod.baseBranch !== baseBranch)
          throw new AutopodError(
            'Queued repository or base binding changed; reconcile before dispatch',
            'DISPATCH_BINDING_CHANGED',
            409,
          );
        const workHash = hash(pod);
        const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
        const conflicts = new Map<string, DispatchPreflightEvidence['conflicts'][number]>();
        const previous = db
          .prepare(`SELECT d.pod_id AS podId,d.execution_id AS executionId,p.status,d.checked_at AS checkedAt
        FROM execution_dispatch_preflights d LEFT JOIN task_executions e ON e.execution_id = d.execution_id LEFT JOIN pods p ON p.id = e.pod_id
        WHERE d.repository = ? AND d.base_branch = ? AND d.work_hash = ? AND d.task_id <> ? AND d.status = 'admitted'
        AND (d.checked_at >= ? OR p.status NOT IN ('complete','failed','killed','rejected')) GROUP BY d.execution_id ORDER BY MAX(d.checked_at) DESC LIMIT 101`)
          .all(repository, baseBranch, workHash, pod.taskId, cutoff) as Array<{
          podId: string;
          executionId: string;
          status: string | null;
          checkedAt: string;
        }>;
        if (previous.length > 100)
          throw new AutopodError(
            'Equivalent work scope exceeds 100 receipts; reconcile prior executions',
            'DISPATCH_SCOPE_TOO_LARGE',
            409,
          );
        for (const prior of previous)
          conflicts.set(prior.executionId, {
            podId: prior.podId,
            executionId: prior.executionId,
            status: prior.status ?? 'deleted',
            evidence: 'dispatch_receipt',
          });
        // Older queued/historical requests may predate this ledger. Match exact task
        // text, then canonical contract, using bounded projections; no semantic guess.
        const legacy = db
          .prepare(`${selectRequest} WHERE p.rowid < ? AND e.task_id <> ? AND p.task = ?
        AND NOT EXISTS (SELECT 1 FROM execution_dispatch_preflights d WHERE d.execution_id = e.execution_id)
        AND (p.created_at >= ? OR p.status NOT IN ('complete','failed','killed','rejected')) ORDER BY p.rowid DESC LIMIT 101`)
          .all(pod.rowNumber, pod.taskId, pod.task, cutoff) as RequestRow[];
        if (legacy.length > 100)
          throw new AutopodError(
            'Equivalent work scope exceeds 100 legacy requests; reconcile prior executions',
            'DISPATCH_SCOPE_TOO_LARGE',
            409,
          );
        for (const prior of legacy) {
          if (conflicts.has(prior.executionId) || hash(prior) !== workHash) continue;
          if (!prior.baseBranch)
            throw new AutopodError(
              'Historical base binding unavailable; reconcile before dispatch',
              'DISPATCH_IDENTITY_UNAVAILABLE',
              409,
            );
          if (prior.baseBranch !== baseBranch) continue;
          const priorRepository = requestRepository(prior);
          if (priorRepository === repository)
            conflicts.set(prior.executionId, {
              podId: prior.id,
              executionId: prior.executionId,
              status: prior.status,
              evidence: 'legacy_request',
            });
        }
        const intent = db
          .prepare('SELECT * FROM execution_rerun_intents WHERE execution_id = ?')
          .get(pod.executionId) as Record<string, unknown> | undefined;
        if (
          intent &&
          (intent.source_repository !== repository || intent.source_base_branch !== baseBranch)
        )
          throw new AutopodError(
            'Intentional rerun targets a different repository or base; reconcile the request',
            'INVALID_RERUN',
            409,
          );
        const rerun: DispatchPreflightEvidence['rerun'] = intent
          ? {
              ofPodId: intent.source_pod_id as string,
              requestKey: intent.request_key as string,
              reason: intent.reason as string,
              actor: JSON.parse(intent.actor as string),
              recordedAt: intent.recorded_at as string,
            }
          : null;
        const authorized =
          intent?.work_hash === workHash && conflicts.has(intent.source_execution_id as string);
        const status = conflicts.size === 0 || authorized ? 'admitted' : 'review_required';
        const id = randomUUID();
        db.prepare(`INSERT INTO execution_dispatch_preflights(id,execution_id,task_id,pod_id,generation,version,repository,base_branch,base_commit_sha,work_hash,status,conflicts,rerun_intent,checked_at)
        VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(
          id,
          pod.executionId,
          pod.taskId,
          podId,
          generation,
          repository,
          baseBranch,
          baseCommitSha,
          workHash,
          status,
          JSON.stringify([...conflicts.values()]),
          rerun ? JSON.stringify(rerun) : null,
          new Date().toISOString(),
        );
        return decode(
          db.prepare('SELECT * FROM execution_dispatch_preflights WHERE id = ?').get(id) as Record<
            string,
            unknown
          >,
        );
      },
    ),
    latest(podId) {
      const row = db
        .prepare(
          'SELECT d.* FROM execution_dispatch_preflights d JOIN task_executions e ON e.execution_id = d.execution_id WHERE e.pod_id = ? ORDER BY d.rowid DESC LIMIT 1',
        )
        .get(podId) as Record<string, unknown> | undefined;
      return row ? decode(row) : null;
    },
  };
}
