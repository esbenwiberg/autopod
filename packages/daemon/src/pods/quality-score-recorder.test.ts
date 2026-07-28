import type { AgentActivityEvent, AgentFileChangeEvent, AgentToolUseEvent } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { type NewPod, createPodRepository } from './pod-repository.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createQualityScoreRecorder } from './quality-score-recorder.js';
import { createQualityScoreRepository } from './quality-score-repository.js';
import { QUALITY_SCORE_ALGORITHM_VERSION } from './quality-score-repository.js';

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

function codexInspectionEvent(command: string): AgentActivityEvent {
  const event: AgentToolUseEvent = {
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    tool: 'Bash',
    input: { command },
  };
  return { type: 'pod.agent_activity', timestamp: event.timestamp, podId: POD_ID, event };
}

describe('QualityScoreRecorder', () => {
  function setup(onScorePersisted?: (podId: string) => void) {
    const db = createTestDb();
    insertTestProfile(db);
    const podRepo = createPodRepository(db);
    const eventRepo = createEventRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const qualityScoreRepo = createQualityScoreRepository(db);
    const providerAttemptRepo = createProviderAttemptRepository(db);
    const eventBus = createEventBus(eventRepo, logger);
    const recorder = createQualityScoreRecorder({
      eventBus,
      podRepo,
      eventRepo,
      escalationRepo,
      qualityScoreRepo,
      providerAttemptRepo,
      onScorePersisted,
      logger,
    });
    return { db, podRepo, eventRepo, eventBus, providerAttemptRepo, qualityScoreRepo, recorder };
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
    expect(persisted?.algorithmVersion).toBe(QUALITY_SCORE_ALGORITHM_VERSION);
    expect(persisted?.inspectionAvailability).toBe('available');
    // 3 reads / 1 edit = 3.0 ratio, no blind edits, no interrupts, completed
    // reading 30*clamp(3/5)=18, blind 20, tells 20, interrupts 15, complete 10, churn 10 = 93
    expect(persisted?.score).toBe(93);
  });

  it('refreshes readiness after the pod.completed score row is persisted', () => {
    const observedScores: Array<number | null | undefined> = [];
    ctx = setup((podId) => {
      observedScores.push(ctx.qualityScoreRepo.get(podId)?.score);
    });
    ctx.podRepo.insert(basePod());
    ctx.eventRepo.insert(readEvent('src/a.ts'));

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
        filesChanged: 0,
        createdAt: '2026-04-23T11:50:00.000Z',
      },
    });

    expect(observedScores).toEqual([100]);
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

  it('records unavailable inspection telemetry without exposing invented counters', () => {
    ctx.podRepo.insert(basePod({ runtime: 'pi' }));

    ctx.recorder.start();
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
        runtime: 'pi',
        duration: 0,
        filesChanged: 0,
        createdAt: new Date().toISOString(),
      },
    });

    const persisted = ctx.qualityScoreRepo.get(POD_ID);
    expect(persisted).not.toBeNull();
    expect(persisted?.score).toBeNull();
    expect(persisted?.algorithmVersion).toBe(QUALITY_SCORE_ALGORITHM_VERSION);
    expect(persisted?.inspectionAvailability).toBe('unavailable');
    expect(persisted?.readCount).toBeNull();
    expect(persisted?.readEditRatio).toBeNull();
    expect(persisted?.editsWithoutPriorRead).toBeNull();
  });

  it('records a live mixed Pi to Codex outcome unavailable when Pi activity is missing', () => {
    ctx.podRepo.insert(basePod({ runtime: 'codex', model: 'gpt-5' }));
    ctx.eventRepo.insert(codexInspectionEvent('cat src/a.ts'));
    ctx.eventRepo.insert(editEvent('src/a.ts'));
    ctx.eventRepo.insert({
      type: 'pod.agent_activity',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      event: {
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        tool: 'validate_in_browser',
        input: {},
      },
    });
    ctx.providerAttemptRepo.open({
      podId: POD_ID,
      provider: 'openrouter',
      providerAccountId: null,
      runtime: 'pi',
      model: 'pi-model',
      profileReference: `pod:${POD_ID}@profile-snapshot#abcdef1`,
      profileSnapshot: {},
    });
    ctx.providerAttemptRepo.close(POD_ID, {
      outcome: 'quota_exhausted',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });

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
        model: 'gpt-5',
        runtime: 'codex',
        duration: 1000,
        filesChanged: 1,
        createdAt: '2026-04-23T11:50:00.000Z',
      },
    });

    expect(ctx.qualityScoreRepo.get(POD_ID)).toEqual(
      expect.objectContaining({
        inspectionAvailability: 'unavailable',
        score: null,
        readCount: null,
      }),
    );
  });

  it('records a pure Pi outcome when normalized evidence is retained', () => {
    ctx.podRepo.insert(basePod({ runtime: 'pi', model: 'pi-model' }));
    ctx.eventRepo.insert({
      type: 'pod.agent_activity',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      event: {
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        tool: 'read',
        input: { path: 'src/a.ts' },
      },
    });
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
        model: 'pi-model',
        runtime: 'pi',
        duration: 1000,
        filesChanged: 1,
        createdAt: '2026-04-23T11:50:00.000Z',
      },
    });

    expect(ctx.qualityScoreRepo.get(POD_ID)).toEqual(
      expect.objectContaining({
        inspectionAvailability: 'available',
        readCount: 1,
        editsWithoutPriorRead: 0,
      }),
    );
  });

  it('rebuilds retained Codex history once with normalized inspection evidence', () => {
    ctx.podRepo.insert(basePod({ runtime: 'codex', model: 'gpt-5' }));
    ctx.eventRepo.insert(codexInspectionEvent('cat src/a.ts'));
    ctx.eventRepo.insert(editEvent('src/a.ts'));
    ctx.db
      .prepare(`
      INSERT INTO pod_quality_scores (
        pod_id, score, runtime, profile_name, model, final_status, completed_at
      ) VALUES (?, 40, 'codex', 'test-profile', 'gpt-5', 'complete', ?)
    `)
      .run(POD_ID, '2026-04-23T12:00:00.000Z');

    expect(ctx.recorder.upgradeHistory()).toEqual({
      selected: 1,
      upgraded: 1,
      lastPodId: POD_ID,
    });
    expect(ctx.qualityScoreRepo.get(POD_ID)).toEqual(
      expect.objectContaining({
        algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
        inspectionAvailability: 'available',
        readCount: 1,
        editCount: 1,
        readEditRatio: 1,
        editsWithoutPriorRead: 0,
      }),
    );
    expect(
      (
        ctx.db.prepare('SELECT score FROM pod_quality_scores WHERE pod_id = ?').get(POD_ID) as {
          score: number;
        }
      ).score,
    ).toBe(40);
    expect(ctx.recorder.upgradeHistory()).toEqual({
      selected: 0,
      upgraded: 0,
      lastPodId: null,
    });
  });

  it('refreshes readiness after upgrading a stale history row', () => {
    const refresh = vi.fn<(podId: string) => void>();
    ctx = setup(refresh);
    ctx.podRepo.insert(basePod({ runtime: 'codex', model: 'gpt-5' }));
    ctx.eventRepo.insert(codexInspectionEvent('cat src/a.ts'));
    ctx.db
      .prepare(`
        INSERT INTO pod_quality_scores (
          pod_id, score, runtime, profile_name, model, final_status, completed_at
        ) VALUES (?, 40, 'codex', 'test-profile', 'gpt-5', 'complete', ?)
      `)
      .run(POD_ID, '2026-04-23T12:00:00.000Z');

    expect(ctx.recorder.upgradeHistory().upgraded).toBe(1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(POD_ID);
  });

  it('refreshes a stale readiness snapshot for a current quality row without recomputing it', () => {
    const refresh = vi.fn<(podId: string) => void>();
    ctx = setup(refresh);
    ctx.podRepo.insert(basePod());
    ctx.eventRepo.insert(readEvent('src/a.ts'));
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
        filesChanged: 0,
        createdAt: '2026-04-23T11:50:00.000Z',
      },
    });
    const originalComputedAt = ctx.qualityScoreRepo.get(POD_ID)?.computedAt;
    ctx.db
      .prepare('UPDATE pods SET readiness_review = ? WHERE id = ?')
      .run(JSON.stringify({ computedAt: '2026-04-23T11:59:00.000Z' }), POD_ID);
    refresh.mockClear();

    expect(ctx.recorder.upgradeHistory()).toEqual({
      selected: 1,
      upgraded: 1,
      lastPodId: POD_ID,
    });
    expect(refresh).toHaveBeenCalledWith(POD_ID);
    expect(ctx.qualityScoreRepo.get(POD_ID)?.computedAt).toBe(originalComputedAt);
  });

  it('marks discarded historical Pi activity unavailable and upgrades in bounded batches', () => {
    ctx.podRepo.insert(basePod({ runtime: 'pi', model: 'pi-model' }));
    ctx.db
      .prepare(`
      INSERT INTO pod_quality_scores (
        pod_id, score, runtime, profile_name, model, final_status, completed_at
      ) VALUES (?, 10, 'pi', 'test-profile', 'pi-model', 'complete', ?)
    `)
      .run(POD_ID, '2026-04-23T12:00:00.000Z');

    expect(ctx.recorder.upgradeHistory(1)).toEqual({
      selected: 1,
      upgraded: 1,
      lastPodId: POD_ID,
    });
    expect(ctx.qualityScoreRepo.get(POD_ID)).toEqual(
      expect.objectContaining({
        algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
        inspectionAvailability: 'unavailable',
        score: null,
        readCount: null,
        readEditRatio: null,
        editsWithoutPriorRead: null,
      }),
    );
    expect(ctx.recorder.upgradeHistory(1)).toEqual({
      selected: 0,
      upgraded: 0,
      lastPodId: null,
    });
  });

  it('keeps historical Pi unavailable when only partial normalized activity survives', () => {
    ctx.podRepo.insert(basePod({ runtime: 'pi', model: 'pi-model' }));
    ctx.eventRepo.insert({
      type: 'pod.agent_activity',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      event: {
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        tool: 'read',
        input: { path: 'src/a.ts' },
      },
    });
    ctx.eventRepo.insert(editEvent('src/a.ts'));
    ctx.db
      .prepare(`
        INSERT INTO pod_quality_scores (
          pod_id, score, runtime, profile_name, model, final_status, completed_at
        ) VALUES (?, 75, 'pi', 'test-profile', 'pi-model', 'complete', ?)
      `)
      .run(POD_ID, '2026-04-23T12:00:00.000Z');

    expect(ctx.recorder.upgradeHistory().upgraded).toBe(1);
    expect(ctx.qualityScoreRepo.get(POD_ID)).toEqual(
      expect.objectContaining({
        algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
        inspectionAvailability: 'unavailable',
        score: null,
        readCount: null,
        readEditRatio: null,
        editsWithoutPriorRead: null,
      }),
    );
  });

  it('keeps mixed historical Pi to Codex attempts unavailable', () => {
    ctx.podRepo.insert(basePod({ runtime: 'codex', model: 'gpt-5' }));
    ctx.eventRepo.insert(codexInspectionEvent('cat src/a.ts'));
    ctx.eventRepo.insert(editEvent('src/a.ts'));
    ctx.providerAttemptRepo.open({
      podId: POD_ID,
      provider: 'openrouter',
      providerAccountId: null,
      runtime: 'pi',
      model: 'pi-model',
      profileReference: `pod:${POD_ID}@profile-snapshot#abcdef1`,
      profileSnapshot: {},
    });
    ctx.providerAttemptRepo.close(POD_ID, {
      outcome: 'quota_exhausted',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    ctx.providerAttemptRepo.open({
      podId: POD_ID,
      provider: 'openai',
      providerAccountId: null,
      runtime: 'codex',
      model: 'gpt-5',
      profileReference: `pod:${POD_ID}@profile-snapshot#abcdef1`,
      profileSnapshot: {},
    });
    ctx.db
      .prepare(`
        INSERT INTO pod_quality_scores (
          pod_id, score, runtime, profile_name, model, final_status, completed_at
        ) VALUES (?, 40, 'codex', 'test-profile', 'gpt-5', 'complete', ?)
      `)
      .run(POD_ID, '2026-04-23T12:00:00.000Z');

    expect(ctx.recorder.upgradeHistory().upgraded).toBe(1);
    expect(ctx.qualityScoreRepo.get(POD_ID)).toEqual(
      expect.objectContaining({
        algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
        inspectionAvailability: 'unavailable',
        score: null,
        readCount: null,
      }),
    );
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

  it('keeps the persisted score when readiness refresh fails', () => {
    ctx = setup(() => {
      throw new Error('readiness unavailable');
    });
    ctx.podRepo.insert(basePod());
    ctx.eventRepo.insert(readEvent('src/a.ts'));

    ctx.recorder.start();
    expect(() =>
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
          filesChanged: 0,
          createdAt: '2026-04-23T11:50:00.000Z',
        },
      }),
    ).not.toThrow();

    expect(ctx.qualityScoreRepo.get(POD_ID)?.score).toBe(100);
  });
});
