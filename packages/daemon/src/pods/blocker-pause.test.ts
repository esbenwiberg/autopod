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

it('keeps advisory blockers running, then durably pauses and resumes at the configured threshold', async () => {
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
  const { server } = createEscalationMcpServer({ podId: pod.id, bridge, pendingRequests: pending });
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
    for (let count = 1; count <= 2; count++) {
      const result = await report();
      expect(JSON.stringify(result)).toContain('Continuing with reduced confidence');
      expect(manager.getSession(pod.id).status).toBe('running');
      expect(manager.getSession(pod.id).pendingEscalation).toBeNull();
      expect(bridge.getAutoPauseCount(pod.id)).toBe(count);
      // Recreated bridges use durable records, not a process-local or AI-only counter.
      const reopened = createSessionBridge({
        ...ctx.deps,
        podManager: manager,
        pendingRequestsByPod: waiters,
      });
      expect(reopened.getAutoPauseCount(pod.id)).toBe(count);
      expect(bridge.getAiEscalationCount(pod.id)).toBe(0);
      bridge.reportProgress(pod.id, 'research', 'Continuing available work', 1, 2);
    }
    const blocked = report();
    await vi.waitFor(() => expect(manager.getSession(pod.id).status).toBe('awaiting_input'));
    const decisionId = manager.getSession(pod.id).pendingEscalation?.id;
    if (!decisionId) throw new Error('Missing threshold decision');
    expect(pending.hasPending(decisionId)).toBe(true);
    expect(bridge.getAutoPauseCount(pod.id)).toBe(3);
    await manager.sendMessage(pod.id, 'Use the available evidence', {
      type: 'human',
      id: 'fixture-operator',
    });
    expect(JSON.stringify(await blocked)).toContain('Use the available evidence');
    expect(manager.getSession(pod.id).status).toBe('running');
    expect(ctx.escalationRepo.getOrThrow(decisionId).response?.response).toBe(
      'Use the available evidence',
    );
    const guidance = bridge.readOperatorGuidance(pod.id);
    if (guidance) bridge.acknowledgeOperatorGuidance(pod.id, guidance.deliveryId);
  } finally {
    pending.cancelAll();
    release();
    await process;
    await client.close();
    await server.close();
    ctx.db.close();
  }
});

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
