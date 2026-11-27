import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopodError } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { collectPrivateHead } from '../managed/private-head-export.js';
import { createSessionBridge, type SessionBridgeDependencies } from '../pods/pod-bridge-impl.js';
import { assertSourceResourceReleasable } from '../pods/source-custody-guards.js';
import { assertValidationResourceSettled } from '../pods/validation-execution-evidence.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createSandboxWakeupFixture } from '../test-utils/sandbox-wakeup-helpers.js';
import { validationRecoveryFixture } from '../test-utils/validation-recovery-helpers.js';
import { createLocalValidationEngine } from '../validation/local-validation-engine.js';
import { AzureSandboxApiClient, type WebSocketLike } from './azure-sandbox-api-client.js';
import { RoutingContainerManager } from './routing-container-manager.js';
import { type SandboxExecChunk, SandboxInfrastructureError } from './sandbox-api-client.js';
import { SandboxContainerManager } from './sandbox-container-manager.js';
import {
  sandboxGoalExit,
  sandboxGoalProcess,
  sandboxGoalSupervisor,
} from './sandbox-goal-process.js';

const logger = pino({ level: 'silent' });

it('observes a long preparation through the real bounded Azure exec transport without replay', async () => {
  vi.useFakeTimers();
  const started = Date.now();
  let launches = 0;
  let execId = '';
  const { client } = makeClient([], {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { command: string };
      const match = /autopod-goal-exec-([a-f0-9-]{36})/.exec(body.command);
      if (match?.[1]) {
        if (execId) expect(match[1]).toBe(execId);
        execId = match[1];
      }
      let stdout = '';
      if (body.command.includes('--detach') && !body.command.includes('os.mkdir')) launches++;
      if (body.command.includes('read_text')) {
        const terminal = Date.now() - started >= 35000;
        stdout = JSON.stringify({
          execId,
          observedExit: terminal,
          ...(terminal
            ? {
                exitCode: 0,
                timedOut: false,
                output: {
                  stdout: Buffer.from('prepared').toString('base64'),
                  stderr: '',
                },
              }
            : {}),
        });
      }
      return new Response(JSON.stringify({ stdout, stderr: '', exitCode: 0 }), { status: 200 });
    },
  });
  try {
    const manager = new SandboxContainerManager(client, logger);
    const outcome = manager.execObserved('candidate', ['sh', '-c', 'sleep 35; echo prepared'], {
      timeout: 120000,
      maxOutputBytes: 65536,
      requireObservedExit: true,
    });
    await vi.advanceTimersByTimeAsync(36000);
    expect(await outcome).toEqual({ exitCode: 0, stdout: 'prepared', stderr: '' });
    expect(launches).toBe(1);
    expect(execId).toHaveLength(36);
  } finally {
    vi.useRealTimers();
  }
});

describe.skipIf(process.platform !== 'linux')('bounded preparation supervisor', () => {
  it.each([0, 7, 143])('captures bounded output and the actual child exit %s', (exitCode) => {
    const root = mkdtempSync(join(tmpdir(), 'prep-supervisor-'));
    const identity = sandboxGoalProcess('fixture', '11111111-1111-4111-8111-111111111111');
    try {
      // Exercise the real supervisor as the test user. Only the privilege boundary
      // is substituted; launch, output draining, reaping and receipts run unchanged.
      const script = sandboxGoalSupervisor(
        identity,
        [
          'python3',
          '-c',
          exitCode === 143
            ? 'import time;time.sleep(120)'
            : `import sys;print('x'*100000);print('final diagnostic',file=sys.stderr);sys.exit(${exitCode})`,
        ],
        root,
        {},
        false,
        { maxOutputBytes: 65536, deadlineMs: Date.now() + (exitCode === 143 ? 100 : 5000) },
      )
        .replace("root=pathlib.Path(spec['root'])", `root=pathlib.Path(${JSON.stringify(root)})`)
        .replace('os.geteuid()!=0 or ', '')
        .replace('root.stat().st_uid!=0', 'root.stat().st_uid!=os.getuid()')
        .replace('os.setgroups([]);os.setgid(1000);os.setuid(1000)', 'pass');
      const run = spawnSync('python3', ['-I', '-c', script], { timeout: 10000, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(exitCode);
      const raw = readFileSync(join(root, 'state.json'), 'utf8');
      expect(sandboxGoalExit(identity, raw)).toBe(exitCode);
      const receipt = JSON.parse(raw);
      const stdout = Buffer.from(receipt.output.stdout, 'base64');
      const stderr = Buffer.from(receipt.output.stderr, 'base64');
      expect(stdout.length + stderr.length).toBeLessThanOrEqual(65536);
      expect(stdout.length).toBe(exitCode === 143 ? 0 : 32768);
      expect(stderr.toString()).toBe(exitCode === 143 ? '' : 'final diagnostic\n');
      expect(receipt.timedOut).toBe(exitCode === 143);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
let wakeupFixture: ReturnType<typeof createSandboxWakeupFixture> | undefined;

describe('source resource release custody', () => {
  it('refuses provider deletion when immutable validation custody arrives during auth', async () => {
    const f = validationRecoveryFixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resource = '11111111-1111-4111-8111-111111111111';
    try {
      f.podRepo.update(f.podId, { containerId: null });
      f.podRepo.update(f.podId, { executionTarget: 'sandbox', containerId: resource });
      const { client, requests } = makeClient([], {
        credential: {
          async getToken() {
            await gate;
            return { token: 'fixture-token', expiresOnTimestamp: Date.now() + 60000 };
          },
        },
        assertReleaseAllowed: (id) => assertSourceResourceReleasable(f.db, id),
      });
      const pending = client.destroy(resource).catch((error: unknown) => error);
      const retries = f.podRepo.taskRetries;
      const ledger = f.podRepo.validationExecutions;
      if (!retries || !ledger) throw new Error('Missing durable validation ledger');
      const pod = f.podRepo.getOrThrow(f.podId);
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
      expect(ledger.dispatch(pod, admission.id, 1, 'test-scope')).not.toBeNull();
      // Replacement pointers cannot release the original immutable resource.
      f.podRepo.update(pod.id, { containerId: 'replacement' });
      release();
      const outcome = await pending;
      expect(requests).toEqual([]);
      expect(outcome).toMatchObject({ code: 'VALIDATION_EXECUTION_UNVERIFIED' });
      expect(ledger.unsettled(pod.id)).not.toBeNull();
    } finally {
      release();
      f.db.close();
    }
  });

  it('refuses a queued wakeup after immutable validation custody arrives during observation auth', async () => {
    const f = validationRecoveryFixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resource = '11111111-1111-4111-8111-111111111111';
    try {
      f.podRepo.update(f.podId, { containerId: null });
      f.podRepo.update(f.podId, { executionTarget: 'sandbox', containerId: resource });
      const { client, requests } = makeClient(
        [{ status: 200, body: { id: resource, state: 'Stopped' } }],
        {
          credential: {
            async getToken() {
              await gate;
              return { token: 'fixture-token', expiresOnTimestamp: Date.now() + 60000 };
            },
          },
          wakeupJournal: f.podRepo.sandboxWakeups,
          assertWakeAllowed: (id) => assertValidationResourceSettled(f.db, id),
        },
      );
      const journal = f.podRepo.sandboxWakeups;
      if (!journal) throw new Error('Missing wakeup journal');
      journal.observeRunning(client.getResourceKey(resource), resource);
      const pending = client.resume(resource).catch((error: unknown) => error);
      const retries = f.podRepo.taskRetries;
      const ledger = f.podRepo.validationExecutions;
      if (!retries || !ledger) throw new Error('Missing durable validation ledger');
      const pod = f.podRepo.getOrThrow(f.podId);
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
      expect(ledger.dispatch(pod, admission.id, 1, 'test-scope')).not.toBeNull();
      release();
      const outcome = await pending;
      expect(requests.every((request) => request.init?.method === 'GET')).toBe(true);
      expect(outcome).toMatchObject({ code: 'VALIDATION_EXECUTION_UNVERIFIED' });
      expect(journal.pendingSandboxIds()).toEqual([]);
    } finally {
      release();
      f.db.close();
    }
  });

  it.each([
    'destroy',
    'suspend',
  ] as const)('rechecks custody after delayed auth before %s dispatch', async (action) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const { client, requests } = makeClient(
      action === 'suspend' ? [{ status: 200, body: { id: 'original', state: 'Running' } }] : [],
      {
        credential: {
          async getToken() {
            await gate;
            return { token: 'fixture-token', expiresOnTimestamp: Date.now() + 60_000 };
          },
        },
        assertReleaseAllowed() {
          if (held) throw new Error('SOURCE_CUSTODY_HELD');
        },
      },
    );
    const pending = client[action]('original');
    held = true;
    release();
    await expect(pending).rejects.toThrow('SOURCE_CUSTODY_HELD');
    expect(requests.filter((request) => request.init?.method !== 'GET')).toHaveLength(0);
  });
});

describe('sandbox resource namespaces', () => {
  it('binds endpoint/region/subscription/group/resource without waking or executing', () => {
    const original = makeClient([]);
    const key = original.client.getResourceKey('original');
    for (const change of [
      { location: 'northeurope' },
      { subscriptionId: 'other' },
      { resourceGroup: 'other' },
      { sandboxGroup: 'other' },
    ])
      expect(makeClient([], change).client.getResourceKey('original')).not.toBe(key);
    expect(original.client.getResourceKey('replacement')).not.toBe(key);
    expect(original.requests).toHaveLength(0);
  });
});

describe('recoverable native sandbox Goal processes', () => {
  it('delivers RPC stdin through ordered private packets instead of the EOF-only stream', async () => {
    const socket = new MockWebSocket();
    let saved: import('@autopod/shared').NativeGoalProcessIdentity | undefined;
    let input: ((data: Buffer) => void) | undefined;
    const { client } = makeClient([], {
      webSocket: () => {
        queueMicrotask(() => socket.onopen?.({}));
        return socket;
      },
    });
    vi.spyOn(client, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const writes = vi.spyOn(client, 'writeFile').mockResolvedValue();
    vi.spyOn(client, 'readFile').mockImplementation(async () =>
      Buffer.from(JSON.stringify({ execId: saved?.execId, observedExit: true, exitCode: 0 })),
    );
    const stream = client.execStream('sbx-goal', ['codex', 'app-server'], {
      stdin: true,
      onProcessCreated(identity) {
        saved = identity;
      },
      onStdinWriter(write) {
        input = write;
      },
    });
    const next = stream.next();
    await vi.waitFor(() => expect(input).toBeTypeOf('function'));
    input?.(Buffer.from('first\n'));
    input?.(Buffer.from('second\n'));
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(3));
    expect(JSON.parse(socket.sent[0] ?? '{}').start.stdin).toBe(false);
    expect(socket.sent).toHaveLength(1);
    for (const [index, text] of ['first\n', 'second\n'].entries()) {
      const call = writes.mock.calls[index + 1];
      expect(call?.[1]).toBe(saved?.pidPath.replace('/state.json', `/input-${index + 1}.json`));
      expect(JSON.parse(String(call?.[2]))).toEqual({
        sequence: index + 1,
        data: Buffer.from(text).toString('base64'),
        length: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'),
      });
    }
    socket.emit({ type: 'exit_code', exitCode: 0 });
    expect(await next).toEqual({ value: { exitCode: 0 }, done: false });
    await stream.return();
  });

  it('stops the exact process after an input upload fails without retrying the mutation', async () => {
    const socket = new MockWebSocket();
    let saved: import('@autopod/shared').NativeGoalProcessIdentity | undefined;
    let input: ((data: Buffer) => void) | undefined;
    const { client } = makeClient([], {
      webSocket: () => {
        queueMicrotask(() => socket.onopen?.({}));
        return socket;
      },
    });
    vi.spyOn(client, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const writes = vi.spyOn(client, 'writeFile').mockImplementation(async (_id, path) => {
      if (path.endsWith('/input-1.json')) throw new Error('Input upload uncertain');
    });
    vi.spyOn(client, 'readFile').mockImplementation(async () =>
      Buffer.from(JSON.stringify({ execId: saved?.execId, observedExit: true, exitCode: -15 })),
    );
    const stream = client.execStream('sbx-goal', ['codex', 'app-server'], {
      stdin: true,
      onProcessCreated(identity) {
        saved = identity;
      },
      onStdinWriter(write) {
        input = write;
      },
    });
    const next = stream.next();
    await vi.waitFor(() => expect(input).toBeTypeOf('function'));
    input?.(Buffer.from('do-not-repeat\n'));
    expect(await next).toEqual({ value: { exitCode: 143 }, done: false });
    expect(writes.mock.calls.filter((call) => call[1].endsWith('/input-1.json'))).toHaveLength(1);
    expect(writes.mock.calls.some((call) => call[1].endsWith('/stop'))).toBe(true);
    await stream.return();
  });

  it('reconciles a lost socket through private stop and observed-exit receipts', async () => {
    const socket = new MockWebSocket();
    let saved: import('@autopod/shared').NativeGoalProcessIdentity | undefined;
    const { client } = makeClient([], {
      webSocket: () => {
        queueMicrotask(() => {
          socket.onopen?.({});
          socket.close();
        });
        return socket;
      },
    });
    vi.spyOn(client, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const writes = vi.spyOn(client, 'writeFile').mockResolvedValue();
    vi.spyOn(client, 'readFile').mockImplementation(async () =>
      Buffer.from(
        JSON.stringify({
          execId: saved?.execId,
          observedExit: writes.mock.calls.some((call) => call[1].endsWith('/stop')),
          exitCode: -9,
        }),
      ),
    );
    const chunks = [];
    for await (const chunk of client.execStream('sbx-goal', ['codex', 'app-server'], {
      onProcessCreated(v) {
        saved = v;
      },
    }))
      chunks.push(chunk);
    expect(chunks).toEqual([{ exitCode: 137 }]);
    expect(
      writes.mock.calls.some((call) => call[1] === saved?.pidPath.replace('/state.json', '/stop')),
    ).toBe(true);
  });
  it.each([
    0, 7, -15,
  ])('reads the same invocation exit %s without stopping it after delivery loss', async (exitCode) => {
    let saved: import('@autopod/shared').NativeGoalProcessIdentity | undefined;
    const socket = new MockWebSocket();
    const { client } = makeClient([], {
      webSocket: () => {
        queueMicrotask(() => {
          socket.onopen?.({});
          socket.close();
        });
        return socket;
      },
    });
    vi.spyOn(client, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const writes = vi.spyOn(client, 'writeFile').mockResolvedValue();
    const terminate = vi.spyOn(client, 'terminateRecordedExec');
    const reads = vi
      .spyOn(client, 'readFile')
      .mockImplementation(async () =>
        Buffer.from(JSON.stringify({ execId: saved?.execId, observedExit: true, exitCode })),
      );
    const chunks = [];
    for await (const chunk of client.execStream('sbx-goal', ['codex', 'app-server'], {
      onProcessCreated(identity) {
        saved = identity;
      },
    }))
      chunks.push(chunk);
    expect(chunks).toEqual([{ exitCode: exitCode < 0 ? 128 - exitCode : exitCode }]);
    expect(reads).toHaveBeenCalledWith('sbx-goal', saved?.pidPath);
    expect(writes).toHaveBeenCalledTimes(1); // supervisor staging only
    expect(terminate).not.toHaveBeenCalled();
  });

  it.each([
    'missing',
    'unobserved',
    'rebound',
    'malformed',
  ])('keeps %s receipts uncertain if termination cannot be proven', async (receipt) => {
    let saved: import('@autopod/shared').NativeGoalProcessIdentity | undefined;
    const socket = new MockWebSocket();
    const { client } = makeClient([], {
      webSocket: () => {
        queueMicrotask(() => {
          socket.onopen?.({});
          socket.close();
        });
        return socket;
      },
    });
    vi.spyOn(client, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    vi.spyOn(client, 'writeFile').mockResolvedValue();
    vi.spyOn(client, 'readFile').mockImplementation(async () => {
      if (receipt === 'missing') throw new Error('not found');
      return Buffer.from(
        receipt === 'malformed'
          ? '{'
          : JSON.stringify({
              execId: receipt === 'rebound' ? 'other-invocation' : saved?.execId,
              observedExit: receipt === 'rebound',
              exitCode: 0,
            }),
      );
    });
    vi.spyOn(client, 'terminateRecordedExec').mockRejectedValue(
      new Error('termination unconfirmed'),
    );
    await expect(
      client
        .execStream('sbx-goal', ['codex'], {
          onProcessCreated(identity) {
            saved = identity;
          },
        })
        .next(),
    ).rejects.toMatchObject({
      code: 'AZURE_SANDBOX_EXEC_STREAM',
      transport: {
        sandboxId: 'sbx-goal',
        nativeExecId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        startSent: true,
      },
    });
  });

  it('records identity before any start and requires the supervisor exit receipt', async () => {
    const socket = new MockWebSocket();
    let saved: import('@autopod/shared').NativeGoalProcessIdentity | undefined;
    const webSocket = vi.fn(() => {
      expect(saved?.backend).toBe('sandbox');
      queueMicrotask(() => {
        socket.onopen?.({});
        socket.emit({ type: 'exit_code', exitCode: 143 });
      });
      return socket;
    });
    const { client } = makeClient([], { webSocket });
    vi.spyOn(client, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const writes = vi.spyOn(client, 'writeFile').mockResolvedValue();
    vi.spyOn(client, 'readFile').mockImplementation(async () =>
      Buffer.from(
        JSON.stringify({
          execId: saved?.execId,
          observedExit: true,
          exitCode: -15,
        }),
      ),
    );
    const started = vi.fn();
    const chunks = [];
    for await (const chunk of client.execStream('sbx-goal', ['codex', 'app-server'], {
      stdin: true,
      env: {
        PYTHONPATH: '/workspace',
        LD_PRELOAD: '/workspace/untrusted.so',
        TOKEN: 'fixture-only',
      },
      onProcessCreated(identity) {
        expect(webSocket).not.toHaveBeenCalled();
        saved = identity;
      },
      onProcessStarted: started,
    }))
      chunks.push(chunk);
    expect(saved?.pidPath).toBe(`/run/autopod-goal-exec-${saved?.execId}/state.json`);
    expect(started).toHaveBeenCalledWith(saved);
    expect(String(writes.mock.calls[0]?.[2])).toContain('private-supervisor-required');
    const frame = JSON.parse(socket.sent[0] ?? '{}');
    expect(frame.start.environment.PYTHONPATH).toBe('');
    expect(frame.start.environment.LD_PRELOAD).toBe('');
    expect(frame.start.environment.TOKEN).toBeUndefined();
    expect(String(writes.mock.calls[0]?.[2])).toMatch(/^#!\/usr\/bin\/python3 -I\n/);
    expect(chunks).toEqual([{ exitCode: 143 }]);
  });

  it('never opens a WebSocket when persistence refuses the new process owner', async () => {
    const webSocket = vi.fn();
    const { client } = makeClient([], { webSocket });
    vi.spyOn(client, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    vi.spyOn(client, 'writeFile').mockResolvedValue();
    const iterator = client.execStream('sbx-goal', ['codex', 'app-server'], {
      onProcessCreated() {
        throw new Error('Stale owner');
      },
    });
    await expect(iterator.next()).rejects.toThrow('Stale owner');
    expect(webSocket).not.toHaveBeenCalled();
  });

  it('rejects a socket exit without observed child termination', async () => {
    let saved: import('@autopod/shared').NativeGoalProcessIdentity | undefined;
    const socket = new MockWebSocket();
    const { client } = makeClient([], {
      webSocket: () => {
        queueMicrotask(() => {
          socket.onopen?.({});
          socket.emit({ type: 'exit_code', exitCode: 0 });
        });
        return socket;
      },
    });
    vi.spyOn(client, 'exec').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    vi.spyOn(client, 'writeFile').mockResolvedValue();
    vi.spyOn(client, 'readFile').mockImplementation(async () =>
      Buffer.from(
        JSON.stringify({
          execId: saved?.execId,
          observedExit: false,
        }),
      ),
    );
    await expect(
      client
        .execStream('sbx-goal', ['codex', 'app-server'], {
          onProcessCreated(identity) {
            saved = identity;
          },
        })
        .next(),
    ).rejects.toThrow('termination is unconfirmed');
  });

  it('recovers using the saved identity and files channel on a fresh client', async () => {
    const { sandboxGoalProcess } = await import('./sandbox-goal-process.js');
    const identity = sandboxGoalProcess('sbx-goal', '11111111-1111-4111-8111-111111111111');
    const { client } = makeClient([]);
    const write = vi.spyOn(client, 'writeFile').mockResolvedValue();
    const exec = vi.spyOn(client, 'exec');
    vi.spyOn(client, 'readFile').mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          execId: identity.execId,
          observedExit: true,
          exitCode: -9,
        }),
      ),
    );
    expect(await client.terminateRecordedExec(identity)).toBe(137);
    expect(write).toHaveBeenCalledWith(
      identity.containerId,
      identity.pidPath.replace('/state.json', '/stop'),
      Buffer.from(identity.execId),
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a receipt from a different process', async () => {
    const { sandboxGoalProcess } = await import('./sandbox-goal-process.js');
    const identity = sandboxGoalProcess('sbx-goal', '11111111-1111-4111-8111-111111111111');
    const { client } = makeClient([]);
    vi.spyOn(client, 'writeFile').mockResolvedValue();
    vi.spyOn(client, 'readFile').mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          execId: 'different',
          observedExit: true,
          exitCode: 0,
        }),
      ),
    );
    await expect(client.terminateRecordedExec(identity)).rejects.toThrow('ownership changed');
  });

  it('fences a late start when the daemon crashed before its acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      const { sandboxGoalProcess } = await import('./sandbox-goal-process.js');
      const identity = sandboxGoalProcess('sbx-goal', '11111111-1111-4111-8111-111111111111');
      const { client } = makeClient([]);
      vi.spyOn(client, 'writeFile').mockResolvedValue();
      const read = vi
        .spyOn(client, 'readFile')
        .mockRejectedValue(new Error('Missing pre-start receipt'));
      const exec = vi.spyOn(client, 'exec').mockImplementation(async () => {
        read.mockResolvedValue(
          Buffer.from(JSON.stringify({ execId: identity.execId, observedExit: true, exitCode: 0 })),
        );
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const recovery = client.terminateRecordedExec(identity);
      await vi.advanceTimersByTimeAsync(4100);
      expect(await recovery).toBe(0);
      expect(exec).toHaveBeenCalledWith(
        identity.containerId,
        [identity.pidPath.replace('/state.json', '/supervisor.py'), '--cancel'],
        { user: 'root', timeoutMs: 5000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

interface MockHttpResponse {
  status: number;
  body?: unknown;
  rawText?: string;
  headers?: Record<string, string>;
}

const credential = {
  async getToken() {
    return { token: 'test-token' };
  },
};

function makeClient(
  responses: MockHttpResponse[],
  config: Partial<ConstructorParameters<typeof AzureSandboxApiClient>[0]> = {},
): {
  client: AzureSandboxApiClient;
  requests: CapturedRequest[];
} {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`unexpected request: ${String(input)}`);
    }
    const body =
      next.status === 204
        ? null
        : (next.rawText ?? (next.body === undefined ? '' : JSON.stringify(next.body)));
    return new Response(body, {
      status: next.status,
      headers: next.headers,
    });
  };

  return {
    client: new AzureSandboxApiClient(
      {
        subscriptionId: 'sub-1',
        resourceGroup: 'rg-1',
        location: 'swedencentral',
        sandboxGroup: 'autopod-spike',
        credential,
        fetch,
        wakeupJournal: wakeupFixture?.journal,
        pollIntervalMs: 0,
        ...config,
      },
      logger,
    ),
    requests,
  };
}

class MockWebSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }

  /** Deliver a server frame as a JSON text message. */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

// execStream stages the command as an executable wrapper script (writeFile PUT +
// chmod exec POST) before opening the WebSocket, so callers that reach the socket
// must supply those two HTTP responses.
const STREAM_SETUP_RESPONSES: MockHttpResponse[] = [
  { status: 204 }, // writeFile: PUT /files
  { status: 200, body: { stdout: '', stderr: '', exitCode: 0 } }, // chmod +x
];

function makeStreamingClient(
  script: (socket: MockWebSocket) => void,
  responses: MockHttpResponse[] = STREAM_SETUP_RESPONSES,
): {
  client: AzureSandboxApiClient;
  sockets: MockWebSocket[];
  wsUrls: string[];
  wsHeaders: Record<string, string>[];
  requests: CapturedRequest[];
} {
  const sockets: MockWebSocket[] = [];
  const wsUrls: string[] = [];
  const wsHeaders: Record<string, string>[] = [];
  const { client, requests } = makeClient(responses, {
    webSocket: (url, headers) => {
      wsUrls.push(url);
      wsHeaders.push(headers);
      const socket = new MockWebSocket();
      sockets.push(socket);
      // Run the server script after execStream has attached its handlers.
      queueMicrotask(() => script(socket));
      return socket;
    },
  });
  return { client, sockets, wsUrls, wsHeaders, requests };
}

function jsonBody(request: CapturedRequest): unknown {
  return JSON.parse(String(request.init?.body));
}

function formBody(request: CapturedRequest): URLSearchParams {
  if (!(request.init?.body instanceof URLSearchParams)) {
    throw new Error('request body is not URLSearchParams');
  }
  return request.init.body;
}

describe('AzureSandboxApiClient', () => {
  it('creates the group when missing, then creates a disk image and sandbox', async () => {
    const { client, requests } = makeClient([
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { id: 'group-1' } },
      { status: 200, body: { value: [] } },
      { status: 200, body: { id: 'disk-1', status: { state: 'Creating' } } },
      { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'sbx-1', state: 'Creating' } },
      { status: 200, body: { id: 'sbx-1', state: 'Running' } },
    ]);

    const id = await client.createSandbox({
      image: 'mcr.microsoft.com/cbl-mariner/base/core:2.0',
      tier: 'L',
      podId: 'pod-1',
      env: { POD_ID: 'pod-1' },
      egressPolicy: {
        defaultAction: 'Deny',
        hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
      },
    });

    expect(id).toBe('sbx-1');
    expect(requests).toHaveLength(8);
    expect(requests[0]?.url).toContain(
      'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.App/sandboxGroups/autopod-spike',
    );
    expect(requests[3]?.url).toContain(
      'https://management.swedencentral.azuredevcompute.io/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/autopod-spike/diskimages',
    );
    expect(requests[4]?.url).toContain(
      'https://management.swedencentral.azuredevcompute.io/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/autopod-spike/diskimages',
    );
    expect(jsonBody(requests[4] ?? failRequest())).toMatchObject({
      image: { base: 'mcr.microsoft.com/cbl-mariner/base/core:2.0' },
    });
    expect(jsonBody(requests[6] ?? failRequest())).toMatchObject({
      sourcesRef: { diskImage: { id: 'disk-1' } },
      resources: { cpu: '2000m', memory: '4096Mi', disk: '40Gi' },
      environment: { POD_ID: 'pod-1' },
      labels: { purpose: 'autopod-sandbox', managedBy: 'autopod', podId: 'pod-1' },
      egressPolicy: {
        defaultAction: 'Deny',
        hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
      },
    });
  });

  it('allows disk image creation requests up to 15 minutes', async () => {
    vi.useFakeTimers();
    try {
      let requestCount = 0;
      const fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
        requestCount++;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      };
      const client = new AzureSandboxApiClient(
        {
          subscriptionId: 'sub-1',
          resourceGroup: 'rg-1',
          location: 'swedencentral',
          sandboxGroup: 'autopod-spike',
          credential,
          fetch,
          assumeGroupExists: true,
        },
        logger,
      );

      let settled = false;
      const creation = client.createSandbox({
        image: 'mcr.microsoft.com/cbl-mariner/base/core:2.0',
        tier: 'L',
        env: {},
        egressPolicy: { defaultAction: 'Allow', hostRules: [] },
      });
      creation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejection = expect(creation).rejects.toThrow('timed out after 900000ms');

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(requestCount).toBe(2);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches and uses a managed identity for private image pulls', async () => {
    const identityId =
      '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/sandbox-acr-pull';
    const { client, requests } = makeClient(
      [
        { status: 404, body: {} },
        { status: 201, body: {} },
        { status: 200, body: { id: 'group-1' } },
        { status: 200, body: { value: [] } },
        { status: 200, body: { refresh_token: 'acr-refresh-token' } },
        { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
        { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
      ],
      { imagePullIdentityResourceId: identityId },
    );

    await client.createSandbox({
      image: 'ewiacr.azurecr.io/autopod/test-app:latest',
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });

    expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
      identity: {
        type: 'UserAssigned',
        userAssignedIdentities: { [identityId]: {} },
      },
    });
    expect(requests[4]?.url).toBe('https://ewiacr.azurecr.io/oauth2/exchange');
    const exchange = formBody(requests[4] ?? failRequest());
    expect(exchange.get('grant_type')).toBe('access_token');
    expect(exchange.get('service')).toBe('ewiacr.azurecr.io');
    expect(exchange.get('access_token')).toBe('test-token');
    expect(jsonBody(requests[5] ?? failRequest())).toMatchObject({
      image: { base: 'ewiacr.azurecr.io/autopod/test-app:latest' },
      managedIdentityResourceId: identityId,
      registryCredentials: {
        username: '00000000-0000-0000-0000-000000000000',
        token: 'acr-refresh-token',
      },
    });
  });

  it('passes transient registry credentials for disk-image creation', async () => {
    const { client, requests } = makeClient(
      [
        { status: 200, body: { value: [] } },
        { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
        { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
      ],
      {
        assumeGroupExists: true,
        registryCredentials: { username: 'token-user', token: 'secret-token' },
      },
    );

    await client.createSandbox({
      image: 'ewiacr.azurecr.io/autopod/test-app:latest',
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });

    expect(requests[0]?.url).toContain('/diskimages');
    expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
      image: { base: 'ewiacr.azurecr.io/autopod/test-app:latest' },
      registryCredentials: { username: 'token-user', token: 'secret-token' },
    });
  });

  it('reuses a ready persistent disk image after sandbox deletion', async () => {
    const image = 'ewiacr.azurecr.io/autopod/test-app:latest';
    const sourceDigest = `sha256:${'1'.repeat(64)}`;
    const diskImage = {
      id: 'disk-digest1',
      image: { base: `ewiacr.azurecr.io/autopod/test-app@${sourceDigest}` },
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, sourceDigest),
    };
    const { client, requests } = makeClient(
      [
        { status: 200, body: { value: [] } },
        { status: 200, body: diskImage },
        { status: 200, body: diskImage },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 202, body: {} },
        { status: 404, body: {} },
        { status: 200, body: { value: [diskImage] } },
        { status: 200, body: { id: 'sbx-2', state: 'Running' } },
        { status: 200, body: { id: 'sbx-2', state: 'Running' } },
      ],
      {
        assumeGroupExists: true,
        registryCredentials: { username: 'token-user', token: 'secret-token' },
        resolveImageDigest: async () => sourceDigest,
      },
    );

    await client.createSandbox({
      image,
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });
    await client.destroy('sbx-1');
    await client.createSandbox({
      image,
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });

    const diskImageCreates = requests.filter(
      (request) => request.init?.method === 'PUT' && request.url.includes('/diskimages'),
    );
    const diskImageDeletes = requests.filter(
      (request) => request.init?.method === 'DELETE' && request.url.includes('/diskimages/'),
    );
    const sandboxCreates = requests.filter(
      (request) => request.init?.method === 'PUT' && request.url.includes('/sandboxes'),
    );

    expect(diskImageCreates).toHaveLength(1);
    expect(diskImageDeletes).toHaveLength(0);
    expect(sandboxCreates).toHaveLength(2);
    expect(jsonBody(sandboxCreates[1] ?? failRequest())).toMatchObject({
      sourcesRef: { diskImage: { id: 'disk-digest1' } },
    });
  });

  describe('opt-in XL, 2XL and 3XL bundles', () => {
    const image = 'ewiacr.azurecr.io/autopod/test-app:latest';
    const sourceDigest = `sha256:${'1'.repeat(64)}`;
    const diskImage = {
      id: 'disk-digest1',
      image: { base: `ewiacr.azurecr.io/autopod/test-app@${sourceDigest}` },
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, sourceDigest),
    };
    const reuseConfig = {
      assumeGroupExists: true,
      resolveImageDigest: async () => sourceDigest,
      retry: { maxDelayMs: 0 },
    };
    const sandboxPuts = (requests: CapturedRequest[]) =>
      requests.filter(
        (request) =>
          request.init?.method === 'PUT' && new URL(request.url).pathname.endsWith('/sandboxes'),
      );

    it.each([
      ['XL', { cpu: '4000m', memory: '8192Mi', disk: '80Gi' }],
      ['2XL', { cpu: '8000m', memory: '16384Mi', disk: '160Gi' }],
      ['3XL', { cpu: '16000m', memory: '32768Mi', disk: '320Gi' }],
    ] as const)('sends the whole %s bundle in the create payload', async (tier, resources) => {
      const { client, requests } = makeClient(
        [
          { status: 200, body: { value: [diskImage] } },
          { status: 200, body: { id: 'sbx-1', state: 'Creating' } },
          { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        ],
        reuseConfig,
      );
      await client.createSandbox({
        image,
        tier,
        podId: 'pod-1',
        env: {},
        egressPolicy: { defaultAction: 'Allow', hostRules: [] },
      });
      const puts = sandboxPuts(requests);
      expect(puts).toHaveLength(1);
      expect(jsonBody(puts[0] ?? failRequest())).toMatchObject({ resources });
    });

    it('resends the identical 2XL payload after a rate-limit retry, never a smaller one', async () => {
      const { client, requests } = makeClient(
        [
          { status: 200, body: { value: [diskImage] } },
          { status: 429, body: { retryAfterSeconds: 0 } },
          { status: 200, body: { id: 'sbx-1', state: 'Creating' } },
          { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        ],
        reuseConfig,
      );
      await client.createSandbox({
        image,
        tier: '2XL',
        podId: 'pod-1',
        env: {},
        egressPolicy: { defaultAction: 'Allow', hostRules: [] },
      });
      const bodies = sandboxPuts(requests).map((request) => jsonBody(request));
      expect(bodies).toHaveLength(2);
      for (const body of bodies)
        expect(body).toMatchObject({
          resources: { cpu: '8000m', memory: '16384Mi', disk: '160Gi' },
        });
    });

    it.each([
      [409, { error: { code: 'QuotaExceeded', message: 'Sandbox core quota exceeded' } }],
      [400, { error: { code: 'InsufficientCapacity', message: 'No capacity for 8 vCPU' } }],
    ])('surfaces a %s quota/capacity refusal without falling back to a smaller tier', async (status, body) => {
      const { client, requests } = makeClient(
        [
          { status: 200, body: { value: [diskImage] } },
          { status, body },
        ],
        reuseConfig,
      );
      await expect(
        client.createSandbox({
          image,
          tier: '2XL',
          podId: 'pod-1',
          env: {},
          egressPolicy: { defaultAction: 'Allow', hostRules: [] },
        }),
      ).rejects.toThrow(String(status));
      const puts = sandboxPuts(requests);
      expect(puts).toHaveLength(1);
      expect(jsonBody(puts[0] ?? failRequest())).toMatchObject({
        resources: { cpu: '8000m', memory: '16384Mi', disk: '160Gi' },
      });
      expect(requests).toHaveLength(2);
    });

    it('surfaces a managed XL quota refusal after exactly one create attempt', async () => {
      const pinned = `ewiacr.azurecr.io/autopod/test-app@${sourceDigest}`;
      const disk = {
        id: 'exact-disk',
        image: { base: pinned },
        status: { state: 'Ready' },
        labels: diskImageLabelsFor(pinned, sourceDigest),
      };
      const { client, requests } = makeClient(
        [
          { status: 200, body: disk },
          { status: 429, body: { error: { code: 'QuotaExceeded' } } },
        ],
        { assumeGroupExists: true, readyDiskImageId: disk.id, retry: { maxDelayMs: 0 } },
      );
      await expect(
        client.createSandbox({
          image: pinned,
          tier: 'XL',
          podId: 'managed-1',
          managedSpecDigest: `sha256:${'2'.repeat(64)}`,
          env: {},
          egressPolicy: { defaultAction: 'Deny', hostRules: [], trafficInspection: 'Full' },
        }),
      ).rejects.toThrow('429');
      const puts = sandboxPuts(requests);
      expect(puts).toHaveLength(1);
      expect(jsonBody(puts[0] ?? failRequest())).toMatchObject({
        resources: { cpu: '4000m', memory: '8192Mi', disk: '80Gi' },
      });
    });
  });

  it('uses only the exact ready disk image in qualification mode, without cache writes or discovery', async () => {
    const sourceDigest = `sha256:${'1'.repeat(64)}`;
    const image = `ewiacr.azurecr.io/autopod/test-app@${sourceDigest}`;
    const disk = {
      id: 'exact-disk',
      image: { base: image },
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, sourceDigest),
    };
    const { client, requests } = makeClient(
      [
        { status: 200, body: disk },
        { status: 200, body: disk },
        { status: 200, body: { id: 'sandbox', state: 'Running' } },
        { status: 200, body: { id: 'sandbox', state: 'Running' } },
      ],
      { assumeGroupExists: true, readyDiskImageId: disk.id },
    );
    expect(await client.prepareManagedImage(image)).toBe(disk.id);
    await expect(
      client.createSandbox({
        image,
        tier: 'S',
        podId: 'isolated',
        env: {},
        egressPolicy: { defaultAction: 'Deny', hostRules: [] },
      }),
    ).resolves.toBe('sandbox');
    expect(
      requests.map(({ url, init }) => [
        init?.method,
        new URL(url).pathname.split('/').slice(-2).join('/'),
      ]),
    ).toEqual([
      ['GET', 'diskimages/exact-disk'],
      ['GET', 'diskimages/exact-disk'],
      ['PUT', 'autopod-spike/sandboxes'],
      ['GET', 'sandboxes/sandbox'],
    ]);
    expect(jsonBody(requests[2] ?? failRequest())).toMatchObject({
      sourcesRef: { diskImage: { id: disk.id } },
    });
  });

  it.each([
    'not-ready',
    'mismatched-base',
    'mismatched-id',
    'missing',
  ])('refuses an invalid pinned disk image (%s) without creating or deleting anything', async (caseName) => {
    const sourceDigest = `sha256:${'1'.repeat(64)}`;
    const image = `ewiacr.azurecr.io/autopod/test-app@${sourceDigest}`;
    const disk = {
      id: caseName === 'mismatched-id' ? 'unexpected' : 'exact-disk',
      image: {
        base: caseName === 'mismatched-base' ? 'ewiacr.azurecr.io/autopod/test-app:mutable' : image,
      },
      status: { state: caseName === 'not-ready' ? 'Failed' : 'Ready' },
      labels: diskImageLabelsFor(image, sourceDigest),
    };
    const { client, requests } = makeClient(
      [caseName === 'missing' ? { status: 404 } : { status: 200, body: disk }],
      { assumeGroupExists: true, readyDiskImageId: 'exact-disk' },
    );
    await expect(
      client.createSandbox({
        image,
        tier: 'S',
        podId: 'isolated',
        egressPolicy: { defaultAction: 'Deny', hostRules: [] },
      }),
    ).rejects.toThrow();
    expect(requests.map(({ init }) => init?.method)).toEqual(['GET']);
  });

  it('does not retry sandbox allocation in exact ready disk image mode', async () => {
    const sourceDigest = `sha256:${'1'.repeat(64)}`;
    const image = `ewiacr.azurecr.io/autopod/test-app@${sourceDigest}`;
    const { client, requests } = makeClient(
      [
        {
          status: 200,
          body: {
            id: 'exact-disk',
            image: { base: image },
            status: { state: 'Ready' },
            labels: diskImageLabelsFor(image, sourceDigest),
          },
        },
        { status: 429 },
      ],
      { assumeGroupExists: true, readyDiskImageId: 'exact-disk' },
    );
    await expect(
      client.createSandbox({
        image,
        tier: 'S',
        podId: 'isolated',
        egressPolicy: { defaultAction: 'Deny', hostRules: [] },
      }),
    ).rejects.toThrow();
    expect(requests.map(({ init }) => init?.method)).toEqual(['GET', 'PUT']);
  });

  it('garbage-collects stale disk images after the source digest changes', async () => {
    const image = 'ewiacr.azurecr.io/autopod/test-app:latest';
    const oldDiskImage = {
      id: 'disk-old',
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, `sha256:${'2'.repeat(64)}`),
    };
    const newDiskImage = {
      id: 'disk-new',
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, `sha256:${'3'.repeat(64)}`),
    };
    const { client, requests } = makeClient(
      [
        { status: 200, body: { value: [oldDiskImage] } },
        { status: 200, body: newDiskImage },
        { status: 200, body: newDiskImage },
        { status: 202, body: {} },
        { status: 404, body: {} },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
      ],
      {
        assumeGroupExists: true,
        registryCredentials: { username: 'token-user', token: 'secret-token' },
        resolveImageDigest: async () => `sha256:${'3'.repeat(64)}`,
      },
    );

    await client.createSandbox({
      image,
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });

    const staleDeletes = requests.filter(
      (request) =>
        request.init?.method === 'DELETE' && request.url.includes('/diskimages/disk-old'),
    );
    expect(staleDeletes).toHaveLength(1);
    expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
      labels: diskImageLabelsFor(image, `sha256:${'3'.repeat(64)}`),
    });
  });

  it.skipIf(process.platform !== 'linux')(
    'selects admitted tools in streamed self-validation and final execs despite env loss',
    async () => {
      // The shipped wrapper records Linux /proc process identity. Run it unmodified
      // on Linux, not a macOS emulation of process ownership or privilege switching.
      // Fault injection, not a claim about the live Azure service: the stream starts
      // with image env only. Execute the shipped wrapper in a real child shell.
      const root = mkdtempSync(join(tmpdir(), 'validation-tools-'));
      // Root-started wrappers really drop to autopod: allow that user to enter
      // the fixture without making receipts or scripts worker-writable.
      chmodSync(root, 0o755);
      const base = join(root, 'base');
      const selected = join(root, 'selected');
      mkdirSync(base);
      mkdirSync(selected);
      for (const [directory, value] of [
        [base, 'base'],
        [selected, 'selected'],
      ] as const) {
        writeFileSync(join(directory, 'fixture-tool'), `#!/bin/sh\nprintf '%s' '${value}'`, {
          mode: 0o755,
        });
      }
      const baseEnv = { PATH: `${base}:/usr/bin:/bin`, AUTOPOD_STREAM_SESSION: '1' };
      const literals = {
        PATH: `${selected}:${baseEnv.PATH}`,
        CUSTOM: 'literal $() ; value',
        FIXTURE_WORKSPACE: root,
      };
      const scoped = { ...literals, CREDENTIAL: 'synthetic-secret-never-in-script' };
      const commands = Object.fromEntries(
        ['setup', 'build', 'test'].map((phase) => [
          phase,
          `actual=$(fixture-tool); test "$actual" = selected || { printf 'Expected selected tool, got %s\\n' "$actual" >&2; exit 1; }; test "$PWD" = "$FIXTURE_WORKSPACE" && test "$CUSTOM" = 'literal $() ; value' && printf '${phase} selected\\n'`,
        ]),
      );
      const scripts: string[] = [];
      const streamed: string[] = [];
      const buffered: string[][] = [];
      const run = (command: string[], env: Record<string, string>) => {
        const child = spawnSync(command[0] ?? '/bin/false', command.slice(1), {
          env,
          cwd: root,
          encoding: 'utf8',
          timeout: 5_000,
        });
        if (child.error) throw child.error;
        return { stdout: child.stdout, stderr: child.stderr, exitCode: child.status ?? 1 };
      };
      const fixture = makeStreamingClient((socket) => {
        socket.onopen?.({});
        const script = scripts.at(-1) ?? '';
        expect(script).toContain('#!/bin/sh');
        expect(script).not.toContain(scoped.CREDENTIAL);
        // The real provider allocates a new wrapper/receipt for every dispatch.
        const path = join(root, `stream-${streamed.length}.sh`);
        writeFileSync(path, script);
        streamed.push(script);
        const result = run(['/bin/sh', path], baseEnv);
        socket.emit({ type: 'stdout', data: Buffer.from(result.stdout).toString('base64') });
        socket.emit({ type: 'stderr', data: Buffer.from(result.stderr).toString('base64') });
        socket.emit({ type: 'exit_code', exitCode: result.exitCode });
      });
      // The fake provider has no container filesystem namespace. Translate its
      // logical /workspace to our private fixture directory before the real Azure
      // adapter stages its unmodified wrapper; never require a host /workspace.
      const execStream = fixture.client.execStream.bind(fixture.client);
      vi.spyOn(fixture.client, 'execStream').mockImplementation((id, command, options) => {
        expect(options?.cwd).toBe('/workspace');
        return execStream(id, command, { ...options, cwd: root });
      });
      vi.spyOn(fixture.client, 'writeFile').mockImplementation(async (_id, _path, body) => {
        scripts.push(String(body));
      });
      vi.spyOn(fixture.client, 'exec').mockImplementation(async (_id, command, options) => {
        buffered.push(command);
        // Only configured validation commands run locally. Engine-owned reset,
        // permissions and staging are acknowledged; never reset this checkout.
        if (command.join(' ').includes('fixture-tool')) {
          expect(options?.cwd).toBe('/workspace');
          return run(command, { ...baseEnv, ...options?.env });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const sandbox = new SandboxContainerManager(fixture.client, logger);
      const routing = new RoutingContainerManager({
        local: sandbox,
        sandbox,
        resolveTarget: () => 'sandbox',
      });
      const db = createTestDb();
      const { services } = createTestConfiguration(db);
      const launch = await resolveLaunch(
        { repositoryId: 'repo-a', task: 'Toolchain parity' },
        services,
      );
      if (!launch.repository) throw new Error('Fixture requires a repository');
      Object.assign(launch.repository.setup, {
        validationSetupCommand: commands.setup,
        buildCommand: commands.build,
        testCommand: commands.test,
        buildEnv: {
          ...Object.fromEntries(Object.entries(literals).map(([key, value]) => [key, { value }])),
          CREDENTIAL: { secretId: 'fixture-secret' },
        },
      });
      launch.workflow.validationPhases = ['setup', 'build', 'test'];
      const bridge = createSessionBridge({
        podManager: {
          touchHeartbeat() {},
          getSession: () => ({
            id: 'fixture',
            profileName: 'fixture',
            launchConfigDigest: launch.digest,
            containerId: 'sbx-1',
            executionTarget: 'sandbox',
          }),
          getLaunchConfiguration: () => launch,
          getValidationEnvironment: async () => scoped,
        },
        profileStore: {
          get: () => {
            throw new Error('Frozen self-validation cannot read a live profile');
          },
        },
        containerManagerFactory: { get: () => sandbox },
        eventBus: { emit() {} },
        logger,
      } as unknown as SessionBridgeDependencies);
      const config: ValidationEngineConfig = {
        podId: 'fixture',
        containerId: 'sbx-1',
        executionTarget: 'sandbox',
        previewUrl: '',
        startCommand: '',
        healthPath: '',
        healthTimeout: 1,
        smokePages: [],
        attempt: 1,
        task: 'toolchain parity',
        diff: '',
        hasWebUi: false,
        validationSetupCommand: commands.setup,
        buildCommand: commands.build ?? '',
        testCommand: commands.test,
        extraExecEnv: scoped,
        nonSecretExecEnv: literals,
        skipPhases: ['review'],
      };
      try {
        for (const phase of ['setup', 'build', 'tests'] as const) {
          const result = await bridge.runValidationPhase('fixture', phase);
          expect(result, JSON.stringify(result)).toMatchObject({ passed: true });
        }
        const selectedPath = scoped.PATH;
        scoped.PATH = baseEnv.PATH;
        expect(await bridge.runValidationPhase('fixture', 'setup')).toMatchObject({
          passed: false,
        });
        scoped.PATH = selectedPath;
        const engine = createLocalValidationEngine(routing, logger);
        const result = await engine.validate(config);
        expect(result.setup?.status, JSON.stringify(result.setup)).toBe('pass');
        expect(result.smoke.build.status).toBe('pass');
        expect(result.test?.status).toBe('pass');
        expect(streamed).toHaveLength(7);
        // Revalidation preserves the same selection; no source/checkpoint rules change.
        expect((await engine.validate({ ...config, attempt: 2 })).overall).toBe('pass');
        const beforeFailure = streamed.length;
        const failed = await engine.validate({
          ...config,
          nonSecretExecEnv: { ...literals, PATH: baseEnv.PATH },
        });
        expect(failed.setup?.status).toBe('fail');
        expect(streamed).toHaveLength(beforeFailure + 1);
        expect(
          (await engine.validate({ ...config, nonSecretExecEnv: undefined })).setup?.status,
        ).toBe('fail');
        expect(
          (
            await engine.validate({
              ...config,
              validationSetupCommand: 'true',
              buildCommand: '',
              testCommand: null,
              extraExecEnv: undefined,
              nonSecretExecEnv: undefined,
            })
          ).overall,
        ).toBe('pass');
        expect(
          buffered.filter((command) => command.join(' ').includes('fixture-tool')),
        ).toHaveLength(0);
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('collects a six-minute observed test exit through the real sandbox streaming seam', async () => {
    vi.useFakeTimers();
    try {
      const { client, sockets, requests } = makeStreamingClient(
        (socket) => {
          socket.onopen?.({});
          socket.emit({ type: 'stdout', data: Buffer.from('tests started\n').toString('base64') });
          setTimeout(() => {
            socket.emit({
              type: 'stdout',
              data: Buffer.from('tests complete\n').toString('base64'),
            });
            socket.emit({ type: 'exit_code', exitCode: 0 });
          }, 360_000);
        },
        [{ status: 200, body: { stdout: '', stderr: '', exitCode: 0 } }, ...STREAM_SETUP_RESPONSES],
      );
      const engine = createLocalValidationEngine(new SandboxContainerManager(client, logger));
      const resultPromise = engine.validate({
        podId: 'seam-pod',
        containerId: 'sbx-1',
        previewUrl: '',
        buildCommand: '',
        startCommand: '',
        healthPath: '',
        healthTimeout: 1,
        smokePages: [],
        attempt: 1,
        task: 'Test streaming result collection',
        diff: '',
        hasWebUi: false,
        executionTarget: 'sandbox',
        testCommand: 'npm test',
        skipPhases: ['review'],
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(360_000);
      const result = await resultPromise;
      expect(result.test?.status).toBe('pass');
      expect(result.test?.duration).toBeGreaterThanOrEqual(360_000);
      expect(result.test?.stdout).toContain('tests complete');
      expect(
        requests
          .filter((request) => request.url.includes('executeShellCommand'))
          .some((request) => String(request.init?.body).includes('npm test')),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('executes buffered shell commands and maps the response', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { stdout: 'out', stderr: 'err', exitCode: 7 } },
    ]);

    const result = await client.exec('sbx-1', ['sh', '-lc', 'echo "$FOO"'], {
      cwd: '/workspace',
      env: { FOO: "a'b" },
      timeoutMs: 5000,
      user: 'root',
    });

    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 7 });
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/executeShellCommand');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({
      command: "env FOO='a'\\''b' sh -lc 'echo \"$FOO\"'",
      workingDirectory: '/workspace',
      user: 'root',
    });
  });

  it('uses one bounded Azure execution for the private collector, with the exact worker user and no redirect', async () => {
    const commit = 'a'.repeat(40);
    const tree = 'b'.repeat(40);
    // Test the transport handoff only; real PACK verification is a separate gate.
    const bundle = Buffer.from('private transport fixture');
    const { client, requests } = makeClient([
      {
        status: 200,
        body: { output: `${commit}\n${tree}\n${bundle.toString('base64')}\n`, exit_code: 0 },
      },
    ]);
    const manager = new SandboxContainerManager(client, logger);
    const assertCurrent = vi.fn();
    await expect(
      collectPrivateHead(manager, 'sbx-1', 'fixture-repo', 1024, assertCurrent),
    ).resolves.toEqual({ commit, tree, bundle });
    expect(requests).toHaveLength(1);
    const request = requests[0] ?? failRequest();
    expect(request.url).toContain('/sandboxes/sbx-1/executeShellCommand');
    expect(request.init?.redirect).toBe('error');
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    expect(jsonBody(request)).toMatchObject({
      user: 'autopod',
      command: expect.stringContaining('/repositories/fixture-repo'),
    });
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it.each([
    { stdout: 'éé', stderr: 'bar', exitCode: 0 },
    { stdout: 'OK' },
    { stdout: 'OK', exitCode: -1 },
    { stdout: 'OK', exitCode: 0, exit_code: 1 },
    { stdout: {}, exitCode: 0 },
  ])('rejects decoded byte overrun or malformed exit evidence without retry', async (body) => {
    const { client, requests } = makeClient([{ status: 200, body }]);
    await expect(client.exec('sbx-1', ['true'], { maxOutputBytes: 6 })).rejects.toMatchObject({
      code: 'EXEC_EXIT_UNVERIFIED',
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    302, 403, 429, 503,
  ])('refuses bounded exec HTTP %s without reading body or retrying', async (status) => {
    const cancelled = vi.fn();
    const fetch = vi.fn(
      async () => new Response(new ReadableStream({ cancel: cancelled }), { status }),
    );
    const { client } = makeClient([], { fetch });
    await expect(client.exec('sbx-1', ['true'], { maxOutputBytes: 64 })).rejects.toMatchObject({
      code: 'EXEC_EXIT_UNVERIFIED',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels the response stream as soon as the wire envelope exceeds its cap', async () => {
    const cancelled = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8192));
            },
            cancel: cancelled,
          }),
          { status: 200 },
        ),
    );
    const { client } = makeClient([], { fetch });
    await expect(client.exec('sbx-1', ['true'], { maxOutputBytes: 64 })).rejects.toMatchObject({
      code: 'EXEC_EXIT_UNVERIFIED',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('keeps the deadline active until the complete response body arrives', async () => {
    let keepEventLoopAlive: ReturnType<typeof setTimeout> | undefined;
    const fetch = vi.fn(
      async (_url: string | URL, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from('{"exitCode":0,"stdout":"'));
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              });
              keepEventLoopAlive = setTimeout(() => controller.close(), 1000);
            },
          }),
        ),
    );
    const { client } = makeClient([], { fetch });
    try {
      await expect(
        client.exec('sbx-1', ['true'], { maxOutputBytes: 64, timeoutMs: 30 }),
      ).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
    } finally {
      clearTimeout(keepEventLoopAlive);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains an unknown buffered execution outcome after fetch failure without replay', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { client } = makeClient([], { fetch });
    await expect(client.exec('sbx-1', ['npm', 'test'])).rejects.toMatchObject({
      code: 'EXEC_EXIT_UNVERIFIED',
      statusCode: 409,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('allows a slow successful setup probe within its sandbox transport budget', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve(new Response(JSON.stringify({ exitCode: 0, stdout: 'tracked-file' })));
            }, 8_000);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      );
      const { client } = makeClient([], { fetch });
      const result = client.exec('sbx-1', ['git', 'ls-files'], { timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(result).resolves.toMatchObject({ exitCode: 0, stdout: 'tracked-file' });
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains sanitized timeout diagnostics and never replays an unknown buffered exit', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn');
    try {
      const fetch = vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('secret timeout details', 'AbortError'));
            });
          }),
      );
      const { client } = makeClient([], { fetch });
      const result = client
        .exec('sbx-1', ['secret-command'], {
          timeoutMs: 60_000,
          env: { SECRET: 'secret-value' },
        })
        .catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await result;
      expect(error).toMatchObject({
        code: 'EXEC_EXIT_UNVERIFIED',
        statusCode: 409,
        transport: {
          operation: 'exec',
          sandboxId: 'sbx-1',
          operationId: expect.any(String),
          failure: 'timeout',
          timeoutMs: 60_000,
          elapsedMs: 60_000,
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { transport: expect.objectContaining({ failure: 'timeout', elapsedMs: 60_000 }) },
        expect.any(String),
      );
      expect(JSON.stringify({ error, logs: warn.mock.calls })).not.toContain('secret');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { status: 503, rawText: 'secret Azure response', failure: 'http' },
    { status: 200, rawText: '{secret invalid JSON', failure: 'invalid_response' },
  ])('preserves bounded response diagnostics for $failure without leaking bodies or headers', async ({
    status,
    rawText,
    failure,
  }) => {
    const requestId = '0d844c84-f4e1-4ccc-b8dd-d0e7fbf8179a';
    const { client, requests } = makeClient([
      {
        status,
        rawText,
        headers: {
          'x-ms-request-id': requestId,
          'x-ms-correlation-request-id': 'secret-header-value',
          'request-id': 'Bearer secret',
          authorization: 'Bearer secret',
        },
      },
    ]);
    const error: unknown = await client
      .exec('sbx-1', ['secret-command'])
      .catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'EXEC_EXIT_UNVERIFIED',
      statusCode: 409,
      transport: {
        operation: 'exec',
        failure,
        responseStatus: status,
        responseHeaders: { 'x-ms-request-id': requestId },
      },
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('distinguishes network and credential failures without retaining raw causes', async () => {
    const network = makeClient([], {
      fetch: async () => {
        throw new TypeError('secret URL');
      },
    });
    const auth = makeClient([], {
      credential: {
        getToken: async () => {
          throw new Error('secret credential');
        },
      },
    });
    for (const [fixture, failure] of [
      [network, 'network'],
      [auth, 'pre_dispatch'],
    ] as const) {
      const error: unknown = await fixture.client
        .exec('sbx-1', ['secret-command'])
        .catch((err: unknown) => err);
      expect(error).toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED', transport: { failure } });
      expect(JSON.stringify(error)).not.toContain('secret');
      expect(error).not.toHaveProperty('cause');
    }
    expect(auth.requests).toHaveLength(0);
  });

  it('identifies credential timeouts as pre-dispatch authentication failures without sending exec', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn();
      const { client } = makeClient([], {
        fetch,
        credential: { getToken: () => new Promise(() => {}) },
      });
      const result = client
        .exec('sbx-1', ['test'], { timeoutMs: 60_000 })
        .catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({
        code: 'EXEC_EXIT_UNVERIFIED',
        transport: { failure: 'authentication', dispatchAttempted: false, elapsedMs: 30_000 },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves explicit buffered exec refusals without converting them into unknown exits', async () => {
    const { client, requests } = makeClient([{ status: 403, body: { error: 'denied' } }]);
    await expect(client.exec('sbx-1', ['test'])).rejects.toMatchObject({
      code: 'AZURE_SANDBOX_HTTP_ERROR',
      statusCode: 403,
    });
    expect(requests).toHaveLength(1);
  });

  it('rejects buffered exec responses that omit the exit code', async () => {
    const { client } = makeClient([
      { status: 200, body: { stdout: 'partial output', stderr: '' } },
    ]);

    await expect(client.exec('sbx-1', ['npm', 'test'])).rejects.toMatchObject({
      code: 'AZURE_SANDBOX_EXEC_INVALID_RESPONSE',
      statusCode: 502,
    });
  });

  it.each([
    false,
    true,
  ])('never sends start after pre-open error or cancellation=%s', async (cancelled) => {
    const { client, sockets } = makeStreamingClient((socket) => {
      if (!cancelled) socket.onerror?.({});
      // A late open event must not dispatch a failed or cancelled operation.
      socket.onopen?.({});
    });
    const drain = async () => {
      for await (const _chunk of client.execStream('sbx-1', ['target'], {
        onCancelReady: cancelled
          ? (cancel) => {
              void cancel();
            }
          : undefined,
      })) {
        /* drain */
      }
    };
    await expect(drain()).rejects.toMatchObject({
      code: 'EXEC_NOT_DISPATCHED',
      nonDispatch: { boundary: 'before-start' },
    });
    expect(sockets[0]?.sent).toEqual([]);
  });

  it('stages a wrapper script then streams stdout/stderr and exit code over the exec WebSocket', async () => {
    const { client, sockets, wsUrls, wsHeaders, requests } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'stdout', data: Buffer.from('hello').toString('base64') });
      socket.emit({ type: 'stderr', data: Buffer.from('warn').toString('base64') });
      socket.emit({ type: 'exit_code', exitCode: 3 });
    });

    const chunks: SandboxExecChunk[] = [];
    for await (const chunk of client.execStream('sbx-1', ['echo', 'hello'], {
      cwd: '/workspace',
      env: { FOO: 'bar baz' },
    })) {
      chunks.push(chunk);
    }

    // The command is `execve`d as a single argv[0], so it is staged as an
    // executable wrapper script and the start frame execs that path.
    const writeReq = requests[0] ?? failRequest();
    expect(writeReq.url).toContain('/sandboxes/sbx-1/files');
    const scriptPath = new URL(writeReq.url).searchParams.get('path') ?? '';
    expect(scriptPath).toMatch(/^\/tmp\/\.autopod-execstream-\d+-\d+\.sh$/);
    expect(String(writeReq.init?.body)).toBe(
      [
        '#!/bin/sh',
        'if [ "${AUTOPOD_STREAM_SESSION:-}" != "1" ]; then',
        '  exec env AUTOPOD_STREAM_SESSION=1 setsid -w "$0"',
        'fi',
        'umask 077',
        'stat=$(cat /proc/$$/stat) || exit 1',
        'rest=${stat##*) }; set -- $rest',
        'start=$(printf \'%s\' "${20}")',
        '(set -C; printf \'%s %s\\n\' "$$" "$start" > "$0.pid") || exit 1',
        'if [ "$(id -u)" = "0" ]; then',
        "  exec env HOME=/home/autopod USER=autopod LOGNAME=autopod su -m -s /bin/sh autopod --session-command 'cd /workspace || exit 1\nexec echo hello'",
        'fi',
        'cd /workspace || exit 1',
        'exec echo hello',
        '',
      ].join('\n'),
    );
    // The files API writes the wrapper as root:0644, so it is chmod-ed executable as root.
    expect(jsonBody(requests[1] ?? failRequest())).toEqual({
      command: `chmod 0755 ${scriptPath}`,
      user: 'root',
    });

    expect(wsUrls).toEqual([
      'wss://management.swedencentral.azuredevcompute.io/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/autopod-spike/sandboxes/sbx-1/exec/stream',
    ]);
    expect(wsHeaders[0]).toEqual({ Authorization: 'Bearer test-token' });
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({
      type: 'start',
      start: {
        command: scriptPath,
        environment: { TERM: 'xterm-256color', LANG: 'C.UTF-8', FOO: 'bar baz' },
        tty: false,
        stdin: false,
        height: 24,
        width: 80,
      },
    });
    expect(chunks).toEqual([{ stdout: 'hello' }, { stderr: 'warn' }, { exitCode: 3 }]);
    expect(sockets[0]?.closed).toBe(true);
  });

  it('sends exec stdin frames over the native WebSocket when requested', async () => {
    const { client, sockets } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'exit_code', exitCode: 0 });
    });

    const chunks: SandboxExecChunk[] = [];
    for await (const chunk of client.execStream('sbx-1', ['cat'], {
      stdin: true,
      onStdinWriter: (write) => {
        write(Buffer.from('hello\n'));
      },
    })) {
      chunks.push(chunk);
    }

    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({
      type: 'start',
      start: {
        command: expect.stringMatching(/^\/tmp\/\.autopod-execstream-\d+-\d+\.sh$/),
        environment: { TERM: 'xterm-256color', LANG: 'C.UTF-8' },
        tty: false,
        stdin: true,
        height: 24,
        width: 80,
      },
    });

    expect(JSON.parse(sockets[0]?.sent[1] ?? '{}')).toEqual({
      type: 'stdin',
      data: Buffer.from('hello\n').toString('base64'),
    });
    expect(chunks).toEqual([{ exitCode: 0 }]);
  });

  it('cancels a streaming exec by killing its recorded process and closing the socket', async () => {
    let cancel: (() => Promise<void>) | undefined;
    const { client, sockets, requests } = makeStreamingClient(
      (socket) => {
        socket.onopen?.({});
      },
      [...STREAM_SETUP_RESPONSES, { status: 200, body: { stdout: '', stderr: '', exitCode: 0 } }],
    );
    const iterator = client
      .execStream('sbx-1', ['pi', 'rpc'], {
        stdin: true,
        onCancelReady: (callback) => {
          cancel = callback;
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));

    await cancel?.();

    await expect(pending).rejects.toThrow(/closed before reporting an exit code/);
    expect(sockets[0]?.closed).toBe(true);
    const killRequest = requests[2] ?? failRequest();
    const killBody = JSON.stringify(jsonBody(killRequest));
    expect(killBody).toMatch(/\.autopod-execstream-\d+-\d+\.sh\.pid/);
    expect(killBody).toContain('kill -TERM -');
    expect(killBody).toContain('kill -KILL -');
    expect(killBody).toContain('group_alive');
    expect(jsonBody(killRequest)).toMatchObject({ user: 'root' });
    expect(String((requests[0] ?? failRequest()).init?.body)).toContain('--session-command');
    expect(String((requests[0] ?? failRequest()).init?.body)).toContain('setsid -w "$0"');
  });

  it('rejects cancellation when a child survives process-group termination', async () => {
    let cancel: (() => Promise<void>) | undefined;
    const { client } = makeStreamingClient(
      (socket) => {
        socket.onopen?.({});
      },
      [...STREAM_SETUP_RESPONSES, { status: 200, body: { stdout: '', stderr: '', exitCode: 1 } }],
    );
    const iterator = client
      .execStream('sbx-1', ['pi', 'rpc'], {
        onCancelReady: (callback) => {
          cancel = callback;
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(cancel?.()).rejects.toThrow(/termination was not verified/);
    await expect(pending).rejects.toThrow(/closed before reporting an exit code/);
  });

  it('terminates the recorded process when a streaming exec times out', async () => {
    const { client, sockets, requests } = makeStreamingClient(
      (socket) => {
        socket.onopen?.({});
      },
      [...STREAM_SETUP_RESPONSES, { status: 200, body: { stdout: '', stderr: '', exitCode: 0 } }],
    );

    await expect(
      (async () => {
        for await (const _chunk of client.execStream('sbx-1', ['pi', 'rpc'], {
          timeoutMs: 1,
        })) {
          // No output is expected before timeout.
        }
      })(),
    ).rejects.toMatchObject({
      code: 'AZURE_SANDBOX_TIMEOUT',
      execution: { cause: 'timeout', timeoutMs: 1, cleanup: 'confirmed' },
    });

    expect(sockets[0]?.closed).toBe(true);
    const killBody = JSON.stringify(jsonBody(requests[2] ?? failRequest()));
    expect(killBody).toContain('kill -TERM');
    expect(killBody).toContain('kill -KILL');
  });

  it.each([
    409, 429,
  ])('reports timeout cleanup refusal %s without retry or observed exit', async (status) => {
    const { client, requests } = makeStreamingClient(
      (socket) => socket.onopen?.({}),
      [...STREAM_SETUP_RESPONSES, { status, body: { message: 'Concurrent exec unsupported' } }],
    );
    const chunks: SandboxExecChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.execStream('sbx-1', ['test'], { timeoutMs: 1 }))
          chunks.push(chunk);
      })(),
    ).rejects.toMatchObject({
      code: 'AZURE_SANDBOX_TIMEOUT',
      execution: { cause: 'timeout', cleanup: 'failed' },
    });
    expect(chunks.some((chunk) => chunk.exitCode !== undefined)).toBe(false);
    expect(requests).toHaveLength(3);
  });

  it.each([
    undefined,
    0,
    143,
    137,
  ])('waits for cleanup and preserves output/observed exit %s', async (observedExitCode) => {
    const { client, sockets } = makeStreamingClient((socket) => socket.onopen?.({}));
    const originalExec = client.exec.bind(client);
    let releaseCleanup: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    vi.spyOn(client, 'exec').mockImplementation(async (id, command, options) => {
      if (command[2]?.includes('pid_file=')) {
        cleanupStarted?.();
        await gate;
        sockets[0]?.emit({
          type: 'stdout',
          data: Buffer.from('FAIL during cleanup\n').toString('base64'),
        });
        if (observedExitCode !== undefined)
          sockets[0]?.emit({ type: 'exit_code', exitCode: observedExitCode });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return originalExec(id, command, options);
    });
    let settled = false;
    const chunks: SandboxExecChunk[] = [];
    const pending = (async () => {
      try {
        for await (const _chunk of client.execStream('sbx-1', ['test'], { timeoutMs: 1 })) {
          chunks.push(_chunk);
        }
      } finally {
        settled = true;
      }
    })();
    const rejection = expect(pending).rejects.toMatchObject({
      execution: {
        cause: 'timeout',
        cleanup: 'confirmed',
        ...(observedExitCode !== undefined ? { observedExitCode } : {}),
      },
    });
    await started;
    expect(settled).toBe(false);
    releaseCleanup?.();
    await rejection;
    expect(chunks.map((chunk) => chunk.stdout ?? '').join('')).toContain('FAIL during cleanup');
    expect(chunks.some((chunk) => chunk.exitCode !== undefined)).toBe(false);
  });

  it('does not accept an exit frame with a missing exit code as success', async () => {
    const { client } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.onmessage?.({ data: JSON.stringify({ type: 'exit_code' }) });
    }, STREAM_SETUP_RESPONSES);
    await expect(
      (async () => {
        for await (const _chunk of client.execStream('sbx-1', ['test'])) {
          /* drain */
        }
      })(),
    ).rejects.toThrow('invalid exit code');
  });

  it('fails the exec stream when the socket closes before an exit code', async () => {
    const { client } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'stdout', data: Buffer.from('partial').toString('base64') });
      socket.close();
    });

    const chunks: SandboxExecChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.execStream('sbx-1', ['sleep', '60'])) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toThrow(/closed before reporting an exit code/);
    expect(chunks).toEqual([{ stdout: 'partial' }]);
  });

  it.each([false, true])('retains safe close context after error event=%s', async (errorFirst) => {
    const { client, requests } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'stdout', data: Buffer.from('partial').toString('base64') });
      if (errorFirst) socket.onerror?.({ message: 'Bearer synthetic-secret' });
      socket.onclose?.({ code: 1011, reason: 'idle timeout' });
    });
    const chunks: SandboxExecChunk[] = [];
    let failure: unknown;
    try {
      for await (const chunk of client.execStream('sbx-1', ['private-command'], {
        env: { TOKEN: 'synthetic-secret' },
      }))
        chunks.push(chunk);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'AZURE_SANDBOX_EXEC_STREAM',
      transport: {
        operation: 'execStream',
        sandboxId: 'sbx-1',
        operationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        startSent: true,
        closeCode: 1011,
        closeReason: 'idle timeout',
      },
    });
    expect(chunks).toEqual([{ stdout: 'partial' }]);
    expect(requests).toHaveLength(2); // staging only; no replay, kill, or deletion
    expect(String(failure)).not.toMatch(/synthetic-secret|private-command/);
  });

  it('retains a late close after the caller received the error event', async () => {
    const { client, sockets } = makeStreamingClient((socket) => {
      // WHATWG close() is asynchronous; its close event may follow consumer failure.
      vi.spyOn(socket, 'close').mockImplementation(() => {});
      socket.onopen?.({});
      socket.onerror?.({ message: 'synthetic-secret' });
    });
    const error = await client
      .execStream('sbx-1', ['true'])
      .next()
      .catch((err: Error) => err);
    sockets[0]?.onclose?.({ code: 1012, reason: 'service restart' });
    expect(error).toMatchObject({
      transport: {
        errorEvent: true,
        closeCode: 1012,
        closeReason: 'service restart',
        closeSource: 'local',
      },
    });
    expect(String(error)).toContain('1012');
    expect(String(error)).not.toContain('synthetic-secret');
  });

  it.each([
    'Bearer synthetic-secret\nforged log',
    'wss://host/exec?sig=synthetic-secret',
    'token=synthetic-secret',
    'x'.repeat(100_000),
    '\u001b[31mhostile\u202e',
  ])('redacts arbitrary close reasons', async (reason) => {
    const { client } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.onclose?.({ code: 1006, reason });
    });
    const stream = client.execStream('sbx-1', ['true']);
    await expect(stream.next()).rejects.toMatchObject({
      transport: { closeCode: 1006, closeReason: '[redacted]' },
    });
  });

  it.each([
    undefined,
    -1,
    1000,
    1006,
    1011,
    65535,
    Number.NaN,
  ])('never treats close code %s as an observed process exit', async (code) => {
    const { client, requests } = makeStreamingClient((socket) => {
      socket.onclose?.({ code, reason: 'normal closure' });
    });
    const error = await client
      .execStream('sbx-1', ['true'])
      .next()
      .catch((err: Error) => err);
    expect(error).toMatchObject({
      code: 'EXEC_NOT_DISPATCHED',
      nonDispatch: { boundary: 'before-start' },
      cause: {
        transport: { startSent: false, closeSource: 'remote', closeReason: 'normal closure' },
      },
    });
    const diagnostic = (error as Error & { cause: { transport: { closeCode?: number } } }).cause
      .transport;
    expect(diagnostic.closeCode).toBe(
      code !== undefined && code >= 1000 && code <= 4999 ? code : undefined,
    );
    expect(requests).toHaveLength(2);
  });

  it('keeps transport logs bounded and credential-free', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      const { client } = makeStreamingClient((socket) => {
        socket.onopen?.({});
        socket.onclose?.({ code: 1011, reason: `Bearer synthetic-secret${'x'.repeat(100_000)}` });
      });
      await expect(
        client
          .execStream('sbx-1', ['secret-command'], {
            env: { TOKEN: 'synthetic-secret' },
          })
          .next(),
      ).rejects.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      const logged = JSON.stringify(warn.mock.calls[0]);
      expect(logged).not.toMatch(/synthetic-secret|secret-command|Authorization|wss:/);
      expect(logged.length).toBeLessThan(1000);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    JSON.stringify({ type: 'error', message: `Bearer synthetic-secret${'x'.repeat(100_000)}` }),
    '{"secret":"synthetic-secret", invalid',
  ])('does not include untrusted protocol data in errors', async (data) => {
    const { client } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.onmessage?.({ data });
    });
    const failure = await client
      .execStream('sbx-1', ['true'])
      .next()
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('synthetic-secret');
    expect(String(failure).length).toBeLessThan(1000);
  });

  it('fails the exec stream on an error frame', async () => {
    const { client } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'error', message: 'boom' });
    });

    const drained: SandboxExecChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.execStream('sbx-1', ['true'])) {
          drained.push(chunk);
        }
      })(),
    ).rejects.toThrow(/reported an error/);
    expect(drained).toEqual([]);
  });

  it('rejects streaming exec with a user option', async () => {
    const { client } = makeStreamingClient(() => {
      throw new Error('socket should not be created');
    });

    const drained: SandboxExecChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.execStream('sbx-1', ['true'], { user: 'root' })) {
          drained.push(chunk);
        }
      })(),
    ).rejects.toThrow(/cannot run as a specific user/);
    expect(drained).toEqual([]);
  });

  it('refuses terminal wrapper writes after authority changes during token acquisition', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const { client, requests } = makeClient([], {
      credential: {
        async getToken() {
          await gate;
          return { token: 'fixture-token', expiresOnTimestamp: Date.now() + 60000 };
        },
      },
    });
    const pending = client.attachTerminal('sbx-1', {
      cols: 80,
      rows: 24,
      assertCurrent: () => {
        if (held) throw new Error('Validation custody held');
      },
    });
    held = true;
    release();
    await expect(pending).rejects.toThrow('Validation custody held');
    expect(requests).toEqual([]);
  });

  it('does not send a terminal start frame when custody changes during socket connection', async () => {
    let held = false;
    const { client, sockets } = makeStreamingClient(() => {});
    const session = await client.attachTerminal('sbx-1', {
      cols: 80,
      rows: 24,
      assertCurrent: () => {
        if (held) throw new Error('Validation custody held');
      },
    });
    const socket = sockets[0];
    if (!socket) throw new Error('Missing staged terminal socket');
    const errors: Error[] = [];
    session.onError((error) => errors.push(error));
    held = true;
    socket.onopen?.({});
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
    expect(errors[0]?.message).toBe('Validation custody held');
  });

  it('opens an interactive TTY terminal session, proxying stdin/resize/output', async () => {
    const { client, sockets, requests } = makeStreamingClient((socket) => {
      socket.onopen?.({});
    });

    const session = await client.attachTerminal('sbx-1', {
      cols: 100,
      rows: 30,
      shellCommand: 'exec /bin/bash -l',
      env: { FOO: 'bar' },
    });

    // The shell one-liner is staged as an executable wrapper (writeFile + root chmod).
    const writeReq = requests[0] ?? failRequest();
    const scriptPath = new URL(writeReq.url).searchParams.get('path') ?? '';
    expect(scriptPath).toMatch(/^\/tmp\/\.autopod-execstream-\d+-\d+\.sh$/);
    expect(String(writeReq.init?.body)).toBe(
      [
        '#!/bin/sh',
        'if [ "$(id -u)" = "0" ]; then',
        "  exec env HOME=/home/autopod USER=autopod LOGNAME=autopod su -m -s /bin/sh autopod -c 'exec /bin/bash -l'",
        'fi',
        'exec /bin/bash -l',
        '',
      ].join('\n'),
    );
    expect(jsonBody(requests[1] ?? failRequest())).toEqual({
      command: `chmod 0755 ${scriptPath}`,
      user: 'root',
    });

    // The start frame runs the wrapper with a TTY and stdin enabled.
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({
      type: 'start',
      start: {
        command: scriptPath,
        environment: { TERM: 'xterm-256color', LANG: 'C.UTF-8', FOO: 'bar' },
        tty: true,
        stdin: true,
        height: 30,
        width: 100,
      },
    });

    const output: string[] = [];
    session.onData((chunk) => output.push(chunk.toString('utf-8')));
    let exitCode: number | undefined;
    session.onExit((code) => {
      exitCode = code;
    });

    session.write(Buffer.from('ls\n'));
    expect(JSON.parse(sockets[0]?.sent[1] ?? '{}')).toEqual({
      type: 'stdin',
      data: Buffer.from('ls\n').toString('base64'),
    });

    session.resize(120, 40);
    expect(JSON.parse(sockets[0]?.sent[2] ?? '{}')).toEqual({
      type: 'resize',
      width: 120,
      height: 40,
    });

    sockets[0]?.emit({ type: 'stdout', data: Buffer.from('hi').toString('base64') });
    sockets[0]?.emit({ type: 'stderr', data: Buffer.from('!').toString('base64') });
    expect(output).toEqual(['hi', '!']);

    sockets[0]?.emit({ type: 'exit_code', exitCode: 0 });
    expect(exitCode).toBe(0);
    expect(sockets[0]?.closed).toBe(true);
  });

  it('fences a file write after delayed auth and does not send stale bytes', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    let reached = false;
    const { client, requests } = makeClient([{ status: 204 }], {
      credential: {
        async getToken() {
          reached = true;
          await gate;
          return { token: 'fixture-token', expiresOnTimestamp: Date.now() + 60_000 };
        },
      },
    });
    const write = client.writeFile('original', '/tmp/source/chunk', Buffer.from('bundle'), {
      singleAttempt: true,
      beforeSend() {
        if (!current) throw new Error('STALE_SOURCE');
      },
    });
    await vi.waitFor(() => expect(reached).toBe(true));
    current = false;
    release();
    await expect(write).rejects.toThrow('STALE_SOURCE');
    expect(requests).toHaveLength(0);
  });
  it('does not replay an explicitly single-attempt file write after rate limiting', async () => {
    const { client, requests } = makeClient([
      { status: 429, body: { error: { code: 'Throttled' } } },
      { status: 204 },
    ]);
    await expect(
      client.writeFile('original', '/tmp/source/chunk', Buffer.from('bundle'), {
        singleAttempt: true,
      }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
  it('writes, reads, lists, stats files, and updates egress policy through the data plane', async () => {
    const { client, requests } = makeClient([
      { status: 204 },
      { status: 200, rawText: 'hello' },
      {
        status: 200,
        body: {
          path: '/tmp',
          entries: [
            {
              name: 'hello.txt',
              path: '/tmp/hello.txt',
              isDir: false,
              size: 5,
              mode: 420,
              modifiedTime: 1782467614,
            },
            {
              name: 'nested',
              path: '/tmp/nested',
              isDir: true,
              size: 4096,
              mode: 493,
              modifiedTime: 1782467614,
            },
          ],
        },
      },
      {
        status: 200,
        body: { name: 'hello.txt', path: '/tmp/hello.txt', isDir: false, size: 5 },
      },
      { status: 204 },
    ]);

    await client.writeFile('sbx-1', '/tmp/hello.txt', Buffer.from('hello'));
    const read = await client.readFile('sbx-1', '/tmp/hello.txt');
    const list = await client.listFiles('sbx-1', '/tmp');
    const stat = await client.statFile('sbx-1', '/tmp/hello.txt');
    await client.updateEgress('sbx-1', {
      defaultAction: 'Deny',
      hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
    });

    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/files');
    expect(requests[0]?.url).toContain('path=%2Ftmp%2Fhello.txt');
    expect(requests[0]?.url).toContain('createDirs=true');
    expect(read.toString('utf-8')).toBe('hello');
    expect(list.entries[0]?.path).toBe('/tmp/hello.txt');
    expect(list.entries[0]?.isDirectory).toBe(false);
    expect(list.entries[0]?.mode).toBe('420');
    expect(list.entries[0]?.modifiedAt).toBe('2026-06-26T09:53:34.000Z');
    expect(list.entries[1]?.isDirectory).toBe(true);
    expect(stat.path).toBe('/tmp/hello.txt');
    expect(stat.isDirectory).toBe(false);
    expect(requests[2]?.url).toContain('/sandboxes/sbx-1/files/list');
    expect(requests[2]?.url).toContain('path=%2Ftmp');
    expect(requests[3]?.url).toContain('/sandboxes/sbx-1/files/stat');
    expect(requests[3]?.url).toContain('path=%2Ftmp%2Fhello.txt');
    expect(requests[4]?.url).toContain('/sandboxes/sbx-1/egresspolicy');
    expect(jsonBody(requests[4] ?? failRequest())).toEqual({
      defaultAction: 'Deny',
      hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
    });
  });

  it('retries empty data-plane 403s through the retry budget for file writes', async () => {
    const { client, requests } = makeClient(
      [
        { status: 403, rawText: '', headers: { 'x-ms-request-id': 'request-first' } },
        { status: 403, rawText: '', headers: { 'x-ms-request-id': 'request-second' } },
        { status: 204 },
      ],
      { retry: { maxAttempts: 3, maxDelayMs: 0 } },
    );

    await client.writeFile('sbx-1', '/home/autopod/.claude.json', Buffer.from('{}'));

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.url.includes('/sandboxes/sbx-1/files'))).toBe(true);
  });

  it('aborts a bounded file write when the data plane stops responding', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_input: string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      });
      const client = new AzureSandboxApiClient(
        {
          subscriptionId: 'sub-1',
          resourceGroup: 'rg-1',
          location: 'swedencentral',
          sandboxGroup: 'autopod-spike',
          credential,
          fetch,
          assumeGroupExists: true,
        },
        logger,
      );

      const write = client.writeFile('sbx-1', '/run/dispatcher-pod/quota.json', Buffer.from('{}'), {
        timeoutMs: 3_000,
      });
      const rejection = expect(write).rejects.toThrow('timed out after 3000ms');
      await vi.advanceTimersByTimeAsync(3_000);
      await rejection;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a non-empty data-plane 403', async () => {
    const { client, requests } = makeClient([{ status: 403, body: { error: 'RBAC denied' } }], {
      retry: { maxDelayMs: 0 },
    });

    const error = await client.exec('sbx-1', ['true']).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AutopodError);
    expect(error).toMatchObject({ code: 'AZURE_SANDBOX_HTTP_ERROR', statusCode: 403 });
    expect(error).not.toBeInstanceOf(SandboxInfrastructureError);
    expect(requests).toHaveLength(1);
  });

  it('classifies exhausted empty data-plane 403 as retryable sandbox infrastructure', async () => {
    const { client, requests } = makeClient(
      [
        { status: 403, rawText: '' },
        { status: 403, rawText: '' },
        {
          status: 403,
          rawText: '',
          headers: {
            'x-ms-request-id': 'request-final',
            'x-ms-correlation-request-id': 'correlation-final',
            authorization: 'secret-that-must-not-appear',
          },
        },
      ],
      { retry: { maxAttempts: 3, maxDelayMs: 0 } },
    );

    const error = await client.exec('sbx-1', ['true']).catch((cause: unknown) => cause);

    expect(requests).toHaveLength(3);
    expect(error).toBeInstanceOf(SandboxInfrastructureError);
    expect(error).toMatchObject({
      code: 'AZURE_SANDBOX_TRANSIENT_FORBIDDEN',
      retryable: true,
      statusCode: 403,
      diagnostics: {
        'x-ms-request-id': 'request-final',
        'x-ms-correlation-request-id': 'correlation-final',
      },
    });
    expect(JSON.stringify(error)).not.toContain('secret-that-must-not-appear');
  });

  it('honors a data-plane 429 (retryAfterSeconds) and retries the request', async () => {
    const { client, requests } = makeClient(
      [
        {
          status: 429,
          body: {
            title: 'Rate limit exceeded',
            status: 429,
            detail: 'API request rate limit exceeded (limit 600 requests/min).',
            retryAfterSeconds: 30,
          },
        },
        { status: 200, rawText: 'hello-after-retry' },
      ],
      { retry: { maxDelayMs: 0 } },
    );

    const read = await client.readFile('sbx-1', '/tmp/hello.txt');

    expect(read.toString('utf-8')).toBe('hello-after-retry');
    // First attempt 429, retried once → 2 requests to the same files endpoint.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/files');
    expect(requests[1]?.url).toContain('/sandboxes/sbx-1/files');
  });

  it('retries a transient data-plane GET 503', async () => {
    const { client, requests } = makeClient(
      [
        { status: 503, rawText: 'upstream connect error' },
        { status: 200, rawText: 'file-after-retry' },
      ],
      { retry: { maxDelayMs: 0 } },
    );

    const read = await client.readFile('sbx-1', '/workspace/file.ts');

    expect(read.toString('utf-8')).toBe('file-after-retry');
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.init?.method === 'GET')).toBe(true);
  });

  it('stops retrying transient data-plane GET 503 after the configured budget', async () => {
    const unavailable = () => ({ status: 503, rawText: 'connection termination' });
    const { client, requests } = makeClient([unavailable(), unavailable(), unavailable()], {
      retry: { maxAttempts: 3, maxDelayMs: 0 },
    });

    await expect(client.readFile('sbx-1', '/workspace/file.ts')).rejects.toThrow(/503/);

    expect(requests).toHaveLength(3);
  });

  it('does not retry a data-plane write after 503', async () => {
    const { client, requests } = makeClient([{ status: 503, rawText: 'connection termination' }], {
      retry: { maxDelayMs: 0 },
    });

    await expect(
      client.writeFile('sbx-1', '/workspace/file.ts', Buffer.from('content')),
    ).rejects.toThrow(/503/);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe('PUT');
  });

  it('honors the Retry-After header when the body has no retryAfterSeconds', async () => {
    const { client, requests } = makeClient(
      [
        { status: 429, rawText: 'slow down', headers: { 'retry-after': '1' } },
        { status: 200, body: { path: '/tmp', entries: [] } },
      ],
      { retry: { maxDelayMs: 0 } },
    );

    const list = await client.listFiles('sbx-1', '/tmp');
    expect(list.entries).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('gives up after the retry budget is exhausted on persistent 429s', async () => {
    const rateLimited = () => ({
      status: 429,
      body: { status: 429, retryAfterSeconds: 30 },
    });
    const { client, requests } = makeClient([rateLimited(), rateLimited(), rateLimited()], {
      retry: { maxAttempts: 3, maxDelayMs: 0 },
    });

    await expect(client.readFile('sbx-1', '/tmp/hello.txt')).rejects.toThrow(/429/);
    // maxAttempts=3 → 3 tries then throw (no infinite loop).
    expect(requests).toHaveLength(3);
  });

  it('exposes an Entra-gated port and maps the returned public URL', async () => {
    const { client, requests } = makeClient([
      {
        status: 200,
        body: {
          port: 3000,
          protocol: 'Http',
          url: 'https://sbx-1-3000.swedencentral.azurecontainerapps.io',
        },
      },
    ]);

    const exposed = await client.addPort('sbx-1', 3000, {
      mode: 'entra',
      emails: ['ewi@projectum.com'],
    });

    expect(exposed).toEqual({
      port: 3000,
      hostPort: undefined,
      protocol: 'Http',
      url: 'https://sbx-1-3000.swedencentral.azurecontainerapps.io',
    });
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/ports/add');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({
      port: 3000,
      auth: { entraId: { enabled: true, emails: ['ewi@projectum.com'] } },
    });
  });

  it('exposes an anonymous port when explicitly opted in', async () => {
    const { client, requests } = makeClient([
      { status: 201, body: { port: 8080, url: 'https://x' } },
    ]);

    await client.addPort('sbx-1', 8080, { mode: 'anonymous' });

    expect(jsonBody(requests[0] ?? failRequest())).toEqual({
      port: 8080,
      auth: { anonymous: true },
    });
  });

  it('omits auth when none is given (platform default) and removes ports idempotently', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { port: 3000, url: 'https://y' } },
      { status: 404 },
    ]);

    await client.addPort('sbx-1', 3000);
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({ port: 3000 });

    await expect(client.removePort('sbx-1', 3000)).resolves.toBeUndefined();
    expect(requests[1]?.url).toContain('/sandboxes/sbx-1/ports/remove');
    expect(jsonBody(requests[1] ?? failRequest())).toEqual({ port: 3000 });
  });

  it('creates a snapshot and returns its id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'snap-1' } }]);

    const snapshot = await client.createSnapshot('sbx-1', 'warm-node22');

    expect(snapshot).toEqual({ id: 'snap-1' });
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/snapshot');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({ labels: { name: 'warm-node22' } });
  });

  it('provisions a sandbox from a snapshot with only sourcesRef, polling to Running', async () => {
    const { client, requests } = makeClient(
      [
        { status: 200, body: { id: 'sbx-2', state: 'Creating' } }, // PUT sandboxes
        { status: 200, body: { id: 'sbx-2', state: 'Running' } }, // poll
      ],
      { assumeGroupExists: true },
    );

    const id = await client.createFromSnapshot('snap-1');

    expect(id).toBe('sbx-2');
    const putReq = requests[0] ?? failRequest();
    expect(putReq.url).toContain('/sandboxGroups/autopod-spike/sandboxes');
    expect(jsonBody(putReq)).toEqual({
      sourcesRef: { snapshot: { id: 'snap-1' } },
      // managedBy is the ownership mark the orphan reaper gates on — a
      // snapshot-warm-started sandbox without it can never be reaped.
      labels: { purpose: 'autopod-sandbox', managedBy: 'autopod' },
    });
  });

  it('deletes a snapshot idempotently', async () => {
    const { client, requests } = makeClient([{ status: 404 }]);

    await expect(client.deleteSnapshot('snap-1')).resolves.toBeUndefined();
    expect(requests[0]?.url).toContain('/sandboxGroups/autopod-spike/snapshots/snap-1');
  });

  it('reports a deleted sandbox distinctly from stopped and unknown', async () => {
    const { client, requests } = makeClient([{ status: 404 }]);

    await expect(client.getStatus('sbx-deleted')).resolves.toBe('deleted');
    expect(requests[0]?.url).toContain('/sandboxes/sbx-deleted');
  });

  it('treats existing directories as successful mkdirs', async () => {
    const { client, requests } = makeClient([
      { status: 409, body: { title: 'FileAlreadyExists', detail: 'directory already exists' } },
    ]);

    await expect(client.mkdir('sbx-1', '/mnt')).resolves.toBeUndefined();

    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/files/mkdir');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({ path: '/mnt' });
  });

  it('destroys sandbox without deleting reusable disk images', async () => {
    const { client, requests } = makeClient([
      { status: 202, body: {} },
      { status: 404, body: {} },
    ]);

    await client.destroy('sbx-1');

    expect(requests.map((request) => request.init?.method)).toEqual(['DELETE', 'GET']);
    expect(requests.some((request) => request.url.includes('/diskimages/'))).toBe(false);
  });
});

function failRequest(): CapturedRequest {
  throw new Error('missing request');
}

function diskImageLabelsFor(image: string, sourceDigest: string): Record<string, string> {
  const sourceImageHash = testHash(image, 16);
  const name = `autopod-${sourceImageHash}-${testHash(sourceDigest, 12)}`;
  return {
    managedBy: 'autopod',
    name,
    sourceImageHash,
    sourceDigest,
  };
}

function testHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

it.each([
  'array',
  'value',
  'items',
])('managed discovery supports %s without duplicating identity', async (shape) => {
  const row = {
    id: 'sandbox-one',
    labels: { podId: 'managed-one', executionSpecDigest: `sha256:${'a'.repeat(64)}` },
  };
  const body = shape === 'array' ? [row] : { [shape]: [row] };
  const { client, requests } = makeClient([{ status: 200, body }]);
  expect(await client.findManagedSandbox('managed-one', `sha256:${'a'.repeat(64)}`)).toBe(
    'sandbox-one',
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.init?.method).toBe('GET');
});
it.each([
  null,
  {},
  { value: [], nextLink: 'more' },
  [null],
  [{ id: 'one', labels: { podId: 'managed-one', executionSpecDigest: 'other' } }],
  [
    {
      id: 'one',
      labels: { podId: 'managed-one', executionSpecDigest: `sha256:${'a'.repeat(64)}` },
    },
    {
      id: 'two',
      labels: { podId: 'managed-one', executionSpecDigest: `sha256:${'a'.repeat(64)}` },
    },
  ],
])('managed discovery fails closed on unknown, truncated or conflicting responses', async (body) => {
  const { client } = makeClient([{ status: 200, body }]);
  await expect(
    client.findManagedSandbox('managed-one', `sha256:${'a'.repeat(64)}`),
  ).rejects.toThrow();
});

it('managed image staging refuses a mutable tag before any credential or network effects', async () => {
  const { client, requests } = makeClient([]);
  await expect(client.prepareManagedImage('registry/image:latest')).rejects.toThrow(
    'digest-required',
  );
  expect(requests).toEqual([]);
});

it('managed create uses a lossless label-safe digest and restart discovery accepts it', async () => {
  const digest = `sha256:${'f'.repeat(64)}`;
  const { client, requests } = makeClient(
    [
      { status: 200, body: [] },
      { status: 200, body: { id: 'disk' } },
      { status: 200, body: { id: 'disk', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'sandbox' } },
      { status: 200, body: { id: 'sandbox', state: 'Running' } },
    ],
    { assumeGroupExists: true },
  );
  await client.createSandbox({
    image: `registry.example/image@sha256:${'b'.repeat(64)}`,
    podId: 'managed-one',
    managedSpecDigest: digest,
    tier: 'S',
    egressPolicy: { defaultAction: 'Deny', hostRules: [] },
  });
  const create = requests.find((r) => r.url.includes('/sandboxes?'));
  const label = JSON.parse(String(create?.init?.body)).labels.executionSpecDigest;
  expect(label).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,61}[A-Za-z0-9]$/);
  expect(Buffer.from(label.slice(1, -1), 'base64url').toString('hex')).toBe(digest.slice(7));
  const restart = makeClient([
    {
      status: 200,
      body: [{ id: 'sandbox', labels: { podId: 'managed-one', executionSpecDigest: label } }],
    },
  ]).client;
  expect(await restart.findManagedSandbox('managed-one', digest)).toBe('sandbox');
  const conflict = makeClient([
    {
      status: 200,
      body: [{ id: 'sandbox', labels: { podId: 'managed-one', executionSpecDigest: label } }],
    },
  ]).client;
  await expect(
    conflict.findManagedSandbox('managed-one', `sha256:${'e'.repeat(64)}`),
  ).rejects.toThrow('identity-conflict');
});
it('invalid managed digest is refused before credentials or creation', async () => {
  const { client, requests } = makeClient([]);
  await expect(
    client.createSandbox({
      image: 'image',
      podId: 'managed-one',
      managedSpecDigest: 'invalid',
      tier: 'S',
      egressPolicy: { defaultAction: 'Deny', hostRules: [] },
    }),
  ).rejects.toThrow('invalid-managed-spec-digest');
  expect(requests).toHaveLength(0);
});

it('managed Full inspection is sent and read back before acceptance', async () => {
  const policy = {
    defaultAction: 'Deny' as const,
    hostRules: [],
    trafficInspection: 'Full' as const,
  };
  const { client, requests } = makeClient([
    { status: 204 },
    { status: 200, body: { egressPolicy: policy } },
  ]);
  await client.updateEgress('one', policy);
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    defaultAction: 'Deny',
    trafficInspection: 'Full',
  });
  expect(requests[1]?.init?.method).toBe('GET');
  expect(requests[1]?.url).not.toContain('/egresspolicy');
});
it.each([
  { defaultAction: 'Deny', trafficInspection: 'None' },
  { defaultAction: 'Allow', trafficInspection: 'Full' },
  {
    defaultAction: 'Deny',
    trafficInspection: 'Full',
    hostRules: [{ pattern: '*', action: 'Allow' }],
  },
])('managed egress readback drift fails closed', async (body) => {
  const { client } = makeClient([{ status: 204 }, { status: 200, body: { egressPolicy: body } }]);
  await expect(
    client.updateEgress('one', { defaultAction: 'Deny', hostRules: [], trafficInspection: 'Full' }),
  ).rejects.toThrow('egress-unconfirmed');
});

describe('observed sandbox allocation', () => {
  it('does not let compute sampling settle lifecycle wakeup claims', async () => {
    const fixture = createSandboxWakeupFixture();
    const observeRunning = vi.spyOn(fixture.journal, 'observeRunning');
    const observeCompute = vi.fn();
    const { client } = makeClient(
      [
        {
          status: 200,
          body: { id: 'observed', state: 'Running', resources: { cpu: '2', memory: '4Gi' } },
        },
      ],
      { wakeupJournal: fixture.journal, observeCompute },
    );
    await client.sampleCompute('observed');
    expect(observeCompute).toHaveBeenCalledOnce();
    expect(observeRunning).not.toHaveBeenCalled();
  });
  it('reuses state and allocation in one response without letting accounting block status', async () => {
    const body = { id: 'observed', state: 'Running', resources: { cpu: '2', memory: '4Gi' } };
    const observeCompute = vi.fn(() => {
      throw new Error('accounting storage unavailable');
    });
    const { client, requests } = makeClient([{ status: 200, body }], { observeCompute });
    expect(await client.getStatus('observed')).toBe('running');
    expect(observeCompute).toHaveBeenCalledWith('observed', body);
    expect(requests).toHaveLength(1);
  });

  it('does not settle compute on DELETE 202, and reuses confirmed terminal observations', async () => {
    const observeCompute = vi.fn();
    const { client, requests } = makeClient(
      [
        { status: 202, body: {} },
        {
          status: 200,
          body: { id: 'observed', state: 'Running', resources: { cpu: '2', memory: '4Gi' } },
        },
        { status: 404, body: {} },
      ],
      { observeCompute },
    );
    await client.destroy('observed');
    expect(observeCompute.mock.calls.map((call) => call[1]?.state ?? 'terminal')).toEqual([
      'Running',
      'terminal',
    ]);
    expect(requests.map((request) => request.init?.method)).toEqual(['DELETE', 'GET', 'GET']);
  });

  it('breaks coverage when a lifecycle observation fails', async () => {
    const observeCompute = vi.fn();
    const { client } = makeClient([{ status: 500, body: { error: 'failed observation' } }], {
      observeCompute,
      retry: { maxAttempts: 1 },
    });
    await expect(client.getStatus('observed')).rejects.toThrow();
    expect(observeCompute).toHaveBeenCalledWith('observed', { id: 'observed', state: 'Unknown' });
  });

  it.each([
    ['2000m', '4096Mi', 2, 4294967296],
    ['0.5', '4Gi', 0.5, 4294967296],
    ['0', '0Gi', null, null],
    ['Infinity', '9007199254740992Gi', null, null],
    ['-2', '4GB', null, null],
  ])('decodes provider quantities %s / %s without guessing', async (cpu, memory, cpuLimit, memoryLimitBytes) => {
    const { client, requests } = makeClient([
      {
        status: 200,
        body: {
          id: 'observed',
          state: 'Running',
          resources: { cpu, memory },
        },
      },
    ]);
    expect(await client.getResourceAllocation('observed')).toEqual({
      cpuLimit,
      memoryLimitBytes,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe('GET');
  });

  it.each([
    { id: 'other', state: 'Running', resources: { cpu: '2', memory: '4Gi' } },
    { id: 'observed', state: 'Suspended', resources: { cpu: '2', memory: '4Gi' } },
    { id: 'observed', resources: { cpu: '2', memory: '4Gi' } },
    { id: 'observed', state: 'Running' },
  ])('does not invent allocation from missing or mismatched live identity', async (body) => {
    const { client } = makeClient([{ status: 200, body }]);
    expect(await client.getResourceAllocation('observed')).toEqual({
      cpuLimit: null,
      memoryLimitBytes: null,
    });
  });
});

it('pins the imported image to the digest resolved before creation', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const { client, requests } = makeClient(
    [
      { status: 200, body: { value: [] } },
      { status: 200, body: { id: 'disk-pinned', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'disk-pinned', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'sandbox-pinned', state: 'Running' } },
      { status: 200, body: { id: 'sandbox-pinned', state: 'Running' } },
    ],
    {
      assumeGroupExists: true,
      registryCredentials: { username: 'fixture', token: 'fixture' },
      resolveImageDigest: async () => digest,
    },
  );
  await client.createSandbox({
    image: 'registry.test:5000/team/image:latest',
    tier: 'L',
    env: {},
    egressPolicy: { defaultAction: 'Deny', hostRules: [] },
  });
  expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
    image: { base: `registry.test:5000/team/image@${digest}` },
  });
});

it('does not reuse a mutable import carrying a resolved digest label', async () => {
  const image = 'registry.test/team/image:latest';
  const digest = `sha256:${'a'.repeat(64)}`;
  const old = {
    id: 'mutable-import',
    image: { base: image },
    labels: diskImageLabelsFor(image, digest),
    status: { state: 'Ready' },
  };
  const { client, requests } = makeClient(
    [
      { status: 200, body: { value: [old] } },
      { status: 200, body: { id: 'pinned-import', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'pinned-import', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'sandbox', state: 'Running' } },
      { status: 200, body: { id: 'sandbox', state: 'Running' } },
    ],
    {
      assumeGroupExists: true,
      registryCredentials: { username: 'fixture', token: 'fixture' },
      resolveImageDigest: async () => digest,
    },
  );
  await client.createSandbox({
    image,
    tier: 'L',
    env: {},
    egressPolicy: { defaultAction: 'Deny', hostRules: [] },
  });
  expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
    image: { base: `registry.test/team/image@${digest}` },
  });
  expect(jsonBody(requests[3] ?? failRequest())).toMatchObject({
    sourcesRef: { diskImage: { id: 'pinned-import' } },
  });
  expect(requests.some((request) => request.init?.method === 'DELETE')).toBe(false);
});

it('rejects a malformed resolved digest before creating any resource', async () => {
  const { client, requests } = makeClient([], {
    resolveImageDigest: async () => 'sha256:invalid',
    assumeGroupExists: true,
  });
  await expect(
    client.createSandbox({
      image: 'registry.test/image:latest',
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Deny', hostRules: [] },
    }),
  ).rejects.toMatchObject({ code: 'AZURE_SANDBOX_IMAGE_DIGEST' });
  expect(requests).toHaveLength(0);
});

describe('listSandboxes', () => {
  it('lists the group and normalizes labels, state and creation time', async () => {
    const { client, requests } = makeClient([
      {
        status: 200,
        body: [
          {
            id: 'sandbox-a',
            state: 'Running',
            createdAt: '2026-09-01T10:00:00Z',
            labels: { managedBy: 'autopod', podId: 'pod-a' },
          },
          {
            id: 'sandbox-b',
            properties: {
              state: 'Stopped',
              createdAt: '2026-08-20T09:00:00Z',
              labels: { phase5Role: 'broker' },
            },
          },
        ],
      },
    ]);

    const sandboxes = await client.listSandboxes();

    expect(requests[0]?.init?.method).toBe('GET');
    expect(requests[0]?.url).toContain(
      '/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/autopod-spike/sandboxes',
    );
    expect(sandboxes).toEqual([
      {
        id: 'sandbox-a',
        state: 'Running',
        createdAt: '2026-09-01T10:00:00Z',
        labels: { managedBy: 'autopod', podId: 'pod-a' },
      },
      {
        id: 'sandbox-b',
        state: 'Stopped',
        createdAt: '2026-08-20T09:00:00Z',
        labels: { phase5Role: 'broker' },
      },
    ]);
  });

  it('accepts an envelope shape and drops entries without an id', async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: { value: [{ id: 'sandbox-a', labels: {} }, { state: 'Running' }, { id: '' }] },
      },
    ]);
    expect(await client.listSandboxes()).toEqual([{ id: 'sandbox-a', labels: {} }]);
  });

  it('refuses partial sandbox listings used as evidence for failure closeout', async () => {
    const { client } = makeClient([
      { status: 200, body: { value: [], nextLink: 'page-two' } },
      { status: 200, body: {} },
      { status: 200, body: [{ state: 'Running' }] },
      { status: 200, body: [] },
    ]);
    const options = { requireComplete: true };
    await expect(client.listSandboxes(options)).rejects.toThrow('Complete sandbox inventory');
    await expect(client.listSandboxes(options)).rejects.toThrow('Complete sandbox inventory');
    await expect(client.listSandboxes(options)).rejects.toThrow('unidentified resource');
    await expect(client.listSandboxes(options)).resolves.toEqual([]);
  });

  it('returns an empty list for a missing group rather than throwing', async () => {
    const { client } = makeClient([{ status: 404 }]);
    expect(await client.listSandboxes()).toEqual([]);
  });
});

describe('bounded retained sandbox resume', () => {
  beforeEach(() => {
    wakeupFixture = createSandboxWakeupFixture(true);
  });
  afterEach(() => {
    wakeupFixture = undefined;
  });
  it.each([
    { states: ['Stopped', 'Running'], locked: true, posts: 1 },
    { states: ['Stopped', 'Stopped', 'Running'], locked: true, posts: 2 },
    { states: ['Stopped', 'Stopped', 'Running'], locked: false, posts: 1 },
    { states: ['Resuming', 'Running'], locked: false, posts: 0 },
    { states: ['Running'], locked: false, posts: 0 },
  ])('observes Running without duplicate accepted operations: $states', async ({
    states,
    locked,
    posts,
  }) => {
    vi.useFakeTimers();
    try {
      const responses: MockHttpResponse[] = [];
      let submitted = false;
      for (const state of states) {
        responses.push({ status: 200, body: { state } });
        if (state === 'Stopped' && !submitted) {
          responses.push(
            locked ? { status: 409, body: { title: 'ResourceLocked' } } : { status: 202 },
          );
          if (!locked) submitted = true;
        }
      }
      const { client, requests } = makeClient(responses, { pollIntervalMs: 10 });
      const attempts = Promise.all([
        client.resume('synthetic-worker'),
        client.resume('synthetic-worker'),
      ]);
      await vi.runAllTimersAsync();
      await attempts;
      expect(requests.filter((r) => r.init?.method === 'POST')).toHaveLength(posts);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { status: 409, body: { title: 'OtherConflict' } },
    { status: 403, body: { title: 'Forbidden' } },
    { status: 404, body: { title: 'NotFound' } },
  ])('does not blindly retry resume rejection $status', async (rejection) => {
    const { client, requests } = makeClient([
      { status: 200, body: { state: 'Stopped' } },
      rejection,
    ]);
    await expect(client.resume('synthetic-worker')).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it.each([
    'Failed',
    'Deleted',
    'Deleting',
    'Terminated',
  ])('rejects terminal %s without a POST', async (state) => {
    const { client, requests } = makeClient([{ status: 200, body: { state } }]);
    await expect(client.resume('synthetic-worker')).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_FAILED',
    });
    expect(requests).toHaveLength(1);
  });

  it('retries a rejected lock only after observing stopped, then observes an accepted resume', async () => {
    vi.useFakeTimers();
    try {
      const { client, requests } = makeClient(
        [
          { status: 200, body: { state: 'Stopped' } },
          { status: 409, body: { title: 'ResourceLocked' } },
          { status: 200, body: { state: 'Stopping' } },
          { status: 200, body: { state: 'Stopped' } },
          { status: 202 },
          { status: 200, body: { state: 'Stopped' } },
          { status: 200, body: { state: 'Running' } },
        ],
        { pollIntervalMs: 10 },
      );
      const resume = client.resume('synthetic-worker');
      await vi.runAllTimersAsync();
      await resume;
      expect(requests.map((r) => r.init?.method)).toEqual([
        'GET',
        'POST',
        'GET',
        'GET',
        'POST',
        'GET',
        'GET',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not POST after a timed-out observation settles late', async () => {
    vi.useFakeTimers();
    try {
      let observe!: (response: Response) => void;
      const fetch = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            observe = resolve;
          }),
      );
      const { client } = makeClient([], { fetch, resumeTimeoutMs: 50 });
      const result = expect(client.resume('synthetic-worker')).rejects.toMatchObject({
        code: 'SANDBOX_WAKEUP_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(50);
      await result;
      observe(new Response(JSON.stringify({ state: 'Stopped' })));
      await vi.runAllTimersAsync();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a hung HTTP call and releases the resume guard', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn()
        .mockImplementationOnce(() => new Promise<Response>(() => {}))
        .mockResolvedValue(new Response(JSON.stringify({ state: 'Running' })));
      const { client } = makeClient([], { fetch, resumeTimeoutMs: 50 });
      const result = expect(client.resume('synthetic-worker')).rejects.toMatchObject({
        code: 'SANDBOX_WAKEUP_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(50);
      await result;
      await client.resume('synthetic-worker');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])('bounds persistent locks/transitions (locked=$0)', async (locked) => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        async (_url: string | URL, init?: RequestInit) =>
          new Response(
            JSON.stringify(
              init?.method === 'POST'
                ? { title: 'ResourceLocked' }
                : { state: locked ? 'Stopped' : 'Resuming' },
            ),
            { status: init?.method === 'POST' ? 409 : 200 },
          ),
      );
      const { client } = makeClient([], { fetch, resumeTimeoutMs: 50, pollIntervalMs: 10 });
      const result = expect(client.resume('synthetic-worker')).rejects.toMatchObject({
        code: 'SANDBOX_WAKEUP_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(50);
      await result;
      const calls = fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(fetch).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
