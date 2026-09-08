import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingRequests, createEscalationMcpServer } from '@autopod/escalation-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  completeEvent,
  createMockRuntime,
  createTestContext,
  statusEvent,
} from '../test-utils/mock-helpers.js';
import { createNudgeRepository } from './nudge-repository.js';
import { createSessionBridge } from './pod-bridge-impl.js';
import { createPodManager } from './pod-manager.js';

it.each(
  (['ask_human', 'report_blocker', 'request_credential'] as const).flatMap((tool) =>
    (['dropped', 'received', 'storage-failure'] as const).map((mode) => ({ tool, mode })),
  ),
)('retains the actual attached $tool reply with $mode delivery', async ({ tool, mode }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createMockRuntime({
    spawn: vi.fn(async function* () {
      yield statusEvent('Waiting for operator');
      await gate;
      yield completeEvent('Worker settled');
    }),
  });
  const ctx = createTestContext({ runtime });
  const waiters = new Map<string, PendingRequests>();
  ctx.deps.pendingRequestsByPod = waiters;
  ctx.deps.githubAuth = {
    resolveCredential: vi.fn().mockResolvedValue({ token: 'fixture-only-credential' }),
  } as unknown as NonNullable<typeof ctx.deps.githubAuth>;
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Preserve attached replies' },
    'operator',
  );
  const pending = new PendingRequests();
  waiters.set(pod.id, pending);
  const bridge = createSessionBridge({
    ...ctx.deps,
    podManager: manager,
    pendingRequestsByPod: waiters,
  });
  vi.spyOn(bridge, 'getAutoPauseThreshold').mockReturnValue(1);
  const { server } = createEscalationMcpServer({
    podId: pod.id,
    bridge,
    pendingRequests: pending,
  });
  const client = new Client({ name: 'attached-reply-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const process = manager.processPod(pod.id);
  try {
    await vi.waitFor(() => expect(manager.getSession(pod.id).status).toBe('running'));
    const original = serverTransport.send.bind(serverTransport);
    let dropped = false;
    vi.spyOn(serverTransport, 'send').mockImplementation(async (message) => {
      if ('result' in message && !dropped && mode === 'dropped') {
        dropped = true;
        return;
      }
      await original(message);
    });
    const reply = client
      .callTool(
        {
          name: tool,
          arguments:
            tool === 'ask_human'
              ? { question: 'Keep the existing source?' }
              : tool === 'report_blocker'
                ? { description: 'Need source decision', attempted: [], needs: 'Direction' }
                : { service: 'github', reason: 'Read repository' },
        },
        undefined,
        { timeout: 1000 },
      )
      .then(
        (result) => result,
        () => 'lost' as const,
      );
    await vi.waitFor(() => expect(manager.getSession(pod.id).status).toBe('awaiting_input'));
    const decisionId = manager.getSession(pod.id).pendingEscalation?.id;
    if (!decisionId) throw new Error('Missing actual decision');
    expect(pending.hasPending(decisionId)).toBe(true);
    expect(pending.isDetached(decisionId)).toBe(false);
    const send = () =>
      manager.sendMessage(
        pod.id,
        tool === 'request_credential' ? 'approved' : 'Keep existing source',
        { type: 'human', id: 'fixture-operator' },
      );
    if (mode === 'storage-failure') {
      ctx.db.exec(
        "CREATE TRIGGER fixture_reply_fault BEFORE INSERT ON nudge_messages BEGIN SELECT RAISE(ABORT, 'fixture reply storage failed'); END",
      );
      await expect(send()).rejects.toThrow('fixture reply storage failed');
      expect(manager.getSession(pod.id).status).toBe('awaiting_input');
      expect(manager.getSession(pod.id).pendingEscalation?.id).toBe(decisionId);
      expect(ctx.escalationRepo.getOrThrow(decisionId).response).toBeNull();
      expect(
        ctx.db
          .prepare('SELECT COUNT(*) AS count FROM completion_decisions WHERE pod_id=?')
          .get(pod.id),
      ).toEqual({ count: 0 });
      expect(pending.hasPending(decisionId)).toBe(true);
      expect(ctx.nudgeRepo.hasPending(pod.id)).toBe(false);
      ctx.db.exec('DROP TRIGGER fixture_reply_fault');
    }
    await send();
    const delivered = await reply;
    expect(delivered === 'lost').toBe(mode === 'dropped');
    expect(dropped).toBe(mode === 'dropped');
    expect(ctx.nudgeRepo.hasPending(pod.id)).toBe(true);
    expect(
      ctx.nudgeRepo
        .listPending(pod.id)
        .map((row) => row.message)
        .join('\n'),
    ).toContain(
      tool === 'request_credential' ? 'Authenticated to github.com' : 'Keep existing source',
    );
    expect(
      ctx.nudgeRepo
        .listPending(pod.id)
        .map((row) => row.message)
        .join('\n'),
    ).not.toContain('fixture-only-credential');
    expect(ctx.escalationRepo.getOrThrow(decisionId).response?.actor).toEqual({
      type: 'human',
      id: 'fixture-operator',
    });
    const recorded = ctx.escalationRepo.getOrThrow(decisionId).response;
    if (!recorded) throw new Error('Missing durable response');
    bridge.resolveEscalation(decisionId, {
      ...recorded,
      actor: undefined,
      respondedAt: '2099-01-01T00:00:00Z',
    });
    expect(ctx.escalationRepo.getOrThrow(decisionId).response).toEqual(recorded);
    expect(() =>
      bridge.resolveEscalation(decisionId, { ...recorded, response: 'Different answer' }),
    ).toThrow('different recorded response');
    expect(ctx.escalationRepo.getOrThrow(decisionId).response).toEqual(recorded);
    if (mode === 'dropped') {
      const dir = mkdtempSync(join(tmpdir(), 'attached-reply-reopen-'));
      const file = join(dir, 'state.db');
      writeFileSync(file, ctx.db.serialize());
      const reopened = new Database(file);
      try {
        const saved = createNudgeRepository(reopened).readPending(pod.id);
        expect(saved?.messages).toEqual(
          ctx.nudgeRepo.listPending(pod.id).map((row) => row.message),
        );
        expect(saved?.deliveryId).toBe(ctx.nudgeRepo.readPending(pod.id)?.deliveryId);
        const decision = reopened
          .prepare(
            'SELECT response,actor FROM completion_decisions WHERE pod_id=? AND decision_id=?',
          )
          .get(pod.id, decisionId);
        expect(decision).toEqual({
          response: tool === 'request_credential' ? 'approved' : 'Keep existing source',
          actor: JSON.stringify({ type: 'human', id: 'fixture-operator' }),
        });
        expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(reopened.pragma('foreign_key_check')).toEqual([]);
      } finally {
        reopened.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (mode !== 'dropped') {
      if (delivered === 'lost' || !Array.isArray(delivered.content))
        throw new Error('Missing successful tool content');
      const text = delivered.content[1]?.text;
      if (typeof text !== 'string') throw new Error('Missing appended guidance receipt');
      const receipt = JSON.parse(text);
      expect(receipt.completedTool).toBe(tool);
      expect(receipt.instruction).toContain('Do not repeat an already completed action');
      expect(receipt.interrupted).toBeUndefined();
      const check = await client.callTool({ name: 'check_messages', arguments: {} });
      if (!Array.isArray(check.content) || typeof check.content[0]?.text !== 'string')
        throw new Error('Missing replay');
      expect(JSON.parse(check.content[0].text).deliveryId).toBe(receipt.deliveryId);
      await client.callTool({
        name: 'acknowledge_messages',
        arguments: { deliveryId: receipt.deliveryId },
      });
      expect(ctx.nudgeRepo.hasPending(pod.id)).toBe(false);
    }
    release();
    await process;
    expect(manager.getSession(pod.id).status).toBe(mode === 'dropped' ? 'failed' : 'validated');
    if (mode === 'dropped') {
      expect(manager.getSession(pod.id).failureReason).toContain('human guidance');
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
    } else expect(ctx.validationEngine.validate).toHaveBeenCalledOnce();
    expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
  } finally {
    pending.cancelAll();
    release();
    await process;
    await client.close();
    await server.close();
    ctx.db.close();
  }
});
