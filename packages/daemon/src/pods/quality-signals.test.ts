import type {
  AgentActivityEvent,
  AgentCompleteEvent,
  AgentFileChangeEvent,
  AgentTaskSummaryEvent,
  AgentToolUseEvent,
  EscalationRequest,
  EscalationType,
  ValidationResult,
} from '@autopod/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
import type { EscalationRepository } from './escalation-repository.js';
import { createEventRepository } from './event-repository.js';
import type { EventRepository } from './event-repository.js';
import { type NewPod, createPodRepository } from './pod-repository.js';
import type { PodRepository } from './pod-repository.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createQualityScoreRepository } from './quality-score-repository.js';
import { isQualityScoreEligible } from './quality-score.js';
import { computeQualitySignals } from './quality-signals.js';
import { createValidationRepository } from './validation-repository.js';
import type { ValidationRepository } from './validation-repository.js';

const POD_ID = 'pod-quality-01';

function basePod(overrides: Partial<NewPod> = {}): NewPod {
  return {
    id: POD_ID,
    profileName: 'test-profile',
    task: 'do the thing',
    status: 'complete',
    model: 'opus',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'autopod/quality',
    userId: 'user-1',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    ...overrides,
  };
}

function readTool(path: string): AgentActivityEvent {
  const event: AgentToolUseEvent = {
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    tool: 'Read',
    input: { file_path: path },
  };
  return {
    type: 'pod.agent_activity',
    timestamp: event.timestamp,
    podId: POD_ID,
    event,
  };
}

function toolUse(
  tool: string,
  input: Record<string, unknown>,
  output?: string,
): AgentActivityEvent {
  const event: AgentToolUseEvent = {
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    tool,
    input,
    ...(output !== undefined && { output }),
  };
  return {
    type: 'pod.agent_activity',
    timestamp: event.timestamp,
    podId: POD_ID,
    event,
  };
}

function fileChange(path: string, action: 'create' | 'modify' | 'delete'): AgentActivityEvent {
  const event: AgentFileChangeEvent = {
    type: 'file_change',
    timestamp: new Date().toISOString(),
    path,
    action,
  };
  return {
    type: 'pod.agent_activity',
    timestamp: event.timestamp,
    podId: POD_ID,
    event,
  };
}

function askHuman(id: string): EscalationRequest {
  return {
    id,
    podId: POD_ID,
    type: 'ask_human',
    timestamp: new Date().toISOString(),
    payload: { question: 'stuck' },
    response: null,
  };
}

function escalation(id: string, type: EscalationType): EscalationRequest {
  // Minimal payloads — `computeQualitySignals` only counts rows by type, the
  // payload contents aren't read.
  const payloadByType: Record<EscalationType, EscalationRequest['payload']> = {
    ask_human: { question: 'stuck' },
    ask_ai: { question: 'design choice' },
    report_blocker: { description: 'blocked', attempted: [], needs: 'help' },
    action_approval: { actionName: 'do_thing', params: {}, description: 'do it' },
    validation_override: { findings: [], attempt: 1, maxAttempts: 3 },
    request_credential: { service: 'github', reason: 'private repo' },
  };
  return {
    id,
    podId: POD_ID,
    type,
    timestamp: new Date().toISOString(),
    payload: payloadByType[type],
    response: null,
  };
}

function validateInBrowserCall(output: string, tool = 'validate_in_browser'): AgentActivityEvent {
  const event: AgentToolUseEvent = {
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    tool,
    input: { url: 'http://localhost:3000', checks: ['something'] },
    output,
  };
  return {
    type: 'pod.agent_activity',
    timestamp: event.timestamp,
    podId: POD_ID,
    event,
  };
}

function validationResult(overall: 'pass' | 'fail'): ValidationResult {
  return {
    podId: POD_ID,
    attempt: 1,
    timestamp: new Date().toISOString(),
    smoke: {
      status: overall,
      build: { status: overall, output: '', duration: 0 },
      health: { status: overall, url: '', responseCode: 200, duration: 0 },
      pages: [],
    },
    taskReview: null,
    overall,
    duration: 0,
  };
}

describe('computeQualitySignals', () => {
  let db: ReturnType<typeof createTestDb>;
  let podRepo: PodRepository;
  let eventRepo: EventRepository;
  let escalationRepo: EscalationRepository;
  let deps: {
    podRepo: PodRepository;
    eventRepo: EventRepository;
    escalationRepo: EscalationRepository;
  };

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
    podRepo = createPodRepository(db);
    eventRepo = createEventRepository(db);
    escalationRepo = createEscalationRepository(db);
    deps = { podRepo, eventRepo, escalationRepo };
  });

  it('returns green with zero edits (research-only pod)', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(readTool('src/b.ts'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.readCount).toBe(2);
    expect(signals.editCount).toBe(0);
    expect(signals.editsWithoutPriorRead).toBe(0);
    expect(signals.grade).toBe('green');
  });

  it('provider-attempt uses summed accounting and latest immutable quality projection', () => {
    podRepo.insert(basePod({ runtime: 'codex', model: 'mutable-projection' }));
    const providerAttemptRepo = createProviderAttemptRepository(db);
    providerAttemptRepo.open({
      podId: POD_ID,
      provider: 'max',
      providerAccountId: null,
      runtime: 'claude',
      model: 'claude-opus-4-7',
      profileReference: `pod:${POD_ID}@profile-snapshot#abcdef1`,
      profileSnapshot: {},
    });
    providerAttemptRepo.close(POD_ID, {
      outcome: 'quota_exhausted',
      classification: {
        category: 'quota_exhausted',
        definitive: true,
        sanitizedMessage: 'Provider limit reached',
      },
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 1.25,
    });
    providerAttemptRepo.open({
      podId: POD_ID,
      provider: 'openai',
      providerAccountId: null,
      runtime: 'codex',
      model: 'gpt-5.6-terra',
      profileReference: `pod:${POD_ID}@profile-snapshot#abcdef1`,
      profileSnapshot: {},
    });
    providerAttemptRepo.close(POD_ID, {
      outcome: 'completed',
      inputTokens: 200,
      outputTokens: 40,
      costUsd: 0.75,
    });

    const qualityScoreRepo = createQualityScoreRepository(db);
    db.prepare(`
      INSERT INTO pod_quality_scores (
        pod_id, score, runtime, profile_name, model, final_status, completed_at,
        input_tokens, output_tokens, cost_usd, algorithm_version, inspection_availability,
        score_v3
      ) VALUES (
        ?, 90, 'claude', 'test-profile', 'stale-model', 'complete', ?, 999, 999, 99,
        3, 'available', 90
      )
    `).run(POD_ID, new Date().toISOString());

    const signals = computeQualitySignals(POD_ID, {
      ...deps,
      providerAttemptRepo,
      qualityScoreRepo,
    });

    expect(signals.tokens).toEqual({ input: 300, output: 60, costUsd: 2 });
    expect(signals.score).toBe(90);
    expect(signals.model).toBe('gpt-5.6-terra');
  });

  it('provider-attempt preserves legacy quality accounting without ledger rows', () => {
    podRepo.insert(basePod());
    podRepo.update(POD_ID, { inputTokens: 12, outputTokens: 3, costUsd: 0.5 });

    const signals = computeQualitySignals(POD_ID, {
      ...deps,
      providerAttemptRepo: createProviderAttemptRepository(db),
    });

    expect(signals.tokens).toEqual({ input: 12, output: 3, costUsd: 0.5 });
    expect(signals.model).toBe('opus');
  });

  it('counts reads and edits, marks green when the ratio is healthy', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(readTool('src/b.ts'));
    eventRepo.insert(readTool('src/c.ts'));
    eventRepo.insert(readTool('src/d.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.readCount).toBe(4);
    expect(signals.inspectionAvailability).toBe('available');
    expect(signals.editCount).toBe(1);
    expect(signals.readEditRatio).toBe(4);
    expect(signals.editsWithoutPriorRead).toBe(0);
    expect(signals.grade).toBe('green');
  });

  it('uses canonical Codex inspection evidence before an edit', () => {
    podRepo.insert(basePod({ runtime: 'codex' }));
    eventRepo.insert(toolUse('Bash', { command: 'sed -n 1,80p ./src/a.ts' }));
    eventRepo.insert(fileChange('/workspace/src/a.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.inspectionAvailability).toBe('available');
    expect(signals.readCount).toBe(1);
    expect(signals.editCount).toBe(1);
    expect(signals.editsWithoutPriorRead).toBe(0);
  });

  it('runtime quality availability matrix', () => {
    podRepo.insert(basePod({ runtime: 'claude' }));
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    const claudeSignals = computeQualitySignals(POD_ID, deps);
    expect(claudeSignals).toMatchObject({
      inspectionAvailability: 'available',
      readCount: 1,
      editsWithoutPriorRead: 0,
    });

    db.close();
    db = createTestDb();
    insertTestProfile(db);
    podRepo = createPodRepository(db);
    eventRepo = createEventRepository(db);
    escalationRepo = createEscalationRepository(db);
    deps = { podRepo, eventRepo, escalationRepo };
    podRepo.insert(basePod({ runtime: 'pi' }));
    eventRepo.insert(toolUse('read', { path: 'src/a.ts' }));
    eventRepo.insert(toolUse('edit', { path: 'src/a.ts', call_id: 'edit-1' }));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    const piSignals = computeQualitySignals(POD_ID, deps);
    expect(piSignals).toMatchObject({
      inspectionAvailability: 'available',
      readCount: 1,
      editCount: 1,
      editsWithoutPriorRead: 0,
    });
    expect(
      isQualityScoreEligible({
        signals: piSignals,
        hasPiAttempt: true,
        hasNonPiAttempt: true,
      }),
    ).toBe(false);
    expect(
      isQualityScoreEligible({
        signals: piSignals,
        hasPiAttempt: true,
        hasNonPiAttempt: false,
        historical: true,
      }),
    ).toBe(false);

    db.close();
    db = createTestDb();
    insertTestProfile(db);
    podRepo = createPodRepository(db);
    eventRepo = createEventRepository(db);
    escalationRepo = createEscalationRepository(db);
    deps = { podRepo, eventRepo, escalationRepo };
    podRepo.insert(basePod({ runtime: 'pi' }));
    eventRepo.insert(toolUse('write', { path: 'src/a.ts' }));
    expect(computeQualitySignals(POD_ID, deps)).toMatchObject({
      inspectionAvailability: 'unavailable',
      inspectionUnavailableReason: 'unresolved_write',
      readCount: null,
    });

    db.close();
    db = createTestDb();
    insertTestProfile(db);
    podRepo = createPodRepository(db);
    eventRepo = createEventRepository(db);
    escalationRepo = createEscalationRepository(db);
    deps = { podRepo, eventRepo, escalationRepo };
    podRepo.insert(basePod({ runtime: 'copilot' }));
    expect(computeQualitySignals(POD_ID, deps)).toMatchObject({
      inspectionAvailability: 'unavailable',
      inspectionUnavailableReason: 'no_activity',
      readCount: null,
    });
  });

  it('marks ambiguous shell inspection unavailable even without a mutation', () => {
    podRepo.insert(basePod({ runtime: 'codex' }));
    eventRepo.insert(toolUse('Bash', { command: 'cat src/a.ts | wc -l' }));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.inspectionAvailability).toBe('unavailable');
    expect(signals.inspectionUnavailableReason).toBe('ambiguous_inspection');
    expect(signals.ambiguousInspectionCount).toBe(1);
    expect(signals.readCount).toBeNull();
  });

  it('counts repeated modifications to one unread file as one blind edit', () => {
    podRepo.insert(basePod({ runtime: 'codex' }));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    eventRepo.insert(fileChange('./src/a.ts', 'modify'));
    eventRepo.insert(fileChange('/workspace/src/a.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.inspectionAvailability).toBe('available');
    expect(signals.editCount).toBe(3);
    expect(signals.editsWithoutPriorRead).toBe(1);
  });

  it('marks ambiguous native writes as unavailable instead of measured zero', () => {
    podRepo.insert(basePod({ runtime: 'pi' }));
    eventRepo.insert(toolUse('write', { path: 'src/a.ts' }));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.inspectionAvailability).toBe('unavailable');
    expect(signals.editCount).toBe(1);
    expect(signals.readCount).toBeNull();
    expect(signals.readEditRatio).toBeNull();
    expect(signals.editsWithoutPriorRead).toBeNull();
    expect(signals.grade).toBe('green');
  });

  it('counts paired native and file-change mutations once', () => {
    podRepo.insert(basePod({ runtime: 'pi' }));
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(toolUse('edit', { path: 'src/a.ts', call_id: 'edit-1' }));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.inspectionAvailability).toBe('available');
    expect(signals.editCount).toBe(1);
    expect(signals.readEditRatio).toBe(1);
    expect(signals.editsWithoutPriorRead).toBe(0);
  });

  it('does not collapse distinct native mutations to the same path', () => {
    podRepo.insert(basePod({ runtime: 'pi' }));
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(toolUse('edit', { path: 'src/a.ts', call_id: 'edit-1' }));
    eventRepo.insert(toolUse('edit', { path: 'src/a.ts', call_id: 'edit-2' }));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.editCount).toBe(2);
  });

  it('does not pair a later native mutation with an earlier file change', () => {
    podRepo.insert(basePod({ runtime: 'pi' }));
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    eventRepo.insert(toolUse('edit', { path: 'src/a.ts', call_id: 'edit-2' }));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.editCount).toBe(2);
  });

  it('uses a paired file-change action to resolve a native write', () => {
    podRepo.insert(basePod({ runtime: 'pi' }));
    eventRepo.insert(toolUse('write', { path: 'src/new.ts', call_id: 'write-1' }));
    eventRepo.insert(fileChange('src/new.ts', 'create'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.inspectionAvailability).toBe('available');
    expect(signals.editCount).toBe(1);
    expect(signals.editsWithoutPriorRead).toBe(0);
  });

  it('flags edits to files that were never read', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify')); // ok — read first
    eventRepo.insert(fileChange('src/b.ts', 'modify')); // blind edit
    eventRepo.insert(fileChange('src/c.ts', 'modify')); // blind edit
    eventRepo.insert(fileChange('src/d.ts', 'modify')); // blind edit → red

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.editsWithoutPriorRead).toBe(3);
    expect(signals.grade).toBe('red');
  });

  it('does not penalise create actions as blind edits', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/existing.ts'));
    eventRepo.insert(fileChange('src/new.ts', 'create'));
    eventRepo.insert(fileChange('src/existing.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.editCount).toBe(2);
    expect(signals.editsWithoutPriorRead).toBe(0);
  });

  it('counts ask_human escalations toward user interrupts', () => {
    podRepo.insert(basePod());
    escalationRepo.insert(askHuman('esc-1'));
    escalationRepo.insert(askHuman('esc-2'));
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.userInterrupts).toBe(2);
    expect(signals.grade).toBe('yellow');
  });

  it('does not treat killed state as a process interruption', () => {
    podRepo.insert(basePod({ status: 'killed' }));
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.userInterrupts).toBe(0);
  });

  it('low read:edit contributes to the composite process grade', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    eventRepo.insert(fileChange('src/b.ts', 'create'));
    eventRepo.insert(fileChange('src/c.ts', 'create'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.readEditRatio).toBeLessThan(1);
    expect(signals.grade).toBe('yellow');
  });

  it('pulls token usage from the pod row', () => {
    podRepo.insert(basePod());
    podRepo.update(POD_ID, { inputTokens: 1000, outputTokens: 500, costUsd: 0.12 });

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.tokens).toEqual({ input: 1000, output: 500, costUsd: 0.12 });
  });

  it('detects edit churn when the same file is modified 3+ times', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    eventRepo.insert(fileChange('src/a.ts', 'modify')); // 3rd modify → churn

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.editChurnCount).toBe(1);
  });

  it('does not count churn below the threshold', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    eventRepo.insert(fileChange('src/a.ts', 'modify')); // only 2 — no churn

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.editChurnCount).toBe(0);
  });

  it('detects tell patterns in task summary text', () => {
    podRepo.insert(basePod());
    const summary: AgentTaskSummaryEvent = {
      type: 'task_summary',
      timestamp: new Date().toISOString(),
      actualSummary: 'Unfortunately I was unable to complete the migration.',
      deviations: [],
    };
    const activity: AgentActivityEvent = {
      type: 'pod.agent_activity',
      timestamp: summary.timestamp,
      podId: POD_ID,
      event: summary,
    };
    eventRepo.insert(activity);

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.tellsCount).toBeGreaterThan(0);
  });

  it('does not detect tells in tool output', () => {
    podRepo.insert(basePod());
    eventRepo.insert(
      toolUse(
        'Bash',
        { command: 'cat src/a.ts' },
        'Unfortunately I was unable to complete this operation.',
      ),
    );

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.tellsCount).toBe(0);
  });

  it('detects tell patterns in complete event result text', () => {
    podRepo.insert(basePod());
    const complete: AgentCompleteEvent = {
      type: 'complete',
      timestamp: new Date().toISOString(),
      result: 'I apologize — there is no viable path forward with the current config.',
    };
    const activity: AgentActivityEvent = {
      type: 'pod.agent_activity',
      timestamp: complete.timestamp,
      podId: POD_ID,
      event: complete,
    };
    eventRepo.insert(activity);

    const signals = computeQualitySignals(POD_ID, deps);

    // "I apologize" and "no viable path forward" both match — counts distinct patterns
    expect(signals.tellsCount).toBeGreaterThanOrEqual(2);
  });

  it('exposes prFixAttempts from the pod row', () => {
    podRepo.insert(basePod());
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.prFixAttempts).toBe(2);
  });

  describe('userInterrupts (human attention only)', () => {
    it('excludes autonomous credential vending', () => {
      podRepo.insert(basePod());
      escalationRepo.insert(escalation('e1', 'ask_human'));
      escalationRepo.insert(escalation('e2', 'report_blocker'));
      escalationRepo.insert(escalation('e3', 'request_credential'));
      escalationRepo.insert(escalation('e4', 'action_approval'));
      escalationRepo.insert(escalation('e5', 'validation_override'));

      const signals = computeQualitySignals(POD_ID, deps);

      expect(signals.userInterrupts).toBe(4);
    });

    it('does not count ask_ai (agent-to-agent, no human in the loop)', () => {
      podRepo.insert(basePod());
      escalationRepo.insert(escalation('e1', 'ask_ai'));
      escalationRepo.insert(escalation('e2', 'ask_human'));

      const signals = computeQualitySignals(POD_ID, deps);

      expect(signals.userInterrupts).toBe(1);
    });
  });

  describe('browserChecks', () => {
    it('returns null when no validate_in_browser calls happened', () => {
      podRepo.insert(basePod());
      eventRepo.insert(readTool('src/a.ts'));

      const signals = computeQualitySignals(POD_ID, deps);

      expect(signals.browserChecks).toBeNull();
    });

    it('aggregates calls and pass/fail across multiple invocations', () => {
      podRepo.insert(basePod());
      // Run 1: 2 of 2 pass
      eventRepo.insert(
        validateInBrowserCall(
          JSON.stringify({
            passed: true,
            results: [
              { check: 'a', passed: true },
              { check: 'b', passed: true },
            ],
          }),
        ),
      );
      // Run 2: 1 of 3 pass
      eventRepo.insert(
        validateInBrowserCall(
          JSON.stringify({
            passed: false,
            results: [
              { check: 'a', passed: true },
              { check: 'b', passed: false },
              { check: 'c', passed: false },
            ],
          }),
        ),
      );
      // Run 3: 0 of 1 pass
      eventRepo.insert(
        validateInBrowserCall(
          JSON.stringify({
            passed: false,
            results: [{ check: 'a', passed: false }],
          }),
        ),
      );

      const signals = computeQualitySignals(POD_ID, deps);

      expect(signals.browserChecks).toEqual({
        calls: 3,
        totalChecks: 6,
        passedChecks: 3,
      });
    });

    it('counts the call but not checks when output is malformed JSON', () => {
      podRepo.insert(basePod());
      eventRepo.insert(validateInBrowserCall('Error: connection refused'));

      const signals = computeQualitySignals(POD_ID, deps);

      expect(signals.browserChecks).toEqual({
        calls: 1,
        totalChecks: 0,
        passedChecks: 0,
      });
    });

    it('recognizes Codex server-qualified MCP validate_in_browser events', () => {
      podRepo.insert(basePod());
      eventRepo.insert(
        validateInBrowserCall(
          JSON.stringify({ passed: true, results: [{ check: 'a', passed: true }] }),
          'mcp__escalation__validate_in_browser',
        ),
      );

      const signals = computeQualitySignals(POD_ID, deps);

      expect(signals.browserChecks).toEqual({
        calls: 1,
        totalChecks: 1,
        passedChecks: 1,
      });
    });
  });

  describe('validationPassed (latest attempt)', () => {
    let validationRepo: ValidationRepository;
    let depsWithValidation: typeof deps & { validationRepo: ValidationRepository };

    beforeEach(() => {
      const db = createTestDb();
      insertTestProfile(db);
      podRepo = createPodRepository(db);
      eventRepo = createEventRepository(db);
      escalationRepo = createEscalationRepository(db);
      validationRepo = createValidationRepository(db);
      depsWithValidation = { podRepo, eventRepo, escalationRepo, validationRepo };
    });

    it('returns null when no validation rows exist', () => {
      podRepo.insert(basePod());

      const signals = computeQualitySignals(POD_ID, depsWithValidation);

      expect(signals.validationPassed).toBeNull();
    });

    it('returns true when the latest run passed', () => {
      podRepo.insert(basePod());
      validationRepo.insert(POD_ID, 1, validationResult('fail'));
      validationRepo.insert(POD_ID, 2, validationResult('fail'));
      validationRepo.insert(POD_ID, 3, validationResult('pass'));

      const signals = computeQualitySignals(POD_ID, depsWithValidation);

      expect(signals.validationPassed).toBe(true);
    });

    it('latest-validation-is-reported', () => {
      podRepo.insert(basePod());
      validationRepo.insert(POD_ID, 1, validationResult('pass'));
      validationRepo.insert(POD_ID, 2, validationResult('fail'));

      const signals = computeQualitySignals(POD_ID, depsWithValidation);

      expect(signals.validationPassed).toBe(false);
    });
  });
});
