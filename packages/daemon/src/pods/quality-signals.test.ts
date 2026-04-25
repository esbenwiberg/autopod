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

function validateInBrowserCall(output: string): AgentActivityEvent {
  const event: AgentToolUseEvent = {
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    tool: 'validate_in_browser',
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
  let podRepo: PodRepository;
  let eventRepo: EventRepository;
  let escalationRepo: EscalationRepository;
  let deps: {
    podRepo: PodRepository;
    eventRepo: EventRepository;
    escalationRepo: EscalationRepository;
  };

  beforeEach(() => {
    const db = createTestDb();
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

  it('counts reads and edits, marks green when the ratio is healthy', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(readTool('src/b.ts'));
    eventRepo.insert(readTool('src/c.ts'));
    eventRepo.insert(readTool('src/d.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.readCount).toBe(4);
    expect(signals.editCount).toBe(1);
    expect(signals.readEditRatio).toBe(4);
    expect(signals.editsWithoutPriorRead).toBe(0);
    expect(signals.grade).toBe('green');
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

  it('adds one interrupt when the pod ended killed', () => {
    podRepo.insert(basePod({ status: 'killed' }));
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.userInterrupts).toBe(1);
  });

  it('marks red when the read:edit ratio is below 1', () => {
    podRepo.insert(basePod());
    eventRepo.insert(readTool('src/a.ts'));
    eventRepo.insert(fileChange('src/a.ts', 'modify'));
    eventRepo.insert(fileChange('src/b.ts', 'create'));
    eventRepo.insert(fileChange('src/c.ts', 'create'));

    const signals = computeQualitySignals(POD_ID, deps);

    expect(signals.readEditRatio).toBeLessThan(1);
    expect(signals.grade).toBe('red');
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

  describe('userInterrupts (widened)', () => {
    it('counts each human-attention escalation type', () => {
      podRepo.insert(basePod());
      escalationRepo.insert(escalation('e1', 'ask_human'));
      escalationRepo.insert(escalation('e2', 'report_blocker'));
      escalationRepo.insert(escalation('e3', 'request_credential'));
      escalationRepo.insert(escalation('e4', 'action_approval'));
      escalationRepo.insert(escalation('e5', 'validation_override'));

      const signals = computeQualitySignals(POD_ID, deps);

      expect(signals.userInterrupts).toBe(5);
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
  });

  describe('validationPassed (multi-run reduction)', () => {
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

    it('returns true when at least one of multiple runs passed', () => {
      podRepo.insert(basePod());
      validationRepo.insert(POD_ID, 1, validationResult('fail'));
      validationRepo.insert(POD_ID, 2, validationResult('fail'));
      validationRepo.insert(POD_ID, 3, validationResult('pass'));

      const signals = computeQualitySignals(POD_ID, depsWithValidation);

      expect(signals.validationPassed).toBe(true);
    });

    it('returns false when all runs failed', () => {
      podRepo.insert(basePod());
      validationRepo.insert(POD_ID, 1, validationResult('fail'));
      validationRepo.insert(POD_ID, 2, validationResult('fail'));

      const signals = computeQualitySignals(POD_ID, depsWithValidation);

      expect(signals.validationPassed).toBe(false);
    });
  });
});
