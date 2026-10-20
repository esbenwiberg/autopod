import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { CodexAppServerGoalSession } from './codex-app-server-goal-session.js';

/** Real CLI persistence/protocol proof with a paused Goal: no credentials or inference. */
it.skipIf(!process.env.AUTOPOD_CODEX_GOAL_FIXTURE_CLI)(
  'persists a paused native Goal across app-server processes without loading it',
  async () => {
    const cli = process.env.AUTOPOD_CODEX_GOAL_FIXTURE_CLI;
    if (!cli?.startsWith('/')) throw new Error('Explicit absolute Codex CLI path required');
    const root = mkdtempSync(join(tmpdir(), 'autopod-goal-protocol-'));
    const clients: CodexAppServerClient[] = [];
    const open = () => {
      const child = spawn(cli, ['-c', `sqlite_home="${root}/state"`, 'app-server'], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      const exitCode = new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          if (code !== null) resolve(code);
          else if (signal) resolve(128);
          else reject(new Error('Unobserved native fixture exit'));
        });
      });
      const client = new CodexAppServerClient({
        stdout: child.stdout,
        stderr: child.stderr,
        stdin: child.stdin,
        exitCode,
        kill: async () => {
          if (child.exitCode === null && child.signalCode === null && child.pid)
            process.kill(-child.pid, 'SIGTERM');
          await exitCode;
        },
      });
      clients.push(client);
      return client;
    };
    try {
      const first = open();
      await first.request('initialize', {
        clientInfo: { name: 'autopod-offline-goal-proof', version: '1' },
        capabilities: { experimentalApi: true },
      });
      await first.notify('initialized');
      const started = (await first.request('thread/start', {
        cwd: root,
        model: 'gpt-6.1-sol',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        ephemeral: false,
      })) as { thread: { id: string } };
      const original = (await first.request('thread/goal/set', {
        threadId: started.thread.id,
        objective: 'Offline paused protocol fixture; never run inference',
        status: 'paused',
        tokenBudget: 1000,
        origin: 'user',
      })) as { goal: { tokensUsed: number; status: string } };
      expect(original.goal).toMatchObject({ status: 'paused', tokensUsed: 0 });
      await first.close();
      const second = open();
      const inspection = new CodexAppServerGoalSession(
        second,
        { model: 'unused', cwd: root, developerInstructions: '' },
        async (path) => readFileSync(path, 'utf8'),
      );
      await inspection.openInspection(started.thread.id);
      expect(await inspection.get()).toMatchObject({ nativeStatus: 'paused', cumulativeTokens: 0 });
      expect(await inspection.pause()).toMatchObject({
        nativeStatus: 'paused',
        cumulativeTokens: 0,
      });
      await expect(inspection.resume(1000)).rejects.toThrow('INSPECTION_ONLY');
      await inspection.clear();
      expect(await inspection.get()).toBeNull();
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
