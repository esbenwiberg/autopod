import { PendingRequests, createEscalationMcpServer } from '@autopod/escalation-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import {
  completeEvent,
  createMockRuntime,
  createTestContext,
  statusEvent,
} from '../test-utils/mock-helpers.js';
import { isBlockingEscalation } from './escalation-coordinator.js';
import { createSessionBridge } from './pod-bridge-impl.js';
import { createPodManager } from './pod-manager.js';

it.each([
  { hasQuestion: false, threshold: 3 },
  { hasQuestion: false, threshold: 10 },
  { hasQuestion: true, threshold: 3 },
])(
  'holds infrastructure after settlement without displacing a question (%s)',
  async ({ hasQuestion, threshold }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = createTestContext({
      runtime: createMockRuntime({
        spawn: vi.fn(async function* () {
          yield statusEvent('Working');
          await gate;
          yield completeEvent('Finished');
        }),
      }),
    });
    ctx.db.prepare('UPDATE profiles SET escalation_config = ? WHERE name = ?').run(
      JSON.stringify({
        ...ctx.profileStore.get('test-profile').escalation,
        autoPauseAfter: threshold,
      }),
      'test-profile',
    );
    const waiters = new Map<string, PendingRequests>();
    ctx.deps.pendingRequestsByPod = waiters;
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Check blocker lifecycle' },
      'operator',
    );
    const pending = new PendingRequests();
    waiters.set(pod.id, pending);
    const bridge = createSessionBridge({
      ...ctx.deps,
      podManager: manager,
      pendingRequestsByPod: waiters,
    });
    const { server } = createEscalationMcpServer({
      podId: pod.id,
      bridge,
      pendingRequests: pending,
    });
    const client = new Client({ name: 'blocker-threshold-fixture', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const process = manager.processPod(pod.id);
    const report = () =>
      client.callTool({
        name: 'report_blocker',
        arguments: {
          description: 'Optional source unavailable',
          attempted: ['Bounded request'],
          needs: 'Can proceed with remaining evidence',
        },
      });
    try {
      await vi.waitFor(() => expect(manager.getSession(pod.id).status).toBe('running'));
      for (let index = 0; index < 2; index++)
        bridge.createEscalation({
          id: `ai-${index}`,
          podId: pod.id,
          type: 'ask_ai',
          timestamp: new Date().toISOString(),
          payload: { question: 'Technical advice' },
          response: { respondedBy: 'ai', response: 'Advice only' },
        });
      if (hasQuestion)
        bridge.createEscalation({
          id: 'real-question',
          podId: pod.id,
          type: 'ask_human',
          timestamp: new Date().toISOString(),
          payload: { question: 'Choose product scope?' },
          response: null,
        });
      const update = ctx.podRepo.update;
      const fault = vi.spyOn(ctx.podRepo, 'update').mockImplementation((id, changes) => {
        if (changes.failureReason?.startsWith('Infrastructure blocked'))
          throw new Error('injected report write fault');
        return update(id, changes);
      });
      try {
        expect(() =>
          bridge.createEscalation({
            id: 'rolled-back-report',
            podId: pod.id,
            type: 'report_blocker',
            timestamp: new Date().toISOString(),
            payload: {
              kind: 'infrastructure',
              requiresResponse: false,
              description: 'Runner unavailable',
              attempted: [],
              needs: 'Repair',
            },
            response: null,
          }),
        ).toThrow('injected report write fault');
        expect(bridge.getAutoPauseCount(pod.id)).toBe(2);
        expect(
          ctx.escalationRepo
            .listBySession(pod.id)
            .some((entry) => entry.id === 'rolled-back-report'),
        ).toBe(false);
        expect(ctx.runtime.suspend).not.toHaveBeenCalled();
      } finally {
        fault.mockRestore();
      }
      for (let count = 1; count <= 4; count++) {
        const result = await report();
        expect(JSON.stringify(result)).toContain('No human answer');
        expect(manager.getSession(pod.id).status).toBe(hasQuestion ? 'awaiting_input' : 'running');
        expect(manager.getSession(pod.id).pendingEscalation?.id ?? null).toBe(
          hasQuestion ? 'real-question' : null,
        );
        expect(bridge.getAutoPauseCount(pod.id)).toBe(count + 2);
        // Recreated bridges use durable records, not a process-local or AI-only counter.
        const reopened = createSessionBridge({
          ...ctx.deps,
          podManager: manager,
          pendingRequestsByPod: waiters,
        });
        expect(reopened.getAutoPauseCount(pod.id)).toBe(count + 2);
        expect(bridge.getAiEscalationCount(pod.id)).toBe(2);
        if (!hasQuestion)
          bridge.reportProgress(pod.id, 'research', 'Preserving available work', 1, 2);
      }
      expect(ctx.runtime.spawn).toHaveBeenCalledTimes(1);
      expect(ctx.runtime.suspend).toHaveBeenCalledTimes(!hasQuestion && threshold === 3 ? 1 : 0);
    } finally {
      pending.cancelAll();
      release();
      await process;
      if (!hasQuestion && threshold === 3)
        await vi.waitFor(() => expect(manager.getSession(pod.id).status).toBe('paused'));
      expect(manager.getSession(pod.id)).toMatchObject({
        status: hasQuestion ? 'awaiting_input' : threshold === 3 ? 'paused' : 'failed',
        pendingEscalation: hasQuestion ? expect.objectContaining({ id: 'real-question' }) : null,
        failureReason: expect.stringContaining('Infrastructure blocked:'),
      });
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      await client.close();
      await server.close();
      ctx.db.close();
    }
  },
);

it('keeps legacy blockers and explicit human questions blocking', () => {
  const base = { id: 'legacy', podId: 'pod', timestamp: new Date().toISOString(), response: null };
  expect(
    isBlockingEscalation({
      ...base,
      type: 'report_blocker',
      payload: { description: 'Legacy', attempted: [], needs: 'Reply' },
    }),
  ).toBe(true);
  expect(
    isBlockingEscalation({ ...base, type: 'ask_human', payload: { question: 'Choose source' } }),
  ).toBe(true);
});
