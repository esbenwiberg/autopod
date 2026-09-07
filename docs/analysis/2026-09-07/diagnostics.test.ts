// Desired-behavior regressions converted from historical defect characterizations.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeModelsAnalytics } from '../../../packages/daemon/src/pods/models-aggregator.js';
import { createPodRepository } from '../../../packages/daemon/src/pods/pod-repository.js';
import { computeReliabilityAnalytics } from '../../../packages/daemon/src/pods/reliability-aggregator.js';
import { validateTransition } from '../../../packages/daemon/src/pods/state-machine.js';
import { classifyProviderError } from '../../../packages/daemon/src/runtimes/provider-error-classifier.js';
import {
  createTestDb,
  insertTestProfile,
} from '../../../packages/daemon/src/test-utils/mock-helpers.js';

describe('Durable execution contract: desired behavior', () => {
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
  });
  afterEach(() => db.close());
  function pod(id: string, status = 'complete') {
    db.prepare(`INSERT INTO pods
      (id, profile_name, task, status, model, runtime, branch, user_id,
       output_mode, agent_mode, output_target, validate, promotable, completed_at)
      VALUES (?, 'test-profile', 'diagnostic', ?, 'gpt-5.6-sol', 'codex',
       'diagnostic', 'test-user', 'pr', 'auto', 'pr', 1, 0, ?)`).run(
      id,
      status,
      new Date().toISOString(),
    );
  }
  it('excludes skipped SAST from executed coverage', () => {
    pod('skip');
    db.prepare(`INSERT INTO validations (id, pod_id, attempt, sequence, result)
      VALUES ('v', 'skip', 1, 1, ?)`).run(
      JSON.stringify({ overall: 'pass', sast: { status: 'skip' } }),
    );
    const actual = computeReliabilityAnalytics(db, 30).stageFailures.find(
      (x) => x.stage === 'sast',
    );
    expect(actual?.podsRan).toBe(0);
  });
  it('requires validation evidence for first-pass success', () => {
    pod('no-validation');
    expect(computeReliabilityAnalytics(db, 30).firstPassRate).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM validations').get()).toEqual({ n: 0 });
  });
  it('keeps attempts distinct from logical pods and delivered PRs', () => {
    pod('killed-pod', 'killed');
    for (const ordinal of [1, 2]) {
      db.prepare(`INSERT INTO provider_attempts
        (pod_id, ordinal, provider, runtime, model, profile_reference, profile_snapshot,
         started_at, ended_at, outcome, input_tokens, output_tokens, cost_usd)
        VALUES ('killed-pod', ?, 'openai', 'codex', 'gpt-5.6-sol', 'test', '{}',
         ?, ?, 'completed', 100, 10, 1)`).run(
        ordinal,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }
    const actual = computeModelsAnalytics(db, 30);
    expect(actual.summary.cohortSize).toBe(1);
    expect(actual.byModel[0]?.podCount).toBe(1);
    expect(actual.byModel[0]?.completeCount).toBe(0);
    expect(actual.byModel[0]?.dollarPerPr).toBeNull();
  });
  it('recognizes structured Claude overload as provider unavailability', () => {
    expect(
      classifyProviderError('claude', {
        status: 529,
        message:
          'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      }).category,
    ).toBe('provider_unavailable');
  });
  it('correctly refuses completion with unresolved human input', () => {
    expect(() => validateTransition('rolling-earthworm', 'awaiting_input', 'complete')).toThrow();
    // The fix belongs in finalization/escalation handling, not in weakening this guard.
  });
  it('preserves healthy history reads when a legacy row is malformed', () => {
    pod('good');
    pod('bad');
    db.prepare("UPDATE pods SET task_summary = 'not-json' WHERE id = 'bad'").run();
    const repo = createPodRepository(db);
    expect(repo.getOrThrow('good').id).toBe('good');
    expect(repo.listForDisplay?.().some((p) => p.id === 'good')).toBe(true);
    expect(repo.listForDisplay?.().find((p) => p.id === 'bad')?.recordDiagnostics).toEqual([
      { field: 'task_summary', code: 'invalid_json' },
    ]);
    expect(() => repo.getOrThrow('bad')).toThrow(); // Control-plane reads stay fail closed.
    // Potential mechanism for observed API errors; not a proven production root cause.
  });
});
