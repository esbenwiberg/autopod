import type {
  AgentActivityEvent,
  AgentFileChangeEvent,
  AgentToolUseEvent,
  EscalationRequest,
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
});
