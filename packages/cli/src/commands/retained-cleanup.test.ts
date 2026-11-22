import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { registerRetainedCleanupCommand } from './retained-cleanup.js';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => fetch(...args) }));
const daemon = 'https://fixture.invalid';
const podId = 'retained-pod';
const id = 'exact-human-decision';
const time = '2026-11-19T12:00:00.000Z';
const target = {
  kind: 'docker_container',
  role: 'guest_execution',
  id: 'e'.repeat(64),
  namespace: 'fixture-engine',
};
const checkout = {
  kind: 'host_worktree',
  role: 'original_checkout',
  id: '/data/git/retained',
  namespace: 'fixture-host',
};
const plan = {
  version: 1,
  generation: 2,
  sessionId: 'exact-task-execution',
  binding: 'a'.repeat(64),
  resources: [target, checkout],
  dataLoss: ['Unpublished work and writable layers/logs.'],
  retained: ['History and external PRs.'],
  notReclaimed: ['Shared Git and images.'],
};
const eligible = { state: 'eligible', podId, plan };
const blocker = {
  code: 'HOST_PROOF_UNAVAILABLE',
  message: 'Mount proof unavailable',
  resourceId: checkout.id,
};
const input = {
  id,
  expectedGeneration: plan.generation,
  expectedBinding: plan.binding,
  expectedSessionId: plan.sessionId,
  reason: 'Discard the unpublished experiment',
  acknowledgeDataLoss: true,
};
const receipt = {
  state: 'deleted',
  podId,
  request: input,
  actor: { type: 'human', userId: 'operator' },
  plan,
  createdAt: time,
  updatedAt: time,
  blockers: [],
  resources: plan.resources.map((resource) => ({ ...resource, state: 'confirmed_absent' })),
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let directory: string;
let path: string;
const initialExit = process.exitCode;
const getToken = vi.fn(async () => 'test-only');
let stdout: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  fetch.mockReset();
  getToken.mockClear();
  stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  directory = await mkdtemp(join(tmpdir(), 'ap-retained-cleanup-test-'));
  path = join(directory, 'exact.json');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  process.exitCode = initialExit;
  vi.restoreAllMocks();
});

async function run(args: string[] = [], targetDaemon = daemon, pod = podId) {
  const program = new Command().exitOverride();
  registerRetainedCleanupCommand(
    program,
    () => new AutopodClient({ baseUrl: targetDaemon, getToken }),
  );
  await program.parseAsync(['node', 'ap', 'cleanup-retained', pod, '--json', ...args]);
  return JSON.parse(String(stdout.mock.lastCall?.[0]));
}
function apply() {
  return [
    '--apply',
    '--daemon-identity',
    daemon,
    '--request-file',
    path,
    '--request-id',
    id,
    '--plan-version',
    '1',
    '--generation',
    '2',
    '--binding',
    plan.binding,
    '--session',
    plan.sessionId,
    '--reason',
    `  ${input.reason} \n`,
    '--acknowledge-data-loss',
  ];
}

describe('retained cleanup command through its real client', () => {
  it('previews only by GET, returning exact identities and consequences', async () => {
    fetch.mockResolvedValueOnce(json(eligible));
    expect(await run()).toEqual({ ...eligible, daemon });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${daemon}/pods/${podId}/retained-cleanup`, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer test-only' },
      body: undefined,
    });
    await expect(run(['--request-file', path])).rejects.toThrow('read-only');
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes unsupported route, missing exact receipt, blockers and previously requested', async () => {
    fetch
      .mockResolvedValueOnce(json({ message: 'Route not found' }, 404))
      .mockResolvedValueOnce(json({ code: 'POD_NOT_FOUND' }, 404))
      .mockResolvedValueOnce(json({ state: 'blocked', podId, blockers: [blocker] }))
      .mockResolvedValueOnce(json({ state: 'requested', podId, requestId: id }));
    expect(await run()).toMatchObject({ state: 'unsupported' });
    expect(await run(['--observe', '--request-id', id])).toMatchObject({
      state: 'not_found',
      requestId: id,
    });
    expect(await run()).toMatchObject({ state: 'blocked', blockers: [blocker] });
    expect(await run()).toMatchObject({
      state: 'requested',
      next: { observe: ['ap', 'cleanup-retained', podId, '--observe', '--request-id', id] },
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(`${daemon}/pods/${podId}/retained-cleanup/${id}`);
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'GET', 'GET', 'GET']);
  });

  it('requires exact reviewed v1 flags and consent, and binds replay to the saved daemon and pod', async () => {
    await expect(run(apply().slice(0, -1))).rejects.toThrow();
    await expect(run(apply(), 'https://other.invalid')).rejects.toThrow(
      'matching --daemon-identity',
    );
    await expect(run(apply(), daemon, '..')).rejects.toThrow('exact pod ID');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(json({ state: 'blocked', podId, blockers: [blocker] }));
    expect(await run(apply())).toMatchObject({
      state: 'blocked',
      blockers: [blocker],
      requestFile: path,
    });
    const reconcile = ['--reconcile', '--request-file', path];
    await expect(run(reconcile, 'https://other.invalid')).rejects.toThrow('does not match');
    await expect(run(reconcile, daemon, 'other-pod')).rejects.toThrow('does not match');
    await expect(run(apply())).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('journals before dispatch, reports uncertainty, observes partial and explicitly replays identical bytes', async () => {
    fetch.mockImplementationOnce(async (_url, init) => {
      const file = JSON.parse(await readFile(path, 'utf8'));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(file).toEqual({ version: 1, podId, daemon, request: input });
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify(input));
      throw new Error('Lost response');
    });
    expect(await run(apply())).toMatchObject({
      state: 'uncertain',
      requestId: id,
      requestFile: path,
    });
    expect(process.exitCode).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const partial = {
      ...receipt,
      state: 'partial',
      blockers: [blocker],
      resources: [
        { ...target, state: 'confirmed_absent' },
        { ...checkout, state: 'removal_unconfirmed' },
      ],
    };
    fetch.mockResolvedValueOnce(json(partial));
    expect(await run(['--observe', '--request-file', path])).toMatchObject(partial);
    fetch.mockResolvedValueOnce(json(receipt));
    expect(await run(['--reconcile', '--request-file', path])).toMatchObject(receipt);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[2]);
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['POST', 'GET', 'POST']);
    expect(fetch.mock.calls[0]?.[1].redirect).toBe('error');
  });

  it.each([401, 409, 503])('does not retry or replace the request on HTTP %i', async (status) => {
    fetch.mockResolvedValueOnce(json({ message: 'Refused' }, status));
    expect(await run(apply())).toMatchObject({ state: 'uncertain', message: 'Refused' });
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(path, 'utf8')).request).toEqual(input);
  });

  it.each([
    {
      value: {
        ...receipt,
        state: 'pending',
        resources: receipt.resources.map((r) => ({ ...r, state: 'pending' })),
      },
      code: 202,
      state: 'pending',
    },
    {
      value: { ...receipt, request: { ...input, reason: 'Another operator decision' } },
      code: 200,
      state: 'uncertain',
    },
    {
      value: { ...receipt, resources: [{ ...target, state: 'pending' }, receipt.resources[1]] },
      code: 200,
      state: 'uncertain',
    },
    {
      value: {
        ...receipt,
        resources: [
          { ...target, namespace: 'different', state: 'confirmed_absent' },
          receipt.resources[1],
        ],
      },
      code: 200,
      state: 'uncertain',
    },
    { value: receipt, code: 202, state: 'uncertain' },
    { value: { ...receipt, receipt: null, resources: [] }, code: 200, state: 'uncertain' },
  ])('validates submission and exact progress (expect $state, HTTP $code)', async ({
    value,
    code,
    state,
  }) => {
    fetch.mockResolvedValueOnce(json(value, code));
    expect(await run(apply())).toMatchObject({ state });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
