import { Readable } from 'node:stream';
import type { Pod } from '@autopod/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createMockContainerManager, createTestDb } from '../test-utils/mock-helpers.js';
import { IsolatedReviewer } from './isolated-reviewer.js';
import { ReviewerRunRepository } from './reviewer-run-repository.js';

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function fixture(failover = false) {
  const db = createTestDb();
  databases.push(db);
  const { services } = createTestConfiguration(db);
  const accounts = createProviderAccountStore(db);
  for (const id of ['account', 'reviewer', 'alternate'])
    accounts.create({
      id,
      name: id,
      provider: 'anthropic',
      credentials: { provider: 'anthropic', apiKey: `fixture-${id}-secret` },
    });
  services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, accounts);
  const config = await resolveLaunch(
    {
      repositoryId: 'repo-a',
      task: 'Implement feature',
      overrides: {
        ai: {
          reviewer: {
            mode: 'independent',
            route: {
              providerAccountId: 'reviewer',
              runtime: 'claude',
              model: 'claude-sonnet-4-6',
              ...(failover
                ? {
                    maxHops: 1,
                    failover: [
                      {
                        providerAccountId: 'alternate',
                        runtime: 'claude',
                        model: 'claude-sonnet-4-6',
                      },
                    ],
                  }
                : {}),
            },
          },
        },
      },
    },
    services,
  );
  insertConfigurationTestPod(db, 'pod');
  let pod: Pod = {
    ...createPodRepository(db).getOrThrow('pod'),
    status: 'running',
    launchConfigDigest: config.digest,
    containerId: 'main-container',
  };
  const manager = createMockContainerManager();
  vi.mocked(manager.spawn).mockImplementation(async (input) => {
    input.onCreated?.('review-container');
    return 'review-container';
  });
  vi.mocked(manager.execStreaming).mockImplementation(async () => ({
    stdout: Readable.from([
      JSON.stringify({ result: 'Review complete', usage: { input_tokens: 7, output_tokens: 3 } }),
    ]),
    stderr: Readable.from([]),
    exitCode: Promise.resolve(0),
    kill: vi.fn(async () => {}),
  }));
  const network = {
    buildNetworkConfig: vi.fn(async () => ({
      networkName: 'isolated-review',
      firewallScript: 'fixture-firewall',
    })),
    removeNetworkForPod: vi.fn(async () => {}),
  };
  const runs = new ReviewerRunRepository(db);
  const assertAllowed = vi.fn(async () => {});
  const service = new IsolatedReviewer({
    runs,
    accounts,
    manager: () => manager,
    image: () => `trusted/reviewer@sha256:${'a'.repeat(64)}`,
    network,
    logger: pino({ level: 'silent' }),
    readPod: () => pod,
    assertAllowed,
  });
  if (config.ai.reviewer.mode !== 'independent') throw new Error('fixture reviewer');
  return {
    db,
    config,
    accounts,
    manager,
    network,
    runs,
    service,
    assertAllowed,
    execute: service.executor(pod, config, config.ai.reviewer.route),
    setPod: (patch: Partial<Pod>) => {
      pod = { ...pod, ...patch };
    },
  };
}

describe('isolated reviewer execution', () => {
  function providerFailure(f: Awaited<ReturnType<typeof fixture>>, usage?: Record<string, number>) {
    vi.mocked(f.manager.execStreaming).mockImplementationOnce(async () => ({
      stdout: Readable.from([JSON.stringify({ result: 'Service unavailable', usage })]),
      stderr: Readable.from([]),
      exitCode: Promise.resolve(1),
      kill: vi.fn(async () => {}),
    }));
  }

  it('records both measured attempts and switches only to the frozen alternate account after cleanup', async () => {
    const f = await fixture(true);
    providerFailure(f, { input_tokens: 2, output_tokens: 0 });
    await expect(f.execute({ prompt: 'Review', timeout: 5000 })).resolves.toMatchObject({
      stdout: 'Review complete',
    });
    const rows = f.db
      .prepare(
        'SELECT request_id,ordinal,account_id,state,cleanup,input_tokens,output_tokens,failure_kind FROM isolated_reviewer_runs ORDER BY ordinal',
      )
      .all();
    expect(rows).toEqual([
      {
        request_id: expect.any(String),
        ordinal: 0,
        account_id: 'reviewer',
        state: 'failed',
        cleanup: 'clean',
        input_tokens: 2,
        output_tokens: 0,
        failure_kind: 'provider-unavailable',
      },
      {
        request_id: expect.any(String),
        ordinal: 1,
        account_id: 'alternate',
        state: 'completed',
        cleanup: 'clean',
        input_tokens: 7,
        output_tokens: 3,
        failure_kind: null,
      },
    ]);
    expect(new Set(rows.map((row) => (row as { request_id: string }).request_id)).size).toBe(1);
    const dispatches = vi.mocked(f.manager.execStreaming).mock.invocationCallOrder;
    expect(vi.mocked(f.manager.kill).mock.invocationCallOrder[0]).toBeLessThan(dispatches[1]!);
    expect(JSON.stringify(vi.mocked(f.manager.writeFile).mock.calls)).not.toContain(
      'fixture-account-secret',
    );
    expect(JSON.stringify(vi.mocked(f.manager.writeFile).mock.calls)).toContain(
      'fixture-alternate-secret',
    );
  });

  it.each([undefined, { input_tokens: 2 }, { output_tokens: 1 }])(
    'does not fail over with incomplete usage %j',
    async (usage) => {
      const f = await fixture(true);
      providerFailure(f, usage);
      await expect(f.execute({ prompt: 'Review', timeout: 5000 })).rejects.toThrow(
        'Service unavailable',
      );
      expect(f.manager.spawn).toHaveBeenCalledOnce();
      expect(f.db.prepare('SELECT state FROM isolated_reviewer_runs').get()).toEqual({
        state: 'uncertain',
      });
    },
  );

  it('does not fail over when cleanup is unconfirmed', async () => {
    const f = await fixture(true);
    providerFailure(f, { input_tokens: 0, output_tokens: 0 });
    vi.mocked(f.manager.kill).mockRejectedValueOnce(new Error('transport lost'));
    await expect(f.execute({ prompt: 'Review', timeout: 5000 })).rejects.toThrow('cleanup');
    expect(f.manager.spawn).toHaveBeenCalledOnce();
  });

  it('charges failed attempt usage before admitting its alternate', async () => {
    const f = await fixture(true);
    f.config.workflow.reviewerTokenBudget = 2;
    providerFailure(f, { input_tokens: 2, output_tokens: 0 });
    await expect(f.execute({ prompt: 'Review', timeout: 5000 })).rejects.toThrow('budget');
    expect(f.manager.spawn).toHaveBeenCalledOnce();
  });

  it('uses only the selected reviewer account in a disposable container and records measured usage', async () => {
    const f = await fixture();
    const response = await f.execute({ prompt: 'Frozen diff and review context', timeout: 5000 });
    expect(response).toMatchObject({
      stdout: 'Review complete',
      tokenUsage: { inputTokens: 7, outputTokens: 3 },
    });
    const spawn = vi.mocked(f.manager.spawn).mock.calls[0]?.[0];
    expect(spawn).toMatchObject({
      env: {},
      volumes: [],
      ports: [],
      exposeHostGateway: false,
      networkPolicyMode: 'restricted',
    });
    const files = vi.mocked(f.manager.writeFile).mock.calls;
    expect(files.every(([container]) => container === 'review-container')).toBe(true);
    expect(JSON.stringify(files)).toContain('fixture-reviewer-secret');
    expect(JSON.stringify(files)).not.toContain('fixture-account-secret');
    expect(JSON.stringify(files)).not.toContain('main-container');
    expect(f.manager.kill).toHaveBeenCalledWith('review-container');
    expect(f.network.removeNetworkForPod).toHaveBeenCalled();
    expect(
      f.db
        .prepare(
          'SELECT state,cleanup,input_tokens,output_tokens,account_id FROM isolated_reviewer_runs',
        )
        .get(),
    ).toEqual({
      state: 'completed',
      cleanup: 'clean',
      input_tokens: 7,
      output_tokens: 3,
      account_id: 'reviewer',
    });
  });

  it('rechecks account revocation after provisioning and before inference', async () => {
    const f = await fixture();
    vi.mocked(f.manager.spawn).mockImplementation(async (input) => {
      input.onCreated?.('review-container');
      f.accounts.updateCredentials('reviewer', null);
      return 'review-container';
    });
    await expect(f.execute({ prompt: 'Review', timeout: 5000 })).rejects.toThrow(
      'not authenticated',
    );
    expect(f.manager.execStreaming).not.toHaveBeenCalled();
    expect(f.manager.kill).toHaveBeenCalledWith('review-container');
  });

  it('fences cancellation while preparing without dispatch or touching the main container', async () => {
    const f = await fixture();
    vi.mocked(f.manager.writeFile).mockImplementation(async () => {
      f.setPod({ status: 'killing' });
    });
    await expect(f.execute({ prompt: 'Review', timeout: 5000 })).rejects.toThrow('no longer owns');
    expect(f.manager.execStreaming).not.toHaveBeenCalled();
    expect(f.manager.kill).not.toHaveBeenCalledWith('main-container');
  });

  it('does not rerun an unmetered reviewer or infer zero usage from a successful response', async () => {
    const f = await fixture();
    vi.mocked(f.manager.execStreaming).mockImplementation(async () => ({
      stdout: Readable.from(['{"result":"Review"}']),
      stderr: Readable.from([]),
      exitCode: Promise.resolve(0),
      kill: vi.fn(async () => {}),
    }));
    await f.execute({ prompt: 'Review', timeout: 5000 });
    await expect(f.execute({ prompt: 'Retry review', timeout: 5000 })).rejects.toThrow(
      'reconciliation',
    );
    expect(f.manager.spawn).toHaveBeenCalledOnce();
    expect(f.db.prepare('SELECT state,cleanup FROM isolated_reviewer_runs').get()).toEqual({
      state: 'uncertain',
      cleanup: 'clean',
    });
  });

  it('refuses another invocation once the reviewer sub-budget is spent', async () => {
    const f = await fixture();
    f.config.workflow.reviewerTokenBudget = 10;
    await f.execute({ prompt: 'Review', timeout: 5000 });
    await expect(f.execute({ prompt: 'Second review', timeout: 5000 })).rejects.toThrow('budget');
    expect(f.manager.spawn).toHaveBeenCalledOnce();
  });

  it('retains cleanup failure and requires confirmed reaping before another invocation', async () => {
    const f = await fixture();
    vi.mocked(f.manager.kill).mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(f.execute({ prompt: 'Review', timeout: 5000 })).rejects.toThrow('cleanup');
    await expect(f.execute({ prompt: 'Retry', timeout: 5000 })).rejects.toThrow('reconciliation');
    await f.service.recover();
    expect(f.runs.pending()).toEqual([]);
    await f.execute({ prompt: 'Next measured review', timeout: 5000 });
  });
});
