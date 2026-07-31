import { type Dirent, createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalModelKey, computeCostWithCache } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { PodRepository } from './pod-repository.js';
import type {
  ProviderAttemptRepository,
  ProviderAttemptTelemetryCorrection,
} from './provider-attempt-repository.js';

interface RawUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface AttemptUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface TokenTelemetryRepairEntry {
  podId: string;
  status: 'repaired' | 'partial' | 'skipped';
  reason: string;
  corrections: number;
  originalInputTokens: number;
  originalOutputTokens: number;
  originalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface TokenTelemetryRepairReport {
  mode: 'dry-run' | 'apply';
  startedAt: string;
  completedAt: string;
  repairedPods: number;
  partialPods: number;
  skippedPods: number;
  entries: TokenTelemetryRepairEntry[];
}

export interface TokenTelemetryRepairDeps {
  db: Database.Database;
  podRepo: PodRepository;
  providerAttemptRepo: ProviderAttemptRepository;
  stateRoot?: string;
  now?: () => Date;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usageRecord(value: unknown): RawUsage | null {
  const candidate = record(value);
  if (!candidate) return null;
  const values = [candidate.input_tokens, candidate.cached_input_tokens, candidate.output_tokens];
  const numeric = values.filter((item): item is number => typeof item === 'number');
  if (
    numeric.length === 0 ||
    numeric.some((item) => !Number.isFinite(item) || item < 0 || !Number.isInteger(item))
  ) {
    return null;
  }
  return {
    input_tokens: typeof candidate.input_tokens === 'number' ? candidate.input_tokens : undefined,
    cached_input_tokens:
      typeof candidate.cached_input_tokens === 'number' ? candidate.cached_input_tokens : undefined,
    output_tokens:
      typeof candidate.output_tokens === 'number' ? candidate.output_tokens : undefined,
  };
}

async function rolloutFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(child);
    }
  }
  await walk(root);
  return found.sort();
}

function timestampOf(envelope: Record<string, unknown>): string | null {
  return typeof envelope.timestamp === 'string' && !Number.isNaN(Date.parse(envelope.timestamp))
    ? envelope.timestamp
    : null;
}

function attemptForTimestamp<T extends { startedAt: string; endedAt: string | null }>(
  attempts: T[],
  timestamp: string,
): T | null {
  const at = Date.parse(timestamp);
  const matches = attempts.filter((attempt) => {
    const start = Date.parse(attempt.startedAt);
    const end = attempt.endedAt ? Date.parse(attempt.endedAt) : Number.POSITIVE_INFINITY;
    return at >= start && at <= end;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

async function reconstructLegacyCodexPod(
  podId: string,
  model: string,
  stateRoot: string,
): Promise<
  | { status: 'ok'; totals: { inputTokens: number; outputTokens: number; costUsd: number } }
  | { status: 'partial'; reason: string }
> {
  if (!canonicalModelKey(model)) {
    return { status: 'partial', reason: `unknown pricing model ${model}` };
  }
  const files = await rolloutFiles(path.join(stateRoot, podId));
  if (files.length === 0) return { status: 'partial', reason: 'no durable Codex rollout files' };
  const usage: AttemptUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const seen = new Set<string>();
  let ambiguous = 0;
  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      let envelope: Record<string, unknown>;
      try {
        const parsed = record(JSON.parse(line));
        if (!parsed) continue;
        envelope = parsed;
      } catch {
        continue;
      }
      const payload = record(envelope.payload) ?? record(envelope.msg) ?? envelope;
      if (payload.type !== 'token_count') continue;
      const last = usageRecord(record(payload.info)?.last_token_usage);
      const timestamp = timestampOf(envelope);
      if (!last || !timestamp) {
        ambiguous += 1;
        continue;
      }
      const key = JSON.stringify({ timestamp, id: envelope.id ?? null, usage: last });
      if (seen.has(key)) continue;
      seen.add(key);
      usage.inputTokens += last.input_tokens ?? 0;
      usage.cachedInputTokens += last.cached_input_tokens ?? 0;
      usage.outputTokens += last.output_tokens ?? 0;
    }
  }
  if (ambiguous > 0) {
    return { status: 'partial', reason: `${ambiguous} rollout usage record(s) were ambiguous` };
  }
  if (seen.size === 0) {
    return { status: 'partial', reason: 'rollouts contain no per-call usage' };
  }
  return {
    status: 'ok',
    totals: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: computeCostWithCache(
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cachedInputTokens,
      ),
    },
  };
}

async function reconstructPod(
  podId: string,
  attempts: ReturnType<ProviderAttemptRepository['listRaw']>,
  stateRoot: string,
): Promise<
  | { status: 'ok'; corrections: ProviderAttemptTelemetryCorrection[] }
  | { status: 'partial' | 'skipped'; reason: string }
> {
  const codexAttempts = attempts.filter((attempt) => attempt.runtime === 'codex');
  if (codexAttempts.length === 0) return { status: 'skipped', reason: 'no Codex attempts' };
  const unknownModel = codexAttempts.find((attempt) => !canonicalModelKey(attempt.model));
  if (unknownModel) {
    return { status: 'partial', reason: `unknown pricing model ${unknownModel.model}` };
  }

  const files = await rolloutFiles(path.join(stateRoot, podId));
  if (files.length === 0) return { status: 'partial', reason: 'no durable Codex rollout files' };

  const byOrdinal = new Map<number, AttemptUsage>();
  const seen = new Set<string>();
  let ambiguous = 0;

  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(file),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      let envelope: Record<string, unknown>;
      try {
        const parsed = record(JSON.parse(line));
        if (!parsed) continue;
        envelope = parsed;
      } catch {
        continue;
      }
      const payload = record(envelope.payload) ?? record(envelope.msg) ?? envelope;
      if (payload.type !== 'token_count') continue;
      const info = record(payload.info);
      const usage = usageRecord(info?.last_token_usage);
      const timestamp = timestampOf(envelope);
      if (!usage || !timestamp) {
        ambiguous += 1;
        continue;
      }
      const attempt = attemptForTimestamp(codexAttempts, timestamp);
      if (!attempt) {
        ambiguous += 1;
        continue;
      }
      const key = JSON.stringify({ timestamp, id: envelope.id ?? null, usage });
      if (seen.has(key)) continue;
      seen.add(key);
      const total = byOrdinal.get(attempt.ordinal) ?? {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
      total.inputTokens += usage.input_tokens ?? 0;
      total.cachedInputTokens += usage.cached_input_tokens ?? 0;
      total.outputTokens += usage.output_tokens ?? 0;
      byOrdinal.set(attempt.ordinal, total);
    }
  }

  if (ambiguous > 0) {
    return { status: 'partial', reason: `${ambiguous} rollout usage record(s) were ambiguous` };
  }
  const requiredAttempts = codexAttempts.filter(
    (attempt) =>
      attempt.outcome === 'completed' ||
      attempt.inputTokens > 0 ||
      attempt.outputTokens > 0 ||
      attempt.costUsd > 0,
  );
  if (requiredAttempts.some((attempt) => !byOrdinal.has(attempt.ordinal))) {
    return { status: 'partial', reason: 'one or more Codex attempts lack per-call rollout usage' };
  }
  if (byOrdinal.size === 0) {
    return { status: 'partial', reason: 'rollouts contain no per-call usage' };
  }

  return {
    status: 'ok',
    corrections: codexAttempts.flatMap((attempt) => {
      const usage = byOrdinal.get(attempt.ordinal);
      if (!usage) return [];
      return [
        {
          podId,
          ordinal: attempt.ordinal,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: computeCostWithCache(
            attempt.model,
            usage.inputTokens,
            usage.outputTokens,
            usage.cachedInputTokens,
          ),
          source: 'codex_rollout' as const,
          reason: 'Reconstructed from deduplicated per-call last_token_usage rollout evidence',
        },
      ];
    }),
  };
}

export interface TokenTelemetryRepair {
  run(options?: { apply?: boolean }): Promise<TokenTelemetryRepairReport>;
}

export function createTokenTelemetryRepair(deps: TokenTelemetryRepairDeps): TokenTelemetryRepair {
  const now = deps.now ?? (() => new Date());
  const stateRoot =
    deps.stateRoot ??
    process.env.AUTOPOD_CODEX_STATE_DIR ??
    path.join(os.homedir(), '.autopod', 'codex-state');

  return {
    async run(options = {}) {
      const mode = options.apply ? 'apply' : 'dry-run';
      const startedAt = now().toISOString();
      const entries: TokenTelemetryRepairEntry[] = [];
      const planned = new Map<
        string,
        {
          corrections: ProviderAttemptTelemetryCorrection[];
          accuracy: 'partial' | 'repaired';
          totals?: { inputTokens: number; outputTokens: number; costUsd: number };
        }
      >();

      for (const pod of deps.podRepo.list()) {
        const original = {
          originalInputTokens: pod.inputTokens,
          originalOutputTokens: pod.outputTokens,
          originalCostUsd: pod.costUsd,
        };
        if (pod.tokenTelemetryAccuracy === 'complete') {
          entries.push({
            podId: pod.id,
            status: 'skipped',
            reason: 'telemetry is already complete',
            corrections: 0,
            ...original,
          });
          continue;
        }
        if (pod.tokenTelemetryAccuracy === 'repaired') {
          entries.push({
            podId: pod.id,
            status: 'skipped',
            reason: 'telemetry was already repaired',
            corrections: 0,
            ...original,
          });
          continue;
        }
        const rawAttempts = deps.providerAttemptRepo.listRaw(pod.id);
        const hasCodex = rawAttempts.some((attempt) => attempt.runtime === 'codex');
        const hasHistoricalClaude =
          pod.tokenTelemetryAccuracy === 'partial' &&
          (pod.runtime === 'claude' ||
            rawAttempts.some(
              (attempt) =>
                attempt.runtime === 'claude' &&
                (attempt.inputTokens > 0 || attempt.outputTokens > 0 || attempt.costUsd > 0),
            ));
        if (!hasCodex && pod.runtime === 'codex') {
          const legacy = await reconstructLegacyCodexPod(pod.id, pod.model, stateRoot);
          if (legacy.status !== 'ok') {
            entries.push({
              podId: pod.id,
              status: 'partial',
              reason: legacy.reason,
              corrections: 0,
              ...original,
            });
            continue;
          }
          planned.set(pod.id, {
            corrections: [],
            accuracy: 'repaired',
            totals: legacy.totals,
          });
          entries.push({
            podId: pod.id,
            status: 'repaired',
            reason: 'legacy pod reconstructed from complete rollout evidence',
            corrections: 0,
            ...original,
            ...legacy.totals,
          });
          continue;
        }
        if (!hasCodex) {
          entries.push(
            hasHistoricalClaude
              ? {
                  podId: pod.id,
                  status: 'partial',
                  reason: 'historical Claude cache usage was not persisted; native cost preserved',
                  corrections: 0,
                  ...original,
                }
              : {
                  podId: pod.id,
                  status: 'skipped',
                  reason: 'no recoverable Codex or incomplete Claude telemetry',
                  corrections: 0,
                  ...original,
                },
          );
          continue;
        }
        const result = await reconstructPod(pod.id, rawAttempts, stateRoot);
        if (result.status !== 'ok') {
          entries.push({
            podId: pod.id,
            status: result.status,
            reason: result.reason,
            corrections: 0,
            ...original,
          });
          continue;
        }
        const accuracy = hasHistoricalClaude ? 'partial' : 'repaired';
        planned.set(pod.id, { corrections: result.corrections, accuracy });
        const correctedByOrdinal = new Map(result.corrections.map((item) => [item.ordinal, item]));
        const effective = rawAttempts.map(
          (attempt) => correctedByOrdinal.get(attempt.ordinal) ?? attempt,
        );
        const totals = effective.reduce(
          (sum, attempt) => ({
            inputTokens: sum.inputTokens + attempt.inputTokens,
            outputTokens: sum.outputTokens + attempt.outputTokens,
            costUsd: sum.costUsd + attempt.costUsd,
          }),
          { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        );
        entries.push({
          podId: pod.id,
          status: accuracy === 'repaired' ? 'repaired' : 'partial',
          reason:
            accuracy === 'repaired'
              ? 'complete rollout evidence reconstructed'
              : 'Codex usage repaired; historical Claude cache usage remains partial',
          corrections: result.corrections.length,
          ...original,
          ...totals,
        });
      }

      if (options.apply) {
        deps.db.transaction(() => {
          for (const [podId, plan] of planned) {
            for (const correction of plan.corrections) {
              deps.providerAttemptRepo.upsertTelemetryCorrection(correction);
            }
            const totals = plan.totals ?? deps.providerAttemptRepo.totals(podId);
            deps.db
              .prepare(
                `UPDATE pods SET input_tokens = ?, output_tokens = ?, cost_usd = ?,
                   token_telemetry_accuracy = ?
                 WHERE id = ?`,
              )
              .run(totals.inputTokens, totals.outputTokens, totals.costUsd, plan.accuracy, podId);
          }
        })();
      }

      const completedAt = now().toISOString();
      const report: TokenTelemetryRepairReport = {
        mode,
        startedAt,
        completedAt,
        repairedPods: entries.filter((entry) => entry.status === 'repaired').length,
        partialPods: entries.filter((entry) => entry.status === 'partial').length,
        skippedPods: entries.filter((entry) => entry.status === 'skipped').length,
        entries,
      };
      deps.db
        .prepare(
          `INSERT INTO token_telemetry_repair_runs (
             mode, started_at, completed_at, repaired_pods, partial_pods, skipped_pods, report_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mode,
          startedAt,
          completedAt,
          report.repairedPods,
          report.partialPods,
          report.skippedPods,
          JSON.stringify(report),
        );
      return report;
    },
  };
}
