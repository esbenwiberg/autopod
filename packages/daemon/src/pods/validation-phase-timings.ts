import type { ValidationPhase, ValidationPhaseStartedEvent } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from '../configuration/configuration-digest.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import type { EventRepository } from './event-repository.js';

const SAMPLE_LIMIT = 7;

/** Detail-only hydration from the same ordered events that drive WebSocket clients. */
export function latestValidationPhase(
  pod: { id: string; status: string },
  events?: EventRepository,
) {
  const event = events
    ?.getForSession(pod.id, {
      types: [
        'pod.status_changed',
        'pod.validation_started',
        'pod.validation_completed',
        'pod.validation_phase_started',
        'pod.validation_phase_completed',
      ],
      latest: 1,
    })
    .at(-1);
  if (!event) return null;
  const payload = event.payload;
  return {
    eventId: event.id,
    active:
      payload.type === 'pod.validation_phase_started' &&
      (pod.status === 'validating' || (pod.status === 'validated' && payload.phase === 'advisory'))
        ? { phase: payload.phase, startedAt: payload.timestamp, estimate: payload.estimate }
        : null,
  };
}

export interface ValidationTimingContext {
  config: ValidationEngineConfig;
  profile: Pick<
    PodExecutionSettings,
    'name' | 'repoUrl' | 'template' | 'warmImageTag' | 'containerMemoryGb' | 'executionTarget'
  >;
}

export function validationPhaseTimingKey(
  { config, profile }: ValidationTimingContext,
  phase: ValidationPhase,
): string | undefined {
  // These checks have comparable configuration across pods. Facts and review
  // depend heavily on the task/diff; advisory QA depends on its generated scenarios.
  const commands: Partial<Record<ValidationPhase, string | null | undefined>> = {
    setup: config.validationSetupCommand,
    lint: config.lintCommand,
    sast: config.sastCommand,
    build: config.buildCommand,
    test: config.testCommand,
    health: config.hasWebUi !== false ? config.startCommand : null,
    pages: config.hasWebUi !== false && config.smokePages.length ? config.startCommand : null,
  };
  const command = commands[phase];
  if (!command?.trim()) return;
  return configurationDigest([
    phase,
    command,
    profile.name,
    profile.repoUrl,
    config.validationSuite ?? 'full',
    config.executionTarget ?? profile.executionTarget,
    profile.template,
    profile.warmImageTag,
    profile.containerMemoryGb,
    config.buildWorkDir ?? null,
    config.nonSecretExecEnv ?? null,
    phase === 'health' ? [config.healthPath, config.webProbeMode ?? null] : null,
    phase === 'pages' ? config.smokePages : null,
  ]);
}

export function createValidationPhaseTimings(db: Database.Database) {
  function recent(key: string): number[] {
    const row = db
      .prepare('SELECT durations_ms FROM validation_phase_timings WHERE timing_key = ?')
      .get(key) as { durations_ms: string } | undefined;
    return row ? (JSON.parse(row.durations_ms) as number[]) : [];
  }

  return {
    estimate(key: string): ValidationPhaseStartedEvent['estimate'] {
      const durations = recent(key).sort((a, b) => a - b);
      const count = durations.length;
      const middle = Math.floor(count / 2);
      const upper = durations[middle];
      if (upper === undefined) return;
      const durationMs =
        count % 2 ? upper : Math.round(((durations[middle - 1] ?? upper) + upper) / 2);
      return { durationMs, sampleCount: count };
    },
    record(key: string, durationMs: number) {
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return;
      const durations = [...recent(key), durationMs].slice(-SAMPLE_LIMIT);
      db.prepare(`INSERT INTO validation_phase_timings (timing_key, durations_ms) VALUES (?, ?)
        ON CONFLICT (timing_key) DO UPDATE SET durations_ms = excluded.durations_ms`).run(
        key,
        JSON.stringify(durations),
      );
    },
  };
}
