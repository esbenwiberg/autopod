import type { AgentActivityEvent, AgentFileChangeEvent, AgentToolUseEvent } from '@autopod/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { type NewPod, createPodRepository } from './pod-repository.js';
import { createQualityScoreRecorder } from './quality-score-recorder.js';
import { createQualityScoreRepository } from './quality-score-repository.js';

const POD_ID = 'pod-rec-01';

function basePod(overrides: Partial<NewPod> = {}): NewPod {
  return {
    id: POD_ID,
    profileName: 'test-profile',
    task: 'do the thing',
    status: 'complete',
    model: 'claude-opus-4-7',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'autopod/rec',
    userId: 'user-1',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    ...overrides,
  };
}

function readEvent(path: string): AgentActivityEvent {
  const event: AgentToolUseEvent = {
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    tool: 'Read',
    input: { file_path: path },
  };
  return { type: 'pod.agent_activity', timestamp: event.timestamp, podId: POD_ID, event };
}

function editEvent(path: string): AgentActivityEvent {
  const event: AgentFileChangeEvent = {
    type: 'file_change',
    timestamp: new Date().toISOString(),
    path,
    action: 'modify',
  };
  return { type: 'pod.agent_activity', timestamp: event.timestamp, podId: POD_ID, event };
}

describe('QualityScoreRecorder', () => {
  function setup() {
    const db = createTestDb();
    insertTestProfile(db);
    const podRepo = createPodRepository(db);
    const eventRepo = createEventRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const qualityScoreRepo = createQualityScoreRepository(db);
    const eventBus = createEventBus(eventRepo, logger);
    const recorder = createQualityScoreRecorder({
      eventBus,
      podRepo,
      eventRepo,
      escalationRepo,
      qualityScoreRepo,
      logger,
    });
    return { db, podRepo, eventRepo, eventBus, qualityScoreRepo, recorder };
  }

  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('writes a score row on pod.completed', () => {
    ctx.podRepo.insert(basePod());
    ctx.podRepo.update(POD_ID, { inputTokens: 1200, outputTokens: 300, costUsd: 0.05 });
    ctx.eventRepo.insert(readEvent('src/a.ts'));
    ctx.eventRepo.insert(readEvent('src/b.ts'));
    ctx.eventRepo.insert(readEvent('src/c.ts'));
    ctx.eventRepo.insert(editEvent('src/a.ts'));

    ctx.recorder.start();
    ctx.eventBus.emit({
      type: 'pod.completed',
      timestamp: '2026-04-23T12:00:00.000Z',
      podId: POD_ID,
      finalStatus: 'complete',
      summary: {
        id: POD_ID,
        profileName: 'test-profile',
        task: 'do the thing',
        status: 'complete',
        model: 'claude-opus-4-7',
        runtime: 'claude',
        duration: 1000,
        filesChanged: 1,
        createdAt: '2026-04-23T11:50:00.000Z',
      },
    });

    const persisted = ctx.qualityScoreRepo.get(POD_ID);
    expect(persisted).not.toBeNull();
    expect(persisted?.finalStatus).toBe('complete');
    expect(persisted?.model).toBe('claude-opus-4-7');
    expect(persisted?.runtime).toBe('claude');
    expect(persisted?.inputTokens).toBe(1200);
    expect(persisted?.outputTokens).toBe(300);
    expect(persisted?.costUsd).toBe(0.05);
    // 3 reads / 1 edit = 3.0 ratio, no blind edits, no interrupts, completed
    // reading 30*clamp(3/5)=18, blind 20, tells 20, interrupts 15, complete 10, churn 10 = 93
    expect(persisted?.score).toBe(93);
  });

  it('records killed pods with the completion bonus missing', () => {
    ctx.podRepo.insert(basePod({ status: 'killed' }));
    ctx.eventRepo.insert(readEvent('src/a.ts'));

    ctx.recorder.start();
    ctx.eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'killed',
      summary: {
        id: POD_ID,
        profileName: 'test-profile',
        task: 'do the thing',
        status: 'killed',
        model: 'claude-opus-4-7',
        runtime: 'claude',
        duration: 0,
        filesChanged: 0,
        createdAt: new Date().toISOString(),
      },
    });

    const persisted = ctx.qualityScoreRepo.get(POD_ID);
    expect(persisted?.finalStatus).toBe('killed');
    // zero edits → reading 30 (short-circuit); 1 kill → userInterrupts=1 → interruptScore=15*(1-1/3)=10
    // 30 + 20 (blind) + 20 (tells) + 10 (interrupts) + 0 (killed) + 10 (churn) = 90
    expect(persisted?.score).toBe(90);
  });

  it('unsubscribes on stop()', () => {
    ctx.podRepo.insert(basePod());
    ctx.recorder.start();
    ctx.recorder.stop();

    ctx.eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: {
        id: POD_ID,
        profileName: 'test-profile',
        task: 'do the thing',
        status: 'complete',
        model: 'claude-opus-4-7',
        runtime: 'claude',
        duration: 0,
        filesChanged: 0,
        createdAt: new Date().toISOString(),
      },
    });

    expect(ctx.qualityScoreRepo.get(POD_ID)).toBeNull();
  });

  it('swallows recorder-side errors — insert failure does not propagate', () => {
    ctx.podRepo.insert(basePod());

    // Force the repo's insert to blow up. The emit path should stay intact
    // (notification service, WebSocket broadcast, etc. must not be starved).
    const originalInsert = ctx.qualityScoreRepo.insert;
    ctx.qualityScoreRepo.insert = () => {
      throw new Error('disk full');
    };

    ctx.recorder.start();
    expect(() =>
      ctx.eventBus.emit({
        type: 'pod.completed',
        timestamp: new Date().toISOString(),
        podId: POD_ID,
        finalStatus: 'complete',
        summary: {
          id: POD_ID,
          profileName: 'test-profile',
          task: '',
          status: 'complete',
          model: 'claude-opus-4-7',
          runtime: 'claude',
          duration: 0,
          filesChanged: 0,
          createdAt: new Date().toISOString(),
        },
      }),
    ).not.toThrow();

    ctx.qualityScoreRepo.insert = originalInsert;
  });
});
