import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { claudeStateDirForPod } from '../runtimes/claude-state-store.js';
import type { PodRepository } from './pod-repository.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function refuse(message: string): never {
  throw new AutopodError(message, 'CLAUDE_TELEMETRY_BLOCKED', 409);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Invalid native record');
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) refuse('Invalid native token count');
  return value as number;
}

/** Exact session only, no prompt/tool content leaves this parser. Thinking is already in output. */
export function parseClaudeSession(
  source: string,
  sessionId: string,
  model: string,
  window: { startedAt: string; endedAt: string },
) {
  const calls = new Map<string, { request: string; usage: number[] }>();
  const requests = new Map<string, string>();
  let final: Record<string, unknown> | null = null;
  let lastType: unknown;
  const start = Date.parse(window.startedAt);
  const end = Date.parse(window.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    refuse('Invalid segment window');
  const lines = source.trimEnd().split('\n');
  if (lines.length > 200_000) refuse('Native session exceeds row limit');
  for (const line of lines) {
    if (!line || Buffer.byteLength(line) > 2 * 1024 * 1024)
      refuse('Invalid or oversized native row');
    let row: Record<string, unknown>;
    try {
      row = object(JSON.parse(line));
    } catch {
      refuse('Malformed native session row');
    }
    if (row.sessionId !== undefined && row.sessionId !== sessionId)
      refuse('Session identity mismatch');
    lastType = row.type;
    if (row.type === 'assistant') {
      const message = object(row.message);
      if (row.sessionId !== sessionId || message.model !== model || final)
        refuse('Ambiguous assistant identity/order');
      const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end)
        refuse('Usage outside settled segment');
      if (
        typeof message.id !== 'string' ||
        !message.id ||
        typeof row.requestId !== 'string' ||
        !row.requestId
      )
        refuse('Missing native API response identity');
      const u = object(message.usage);
      const usage = [
        'input_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
        'output_tokens',
      ].map((key) => count(u[key]));
      const prior = calls.get(message.id);
      if (prior && (prior.request !== row.requestId || hash(prior.usage) !== hash(usage)))
        refuse('Conflicting duplicate native response');
      if (requests.has(row.requestId) && requests.get(row.requestId) !== message.id)
        refuse('Ambiguous native request identity');
      calls.set(message.id, { request: row.requestId, usage });
      requests.set(row.requestId, message.id);
    }
    if (row.type === 'cost-state') {
      if (final || row.sessionId !== sessionId || row.hasUnknownModelCost !== false)
        refuse('Missing or ambiguous native final cost state');
      final = row;
    }
  }
  if (!calls.size || !final || lastType !== 'cost-state')
    refuse('Complete native final cost state required');
  const models = object(final.modelUsage);
  if (Object.keys(models).length !== 1 || !models[model]) refuse('Ambiguous native model totals');
  const totals = [0, 0, 0, 0];
  for (const call of calls.values())
    for (let i = 0; i < 4; i++) totals[i] = count(totals[i]! + call.usage[i]!);
  const aggregate = object(models[model]);
  const keys = ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens'];
  if (keys.some((key, i) => count(aggregate[key]) !== totals[i]))
    refuse('Native per-call/final totals disagree');
  const cost = final.totalCostUSD;
  if (
    typeof cost !== 'number' ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    typeof aggregate.costUSD !== 'number' ||
    Math.abs(aggregate.costUSD - cost) > 1e-9
  )
    refuse('Native cost totals disagree');
  return {
    inputTokens: count(totals[0]! + totals[1]! + totals[2]!),
    outputTokens: totals[3]!,
    directInputTokens: totals[0]!,
    cachedInputTokens: totals[1]!,
    cacheCreationTokens: totals[2]!,
    costUsd: cost,
    apiResponses: calls.size,
    rows: lines.length,
    costBasis: 'native_session_estimate' as const,
    billingVerified: false as const,
  };
}

async function sessionBytes(podId: string, sessionId: string) {
  const root = claudeStateDirForPod(podId);
  const canonical = await realpath(root);
  if (canonical !== path.resolve(root) || !(await lstat(root)).isDirectory())
    refuse('Linked native state root refused');
  const matches: string[] = [];
  const dirs = await readdir(root, { withFileTypes: true });
  if (dirs.length > 1000) refuse('Native project inventory exceeds limit');
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const candidate = path.join(root, dir.name, `${sessionId}.jsonl`);
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) refuse('Linked native session refused');
      matches.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (matches.length !== 1) refuse('One exact durable native session file required');
  const file = matches[0]!;
  if ((await realpath(file)) !== file) refuse('Native session path changed');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 32 * 1024 * 1024)
      refuse('Native session exceeds byte limit');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    if (current.dev !== after.dev || current.ino !== after.ino || !current.isFile())
      refuse('Native session file identity changed');
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (await realpath(file)) !== file
    )
      refuse('Native session changed during observation');
    const data = bytes.subarray(0, length);
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(data),
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: length,
    };
  } finally {
    await handle.close();
  }
}

export interface ClaudeTelemetryPrincipal {
  oid: string;
  roles: readonly string[];
}

export function createClaudeSessionTelemetry(deps: {
  db: Database.Database;
  podRepo: PodRepository;
  providerAttemptRepo: ProviderAttemptRepository;
  getContainerManager?: () => ContainerManager;
}) {
  function authorize(podId: string, principal: ClaudeTelemetryPrincipal) {
    if (!principal.oid?.trim())
      throw new AutopodError('Authenticated pod owner or operator required', 'FORBIDDEN', 403);
    const pod = deps.podRepo.getOrThrow(podId);
    if (
      pod.userId !== principal.oid &&
      !principal.roles.includes('admin') &&
      !principal.roles.includes('operator')
    )
      throw new AutopodError('Pod owner or admin/operator role required', 'FORBIDDEN', 403);
    return pod;
  }
  const publicReceipt = (receipt: Record<string, unknown>) => ({
    version: receipt.version,
    podId: receipt.podId,
    expectedBinding: receipt.expectedBinding,
    reason: receipt.reason,
    userId: receipt.userId,
    authorizationBasis: receipt.authorizationBasis,
    observedAt: receipt.observedAt,
    generation: receipt.generation,
    taskId: receipt.taskId,
    session: receipt.session,
    usage: receipt.usage,
  });
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AutopodError(
                  'Docker telemetry observation timed out',
                  'CLAUDE_TELEMETRY_BLOCKED',
                  409,
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const stored = (podId: string) => {
    const row = deps.db
      .prepare('SELECT receipt FROM claude_session_telemetry_receipts WHERE pod_id=?')
      .get(podId) as { receipt: string } | undefined;
    return row ? (JSON.parse(row.receipt) as Record<string, unknown>) : null;
  };
  function binding(podId: string, principal: ClaudeTelemetryPrincipal) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(podId)) refuse('Invalid pod identity');
    const pod = authorize(podId, principal);
    if (
      pod.status !== 'failed' ||
      pod.executionTarget !== 'local' ||
      pod.runtime !== 'claude' ||
      !pod.claudeSessionId ||
      !/^[a-f0-9-]{36}$/.test(pod.claudeSessionId) ||
      !pod.launchConfigDigest
    )
      refuse('Frozen failed local Claude task required');
    deps.podRepo.taskExecutions?.assertCanDelete(podId);
    deps.podRepo.validationExecutions?.assertNoActiveTaskExecution(podId);
    deps.podRepo.sourceAdoptions?.assertControlPlaneSettled(podId);
    deps.podRepo.retainedCheckpoints?.assertAvailable(podId);
    deps.podRepo.retainedFinalizations?.assertAvailable(podId);
    deps.podRepo.deletionOwnership?.assertTaskAvailable(podId);
    if (deps.podRepo.validationExecutions?.unsettled(podId))
      refuse('Validation ownership remains unresolved');
    if (
      !deps.podRepo.taskExecutions ||
      !deps.podRepo.validationExecutions ||
      !deps.podRepo.sourceAdoptions
    )
      refuse('Ownership ledgers unavailable');
    const attempts = deps.providerAttemptRepo.listRaw(podId);
    const runs = deps.db
      .prepare('SELECT * FROM task_agent_runs WHERE pod_id=?')
      .all(podId) as Array<{
      id: string;
      generation: number;
      ended_at: string | null;
      binding: string;
    }>;
    const attempt = attempts[0];
    const run = runs[0];
    if (
      attempts.length !== 1 ||
      runs.length !== 1 ||
      !attempt ||
      !run ||
      !run.ended_at ||
      run.generation !== pod.lifecycleGeneration ||
      attempt.runtime !== 'claude' ||
      attempt.model !== pod.model ||
      attempt.nativeSessionId !== pod.claudeSessionId ||
      pod.inputTokens ||
      pod.outputTokens ||
      pod.costUsd ||
      pod.tokenTelemetryAccuracy !== 'partial' ||
      attempt.endedAt ||
      attempt.outcome ||
      attempt.inputTokens ||
      attempt.outputTokens ||
      attempt.costUsd
    )
      refuse('Exactly one settled worker and untouched open zero-usage provider segment required');
    const custody = deps.db
      .prepare('SELECT request_key,binding,receipt FROM stalled_worker_recoveries WHERE pod_id=?')
      .all(podId) as Array<{ request_key: string; binding: string; receipt: string }>;
    if (custody.length !== 1) refuse('One settled Docker retention receipt required');
    const held = custody[0]!;
    const receipt = object(JSON.parse(held.receipt));
    const proof = object(JSON.parse(held.binding));
    const heldRun = object(proof.run);
    const workerBinding = object(JSON.parse(run.binding));
    if (
      receipt.state !== 'settled' ||
      heldRun.id !== run.id ||
      heldRun.binding !== run.binding ||
      heldRun.generation !== pod.lifecycleGeneration ||
      object(workerBinding.resource).containerId !== pod.containerId ||
      workerBinding.model !== attempt.model ||
      workerBinding.runtime !== 'claude' ||
      workerBinding.providerAccountId !== attempt.providerAccountId
    )
      refuse('Settled resource/session ownership mismatch');
    if (
      deps.db
        .prepare('SELECT 1 FROM provider_attempt_telemetry_corrections WHERE pod_id=?')
        .get(podId)
    )
      refuse('Existing correction requires separate reconciliation');
    return {
      generation: pod.lifecycleGeneration,
      sessionId: pod.claudeSessionId,
      containerId: pod.containerId,
      taskId: deps.podRepo.taskExecutions.snapshot(podId).taskId,
      launchDigest: pod.launchConfigDigest,
      originalPod: {
        userId: pod.userId,
        inputTokens: pod.inputTokens,
        outputTokens: pod.outputTokens,
        costUsd: pod.costUsd,
        accuracy: pod.tokenTelemetryAccuracy,
      },
      attempt,
      run,
      custody: held,
      resourceKey: proof.resourceKey,
    };
  }
  async function observe(podId: string, principal: ClaudeTelemetryPrincipal) {
    const before = binding(podId, principal);
    const cm = deps.getContainerManager?.() ?? refuse('Provider observation unavailable');
    const assertStopped = async () => {
      if (
        !before.containerId ||
        !cm.getResourceKey ||
        (await bounded(cm.getResourceKey(before.containerId))) !== before.resourceKey ||
        (await bounded(cm.getStatus(before.containerId))) !== 'stopped'
      )
        refuse('Exact stopped Docker identity required');
    };
    await assertStopped();
    const source = await sessionBytes(podId, before.sessionId);
    const usage = parseClaudeSession(source.text, before.sessionId, before.attempt.model, {
      startedAt: before.attempt.startedAt,
      endedAt: before.run.ended_at!,
    });
    await assertStopped();
    const after = binding(podId, principal);
    if (hash(before) !== hash(after)) refuse('Accounting ownership changed during observation');
    const evidence = { ...before, session: { sha256: source.sha256, bytes: source.bytes }, usage };
    return { expectedBinding: hash(evidence), evidence };
  }
  return {
    async inspect(podId: string, principal: ClaudeTelemetryPrincipal) {
      authorize(podId, principal);
      const receipt = stored(podId);
      if (receipt) return { mode: 'recorded' as const, receipt: publicReceipt(receipt) };
      const result = await observe(podId, principal);
      // Private snapshots are retained only on apply, never returned to the client.
      return {
        mode: 'preview' as const,
        expectedBinding: result.expectedBinding,
        session: result.evidence.session,
        usage: result.evidence.usage,
        generation: result.evidence.generation,
        taskId: result.evidence.taskId,
      };
    },
    async apply(
      podId: string,
      request: { expectedBinding: string; reason: string },
      principal: ClaudeTelemetryPrincipal,
    ) {
      authorize(podId, principal);
      const userId = principal.oid;
      const prior = stored(podId);
      if (prior) {
        if (
          prior.expectedBinding !== request.expectedBinding ||
          prior.userId !== userId ||
          prior.reason !== request.reason
        )
          refuse('Conflicting telemetry reconciliation request');
        return publicReceipt(prior);
      }
      const observed = await observe(podId, principal);
      if (observed.expectedBinding !== request.expectedBinding)
        refuse('Stale native telemetry preview');
      return deps.db.transaction(() => {
        if (
          hash(binding(podId, principal)) !==
          hash({ ...observed.evidence, session: undefined, usage: undefined })
        )
          refuse('Accounting ownership changed before apply');
        const evidence = observed.evidence;
        const receipt = {
          version: 1,
          podId,
          expectedBinding: request.expectedBinding,
          reason: request.reason,
          userId,
          authorizationBasis:
            evidence.originalPod.userId === userId ? 'pod_owner' : 'admin_or_operator',
          observedAt: new Date().toISOString(),
          ...evidence,
        };
        deps.db
          .prepare(`INSERT INTO claude_session_telemetry_receipts
          (pod_id,ordinal,input_tokens,output_tokens,cost_usd,binding_hash,receipt) VALUES(?,?,?,?,?,?,?)`)
          .run(
            podId,
            evidence.attempt.ordinal,
            evidence.usage.inputTokens,
            evidence.usage.outputTokens,
            evidence.usage.costUsd,
            request.expectedBinding,
            JSON.stringify(receipt),
          );
        // The stopped segment is aborted, not retroactively completed. Original raw evidence is in the receipt.
        deps.providerAttemptRepo.close(podId, {
          expectedOrdinal: evidence.attempt.ordinal,
          nativeSessionId: evidence.sessionId,
          endedAt: evidence.run.ended_at!,
          outcome: 'aborted',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
        deps.db
          .prepare(
            `UPDATE pods SET input_tokens=?,output_tokens=?,cost_usd=?,token_telemetry_accuracy='repaired' WHERE id=?`,
          )
          .run(
            evidence.usage.inputTokens,
            evidence.usage.outputTokens,
            evidence.usage.costUsd,
            podId,
          );
        return publicReceipt(receipt);
      })();
    },
  };
}
