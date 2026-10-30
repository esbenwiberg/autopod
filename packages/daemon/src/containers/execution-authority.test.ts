import { AutopodError } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { createProvisioningToolInstallation } from '../pods/provisioning-tool-installation.js';
import { fetchSandboxPreview } from '../pods/sandbox-preview-proxy.js';
import {
  captureValidationMutationGuard,
  guardValidationContainer,
} from '../pods/validation-recovery-policy.js';
import { createWorkspaceTransfer } from '../pods/workspace-transfer.js';
import { validationRecoveryFixture } from '../test-utils/validation-recovery-helpers.js';
import {
  checkpointSandboxWorkspace,
  observeSandboxWorkspace,
} from '../worktrees/sandbox-workspace-checkpoint.js';
import {
  AzureSandboxApiClient,
  type AzureSandboxApiClientConfig,
  type WebSocketLike,
} from './azure-sandbox-api-client.js';
import { SandboxContainerManager } from './sandbox-container-manager.js';

const logger = pino({ level: 'silent' });
const resource = '11111111-1111-4111-8111-111111111111';
const stale = () => new AutopodError('Synthetic authority revoked', 'STALE_AUTHORITY', 409);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function transport(config: Partial<AzureSandboxApiClientConfig> = {}) {
  const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    Response.json({ stdout: '', stderr: '', exitCode: 0 }),
  );
  const getToken = vi.fn(async () => ({
    token: 'synthetic-token',
    expiresOnTimestamp: Date.now() + 60_000,
  }));
  const client = new AzureSandboxApiClient(
    {
      subscriptionId: 'synthetic-subscription',
      resourceGroup: 'synthetic-group',
      sandboxGroup: 'synthetic-sandboxes',
      location: 'swedencentral',
      credential: { getToken },
      fetch,
      retry: { maxAttempts: 3, maxDelayMs: 0, baseDelayMs: 0 },
      ...config,
    },
    logger,
  );
  return { client, manager: new SandboxContainerManager(client, logger), fetch, getToken };
}

const commands: Array<{
  name: string;
  run(manager: ContainerManager, assertCurrent: () => void): Promise<unknown>;
}> = [
  {
    name: 'buffered exec with composed supplied assertion',
    run: (manager, assertCurrent) =>
      guardValidationContainer(manager, () => {}).execInContainer(resource, ['true'], {
        assertCurrent,
        cwd: '/workspace',
        timeout: 5000,
      }),
  },
  {
    name: 'preview HTTP POST',
    run: (manager, assertCurrent) =>
      fetchSandboxPreview({
        containerManager: manager,
        containerId: resource,
        assertCurrent,
        method: 'POST',
        path: '/synthetic-update',
        headers: {},
        body: Buffer.from('synthetic-body'),
      }),
  },
  {
    name: 'workspace transfer',
    run: (manager, assertCurrent) =>
      createWorkspaceTransfer({ logger, captureAuthority: () => assertCurrent }).syncWorkspaceBack(
        resource,
        '/unused-synthetic-path',
        manager,
        'synthetic-task',
      ),
  },
  ...(['installGhBinary', 'installAzViaPip'] as const).map((method) => ({
    name: method,
    run: (manager: ContainerManager, assertCurrent: () => void) =>
      createProvisioningToolInstallation({ logger })[method](
        guardValidationContainer(manager, assertCurrent),
        resource,
        'synthetic-task',
      ),
  })),
];

describe('captured execution authority at the actual Azure send boundary', () => {
  it.each(commands)('sends zero POSTs when auth outlives $name authority', async ({ run }) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const t = transport({
      credential: {
        async getToken() {
          entered.resolve();
          await release.promise;
          return { token: 'synthetic-token', expiresOnTimestamp: Date.now() + 60_000 };
        },
      },
    });
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) throw stale();
    });
    const pending = run(t.manager, assertCurrent).catch((error: unknown) => error);
    try {
      await entered.promise;
      current = false;
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ code: 'STALE_AUTHORITY' });
    expect(t.fetch).not.toHaveBeenCalled();
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each(['lifecycle', 'custody'] as const)(
    'uses the captured real %s guard after auth, before any POST',
    async (revocation) => {
      const f = validationRecoveryFixture();
      const entered = deferred<void>();
      const release = deferred<void>();
      try {
        f.podRepo.update(f.podId, { containerId: null });
        f.podRepo.update(f.podId, { executionTarget: 'sandbox', containerId: resource });
        const pod = f.podRepo.getOrThrow(f.podId);
        const assertCurrent = captureValidationMutationGuard(f.podRepo, pod);
        const t = transport({
          credential: {
            async getToken() {
              entered.resolve();
              await release.promise;
              return { token: 'synthetic-token', expiresOnTimestamp: Date.now() + 60_000 };
            },
          },
        });
        const pending = guardValidationContainer(t.manager, assertCurrent)
          .execInContainer(resource, ['true'])
          .catch((error: unknown) => error);
        await entered.promise;
        if (revocation === 'lifecycle') {
          f.podRepo.incrementLifecycleGeneration(f.podId);
        } else {
          const retries = f.podRepo.taskRetries;
          const ledger = f.podRepo.validationExecutions;
          if (!retries || !ledger) throw new Error('Missing validation ledger');
          const admission = retries.admit(
            pod.id,
            pod.lifecycleGeneration,
            {
              source: 'a'.repeat(64),
              contract: 'b'.repeat(64),
              commands: 'c'.repeat(64),
              environment: null,
              implementation: null,
            },
            'd'.repeat(64),
            [],
          );
          retries.start(admission.id);
          expect(ledger.dispatch(pod, admission.id, 1, 'synthetic-scope')).not.toBeNull();
        }
        release.resolve();
        expect(await pending).toBeInstanceOf(AutopodError);
        expect(t.fetch).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        f.db.close();
      }
    },
  );

  it('preserves both supplied assertions and all buffered command options while current', async () => {
    const t = transport();
    const owner = vi.fn();
    const supplied = vi.fn();
    await expect(
      guardValidationContainer(t.manager, owner).execInContainer(resource, ['true'], {
        assertCurrent: supplied,
        cwd: '/workspace',
        timeout: 5000,
        user: 'root',
        env: { SYNTHETIC_FLAG: 'enabled' },
      }),
    ).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(owner).toHaveBeenCalledTimes(3);
    expect(supplied).toHaveBeenCalledTimes(2);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    const init = t.fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      command: 'env SYNTHETIC_FLAG=enabled true',
      workingDirectory: '/workspace',
      user: 'root',
    });
  });

  it('dispatches the actual preview POST script with its assertion while current', async () => {
    const t = transport();
    t.fetch.mockResolvedValueOnce(
      Response.json({
        stdout: JSON.stringify({
          statusCode: 201,
          headers: {},
          bodyBase64: Buffer.from('created').toString('base64'),
        }),
        exitCode: 0,
      }),
    );
    const assertCurrent = vi.fn();
    await expect(commands[1]?.run(t.manager, assertCurrent)).resolves.toMatchObject({
      statusCode: 201,
      body: Buffer.from('created'),
    });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.fetch.mock.calls[0]?.[1]?.body).toContain('AUTOPOD_PREVIEW_METHOD');
    expect(t.fetch.mock.calls[0]?.[1]?.body).toContain('POST');
  });

  it.each([429, 403])('rechecks authority before each existing %s retry', async (status) => {
    const retryEntered = deferred<void>();
    const releaseRetry = deferred<void>();
    let current = true;
    const t = transport();
    t.fetch.mockImplementationOnce(async () => {
      retryEntered.resolve();
      await releaseRetry.promise;
      return new Response('', { status });
    });
    const assertion = vi.fn(() => {
      if (!current) throw stale();
    });
    const pending = t.manager
      .execInContainer(resource, ['true'], { assertCurrent: assertion })
      .catch((error: unknown) => error);
    try {
      await retryEntered.promise;
      current = false;
    } finally {
      releaseRetry.resolve();
    }
    expect(await pending).toMatchObject({ code: 'STALE_AUTHORITY' });
    expect(t.fetch).toHaveBeenCalledTimes(1); // Only the provider-rejected first attempt.
    expect(assertion).toHaveBeenCalledTimes(2);
    expect(t.getToken).toHaveBeenCalledTimes(1);
  });

  it.each([429, 403])(
    'preserves normal %s retries while authority remains current',
    async (status) => {
      const t = transport();
      t.fetch.mockResolvedValueOnce(new Response('', { status }));
      const assertCurrent = vi.fn();
      await expect(
        t.manager.execInContainer(resource, ['true'], { assertCurrent }),
      ).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
      expect(t.fetch).toHaveBeenCalledTimes(2);
      expect(assertCurrent).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps 401 terminal without introducing a refresh or command retry', async () => {
    const t = transport();
    t.fetch.mockResolvedValueOnce(new Response('synthetic unauthorized', { status: 401 }));
    const assertCurrent = vi.fn();
    await expect(
      t.manager.execInContainer(resource, ['true'], { assertCurrent }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.getToken).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
  });

  it.each(['observe', 'checkpoint'] as const)(
    'passes captured %s authority into the backend before auth completes',
    async (operation) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const t = transport({
        credential: {
          async getToken() {
            entered.resolve();
            await release.promise;
            return { token: 'synthetic-token', expiresOnTimestamp: Date.now() + 60_000 };
          },
        },
      });
      let current = true;
      const assertCurrent = () => {
        if (!current) throw stale();
      };
      const pending = (
        operation === 'observe'
          ? observeSandboxWorkspace(t.manager, resource, assertCurrent)
          : checkpointSandboxWorkspace({
              containerManager: t.manager,
              containerId: resource,
              podId: 'synthetic-task',
              worktreePath: '/unused-synthetic-path',
              sequence: 1,
              assertCurrent,
            })
      ).catch((error: unknown) => error);
      try {
        await entered.promise;
        current = false;
      } finally {
        release.resolve();
      }
      const outcome = await pending;
      if (operation === 'observe') expect(outcome).toMatchObject({ code: 'STALE_AUTHORITY' });
      else expect(outcome).toMatchObject({ promoted: false, error: { phase: 'capture' } });
      expect(t.fetch).not.toHaveBeenCalled();
    },
  );

  it('fences native streaming setup after auth without sending any POST', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const t = transport({
      credential: {
        async getToken() {
          entered.resolve();
          await release.promise;
          return { token: 'synthetic-token', expiresOnTimestamp: Date.now() + 60_000 };
        },
      },
    });
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) throw stale();
    });
    const stream = await guardValidationContainer(t.manager, () => {}).execStreaming(
      resource,
      ['true'],
      { assertCurrent },
    );
    const pending = stream.exitCode.catch((error: unknown) => error);
    try {
      await entered.promise;
      current = false;
    } finally {
      release.resolve();
    }
    expect(await pending).toBeInstanceOf(Error);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('keeps started-stream cleanup independent of revoked dispatch authority', async () => {
    const socketReady = deferred<void>();
    const socket: WebSocketLike = {
      send: vi.fn(),
      close: vi.fn(() => socket.onclose?.({})),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) throw stale();
    });
    const t = transport({
      webSocket: () => {
        socketReady.resolve();
        return socket;
      },
    });
    const stream = await t.manager.execStreaming(resource, ['true'], { assertCurrent });
    const pending = stream.exitCode.catch((error: unknown) => error);
    await socketReady.promise;
    socket.onopen?.({});
    expect(socket.send).toHaveBeenCalledOnce();
    const dispatchChecks = assertCurrent.mock.calls.length;
    current = false;
    await expect(stream.kill()).resolves.toBeUndefined();
    expect(assertCurrent).toHaveBeenCalledTimes(dispatchChecks);
    expect(t.fetch).toHaveBeenCalledTimes(3); // Upload, chmod, owned PID termination.
    // Successful cleanup alone cannot manufacture an original process exit.
    expect(await pending).toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
  });

  it('fences the actual socket start after open and does not signal an unstarted process', async () => {
    const socketReady = deferred<void>();
    const socket: WebSocketLike = {
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    let current = true;
    const t = transport({
      webSocket: () => {
        socketReady.resolve();
        return socket;
      },
    });
    const stream = await t.manager.execStreaming(resource, ['true'], {
      assertCurrent: () => {
        if (!current) throw stale();
      },
    });
    const pending = stream.exitCode.catch((error: unknown) => error);
    await socketReady.promise;
    current = false;
    socket.onopen?.({});
    expect(await pending).toBeInstanceOf(Error);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
    // Only the wrapper upload and chmod; no PID/group kill for an unsent start.
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });
});
