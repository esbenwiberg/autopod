import { createHash, randomUUID } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { CreatePrConfig, CreatePrResult } from '../interfaces/pr-manager.js';

export interface DeliveryIntent {
  id: string;
  state: 'reserved' | 'creating' | 'uncertain' | 'delivered';
  generation: number;
}
export interface DeliveryLedger {
  reserve(config: CreatePrConfig): DeliveryIntent;
  claim(intent: DeliveryIntent): boolean;
  uncertain(id: string): void;
  result(id: string): CreatePrResult | null;
  observe(url: string, disposition: 'open' | 'merged' | 'closed'): void;
  record(
    id: string,
    result: CreatePrResult,
    evidence: 'create_response' | 'provider_lookup',
    disposition: 'open' | 'merged' | 'closed',
  ): CreatePrResult;
}

/** Repository identity is credential-free; branch/base matching is exact and case sensitive. */
function repositoryIdentity(config: CreatePrConfig): string {
  const raw = config.repoUrl ?? config.profile.repoUrl;
  if (!raw)
    throw new AutopodError(
      'Delivery repository identity is unavailable',
      'DELIVERY_RECONCILIATION_REQUIRED',
      409,
    );
  const ssh = raw.match(/^git@([^:]+):(.+)$/);
  const url = new URL(ssh ? `https://${ssh[1]}/${ssh[2]}` : raw);
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol))
    throw new Error('Unsupported delivery repository identity');
  return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`;
}

export function createDeliveryLedger(db: Database.Database): DeliveryLedger {
  const result = (id: string): CreatePrResult | null => {
    const row = db.prepare('SELECT result FROM delivery_receipts WHERE intent_id = ?').get(id) as
      | { result: string }
      | undefined;
    return row ? (JSON.parse(row.result) as CreatePrResult) : null;
  };
  return {
    reserve: db.transaction((config: CreatePrConfig) => {
      const repository = repositoryIdentity(config);
      const identity = createHash('sha256')
        .update(JSON.stringify([repository, config.branch, config.baseBranch]))
        .digest('hex');
      const existing = db
        .prepare('SELECT id, state, generation FROM delivery_intents WHERE identity = ?')
        .get(identity) as DeliveryIntent | undefined;
      if (existing) return existing;
      const pod = db
        .prepare(
          'SELECT p.lifecycle_generation AS generation, e.task_id AS taskId FROM pods p JOIN task_executions e ON e.pod_id = p.id WHERE p.id = ?',
        )
        .get(config.podId) as { generation: number; taskId: string } | undefined;
      if (!pod)
        throw new AutopodError(
          'Delivery task identity is unavailable',
          'DELIVERY_RECONCILIATION_REQUIRED',
          409,
        );
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO delivery_intents (id, identity, pod_id, task_id, generation, repository, branch, base_branch, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
      ).run(
        id,
        identity,
        config.podId,
        pod.taskId,
        pod.generation,
        repository,
        config.branch,
        config.baseBranch,
        now,
        now,
      );
      return { id, state: 'reserved' as const, generation: pod.generation };
    }),
    claim(intent) {
      return (
        db
          .prepare(
            `UPDATE delivery_intents SET state = 'creating', updated_at = ? WHERE id = ? AND state = 'reserved' AND generation = (SELECT lifecycle_generation FROM pods WHERE id = delivery_intents.pod_id) AND (SELECT pending_escalation FROM pods WHERE id = delivery_intents.pod_id) IS NULL AND (SELECT status FROM pods WHERE id = delivery_intents.pod_id) NOT IN ('awaiting_input', 'killing', 'killed')`,
          )
          .run(new Date().toISOString(), intent.id).changes === 1
      );
    },
    uncertain(id) {
      db.prepare(
        "UPDATE delivery_intents SET state = 'uncertain', updated_at = ? WHERE id = ? AND state = 'creating'",
      ).run(new Date().toISOString(), id);
    },
    result,
    observe: db.transaction((url, disposition) => {
      const receipt = db
        .prepare('SELECT id, disposition FROM delivery_receipts WHERE pr_url = ?')
        .get(url) as { id: string; disposition: string } | undefined;
      if (!receipt) return; // Do not invent a creation receipt for a legacy URL.
      const last = db
        .prepare(
          'SELECT disposition FROM delivery_observations WHERE receipt_id = ? ORDER BY sequence DESC LIMIT 1',
        )
        .get(receipt.id) as { disposition: string } | undefined;
      if ((last?.disposition ?? receipt.disposition) === disposition) return;
      db.prepare(
        'INSERT INTO delivery_observations (receipt_id, disposition, observed_at) VALUES (?, ?, ?)',
      ).run(receipt.id, disposition, new Date().toISOString());
    }),
    record: db.transaction((id, value, evidence, disposition) => {
      const previous = result(id);
      if (previous) {
        if (previous.url !== value.url) throw new Error('Delivery already has a different receipt');
        return previous;
      }
      const url = new URL(value.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid delivery URL');
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO delivery_receipts (id, intent_id, pr_url, evidence, disposition, result, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(randomUUID(), id, value.url, evidence, disposition, JSON.stringify(value), now);
      db.prepare(
        "UPDATE delivery_intents SET state = 'delivered', updated_at = ? WHERE id = ?",
      ).run(now, id);
      return value;
    }),
  };
}
