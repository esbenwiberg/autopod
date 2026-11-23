import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PendingRequests } from '@autopod/escalation-mcp';
import { AuthError } from '@autopod/shared';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { errorHandler } from '../api/error-handler.js';
import { authPlugin } from '../api/plugins/auth.js';
import { filesRoutes } from '../api/routes/files.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

it.each([
  'report',
  'missing',
  'symlink',
  'sandbox-report',
  'sandbox-ignored',
] as const)('serves only verified partial research after a detached infrastructure-held reply (%s)', async (kind) => {
  const ctx = createTestContext();
  const workspace = await mkdtemp(path.join(tmpdir(), 'partial-research-'));
  const app = Fastify();
  const pending = new PendingRequests();
  try {
    const reportPath = path.join(workspace, 'research-output.md');
    const report = '# Partial research\nOne verified observation: æøå.\n';
    const sandbox = kind === 'sandbox-report' || kind === 'sandbox-ignored';
    if (sandbox) {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
      git('init', '-q');
      if (kind === 'sandbox-report') {
        await writeFile(reportPath, report);
        git('add', 'research-output.md');
      } else {
        await writeFile(path.join(workspace, '.gitignore'), 'research-output.md\n');
        git('add', '.gitignore');
      }
      const snapshotTree = git('write-tree');
      // The host may have a stale ignored file or differing materialized bytes.
      await writeFile(reportPath, 'not the checkpoint report');
      ctx.deps.sandboxWorkspaceCheckpoint = async ({ sequence }) => ({
        sequence,
        sourceHead: '',
        sourceTree: '',
        snapshotCommit: '',
        snapshotTree,
        transferVerified: true,
        bundleVerified: true,
        hostImported: true,
        lineageVerified: true,
        promoted: true,
        materialized: true,
        quarantineRef: '',
        objectStore: path.join(workspace, '.git'),
      });
    }
    ctx.deps.pendingRequestsByPod = new Map();
    const manager = createPodManager(ctx.deps);
    const { id } = manager.createSession(
      { profileName: 'test-profile', task: 'Research' },
      'operator',
    );
    ctx.deps.pendingRequestsByPod.set(id, pending);
    const journal = ctx.podRepo.completionJournal;
    const runs = ctx.podRepo.taskExecutions;
    if (!journal || !runs) throw new Error('Missing test journals');
    ctx.db.prepare("UPDATE pods SET completion_policy = 'accept-findings' WHERE id = ?").run(id);
    if (sandbox)
      ctx.db.prepare("UPDATE pods SET execution_target = 'sandbox' WHERE id = ?").run(id);
    ctx.podRepo.update(id, {
      status: 'running',
      options: { agentMode: 'auto', output: 'artifact', validate: false },
      worktreePath: workspace,
      containerId: 'original-container',
    });
    const running = manager.getSession(id);
    const generation = running.lifecycleGeneration;
    journal.begin(running);
    const cycle = manager.getSession(id).finalization?.cycle;
    if (cycle === undefined) throw new Error('Missing test cycle');
    const runId = runs.beginRun(id, generation, cycle, {
      runtime: running.runtime,
      model: running.model,
      providerAccountId: null,
      resource: { containerId: running.containerId, executionTarget: running.executionTarget },
    });
    if (kind === 'report') await writeFile(reportPath, report);
    if (kind === 'symlink') await symlink('/etc/hosts', reportPath);
    const question = {
      id: 'question',
      podId: id,
      type: 'ask_human' as const,
      timestamp: new Date().toISOString(),
      payload: { question: 'Is the outline approved?' },
      response: null,
    };
    ctx.escalationRepo.insert(question);
    ctx.escalationRepo.insert({
      id: 'blocker',
      podId: id,
      type: 'report_blocker',
      timestamp: question.timestamp,
      response: null,
      payload: {
        kind: 'infrastructure',
        lifecycleGeneration: generation,
        requiresResponse: false,
        owner: 'autopod',
        phase: 'build',
        description: 'Browser runner unavailable',
        attempted: ['inspect the wireframe'],
        needs: 'Repair the browser runner',
      },
    });
    ctx.podRepo.update(id, { status: 'awaiting_input', pendingEscalation: question });
    const responsePromise = pending.waitForResponse(question.id, 5000);
    void responsePromise.catch(() => {});
    pending.markDetached(question.id, 'mcp_response_stream_closed');
    runs.finishRun(runId, 'completed', null);
    const settlement = journal.settle(manager.getSession(id));
    journal.mark(manager.getSession(id), 'awaiting_human', true);

    await manager.sendMessage(id, 'Use the saved outline');
    await expect(responsePromise).resolves.toBe('Use the saved outline');
    const failed = manager.getSession(id);
    expect(failed).toMatchObject({
      status: 'failed',
      containerId: 'original-container',
      pendingEscalation: null,
      researchFindings: null,
      failureReason: expect.stringContaining('Infrastructure also remains blocked'),
    });
    const queued = ctx.nudgeRepo.listPending(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.message).toContain('original MCP response stream closed');
    expect(queued[0]?.message).toContain('Use the saved outline');
    expect(ctx.runtime.resume).not.toHaveBeenCalled();

    app.setErrorHandler(errorHandler);
    authPlugin(app, {
      validateToken: async (token) => {
        if (token !== 'fixture') throw new AuthError('Invalid fixture token');
        return {
          oid: 'operator',
          preferred_username: 'operator@example.com',
          name: 'Operator',
          roles: [],
          aud: 'test',
          iss: 'test',
          exp: 0,
          iat: 0,
        };
      },
    });
    filesRoutes(app, manager, { get: () => ctx.containerManager }, journal);
    const url = `/pods/${id}/files/partial-research`;
    expect((await app.inject(url)).statusCode).toBe(401);
    // Mutating the workspace after preservation cannot influence returned bytes.
    if (kind === 'report') await writeFile(reportPath, 'changed after preservation');
    const headers = { authorization: 'Bearer fixture' };
    const calls = ctx.containerManager.execInContainer;
    const execs = vi.mocked(calls).mock.calls.length;
    const res = await app.inject({ url, headers });
    if (kind === 'report' || kind === 'sandbox-report') {
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toEqual({
        path: 'research-output.md',
        content: report,
        size: Buffer.byteLength(report),
        status: 'incomplete_unreviewed',
        provenance: {
          podId: id,
          generation,
          cycle,
          agentSettledAt: settlement.agentSettledAt,
          capturedAt: expect.any(String),
          sha256: createHash('sha256').update(report).digest('hex'),
        },
      });
      ctx.db
        .prepare('UPDATE pod_partial_research_reports SET content = ?')
        .run(Buffer.from('tampered'));
      const corrupt = await app.inject({ url, headers });
      expect(corrupt.statusCode).toBe(409);
      expect(corrupt.json().message).toContain('integrity check');
      ctx.db.prepare('DELETE FROM pod_partial_research_reports').run();
      const legacy = await app.inject({ url, headers });
      expect(legacy.statusCode).toBe(409);
      expect(legacy.json().message).toContain('No partial report was captured');
    } else {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: 'PARTIAL_RESEARCH_UNAVAILABLE',
        message: expect.stringContaining(
          kind === 'sandbox-ignored'
            ? 'not in the verified sandbox checkpoint'
            : kind === 'missing'
              ? 'was not found'
              : 'symbolic link',
        ),
      });
    }
    const normal = await app.inject({
      url: `/pods/${id}/files/content?path=research-output.md`,
      headers,
    });
    expect(normal.statusCode).toBe(409);
    expect(normal.json().error).toBe('FINDINGS_RECEIPT_UNAVAILABLE');
    expect(vi.mocked(calls).mock.calls.length).toBe(execs);
    expect(ctx.containerManager.start).not.toHaveBeenCalled();
    expect(ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(ctx.runtime.resume).not.toHaveBeenCalled();
    expect(manager.getSession(id)).toEqual(failed);
    expect(ctx.nudgeRepo.listPending(id)).toEqual(queued);
    expect(ctx.podRepo.hasInfrastructureBlocker?.(id)).toBe(true);
  } finally {
    await app.close();
    ctx.db.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
