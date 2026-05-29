import type { PodBridge } from '@autopod/escalation-mcp';
import type { EscalationRequest } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
import { type SessionBridgeDependencies, createSessionBridge } from './pod-bridge-impl.js';

type Deps = SessionBridgeDependencies;

function makeReportBlockerEscalation(id = 'esc-1'): EscalationRequest {
  return {
    id,
    podId: 'sess-1',
    type: 'report_blocker',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: {
      description: 'Cannot reach package registry',
      attempted: ['retry install'],
      needs: 'network access',
    },
    response: null,
  };
}

function buildBridge(): {
  bridge: PodBridge;
  escalationRepo: ReturnType<typeof createEscalationRepository>;
  notifyEscalation: ReturnType<typeof vi.fn>;
} {
  const db = createTestDb();
  insertTestProfile(db, { name: 'proj' });
  db.prepare(
    `INSERT INTO pods (id, profile_name, task, model, branch, user_id, status)
     VALUES ('sess-1', 'proj', 't', 'opus', 'main', 'u', 'running')`,
  ).run();

  const escalationRepo = createEscalationRepository(db);
  const notifyEscalation = vi.fn();
  const podManager = {
    getSession: vi.fn().mockReturnValue({ id: 'sess-1', profileName: 'proj', status: 'running' }),
    touchHeartbeat: vi.fn(),
    notifyEscalation,
  } as unknown as Deps['podManager'];

  const stub = {} as never;
  const bridge = createSessionBridge({
    podManager,
    podRepo: stub,
    eventBus: stub,
    escalationRepo,
    nudgeRepo: stub,
    profileStore: stub,
    containerManagerFactory: stub,
    pendingRequestsByPod: new Map(),
    logger,
  });

  return { bridge, escalationRepo, notifyEscalation };
}

describe('PodBridge escalation creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts non-notifying report_blocker rows without notifying the pod manager', () => {
    const { bridge, escalationRepo, notifyEscalation } = buildBridge();
    const escalation = makeReportBlockerEscalation();

    bridge.createEscalation(escalation, { notifyHuman: false });

    expect(escalationRepo.getOrThrow(escalation.id)).toEqual(
      expect.objectContaining({
        id: escalation.id,
        podId: 'sess-1',
        type: 'report_blocker',
        payload: escalation.payload,
      }),
    );
    expect(notifyEscalation).not.toHaveBeenCalled();
  });

  it('notifies the pod manager for report_blocker rows by default', () => {
    const { bridge, escalationRepo, notifyEscalation } = buildBridge();
    const escalation = makeReportBlockerEscalation();

    bridge.createEscalation(escalation);

    expect(escalationRepo.getOrThrow(escalation.id).type).toBe('report_blocker');
    expect(notifyEscalation).toHaveBeenCalledWith('sess-1', escalation);
  });

  it('counts only prior report_blocker rows for the pod', () => {
    const { bridge } = buildBridge();

    bridge.createEscalation(makeReportBlockerEscalation('blocker-1'), { notifyHuman: false });
    bridge.createEscalation(
      {
        ...makeReportBlockerEscalation('ai-1'),
        type: 'ask_ai',
        payload: { question: 'Can this be worked around?' },
      },
      { notifyHuman: false },
    );

    expect(bridge.getReportBlockerCount('sess-1')).toBe(1);
    expect(bridge.getAiEscalationCount('sess-1')).toBe(1);
  });
});
