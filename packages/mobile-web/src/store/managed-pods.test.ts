import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedPodSummary } from './managed-pods.js';
import { useManagedPodsStore } from './managed-pods.js';

const originalState = useManagedPodsStore.getState();

beforeEach(() => {
  useManagedPodsStore.setState({ pods: [], loading: false, loaded: false, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useManagedPodsStore.setState(originalState, true);
});

it('loads every managed pod page and preserves installation order', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(pageResponse([pod('managed-newer')], '101:managed-newer'))
    .mockResolvedValueOnce(pageResponse([pod('managed-older')], null));

  await useManagedPodsStore.getState().refresh();

  expect(useManagedPodsStore.getState().pods.map((item) => item.podId)).toEqual([
    'managed-newer',
    'managed-older',
  ]);
  expect(useManagedPodsStore.getState().loaded).toBe(true);
  expect(fetchSpy.mock.calls[0]?.[0]).toBe('/managed/pods?limit=100');
  expect(fetchSpy.mock.calls[1]?.[0]).toBe('/managed/pods?limit=100&cursor=101%3Amanaged-newer');
});

it('keeps the last managed inventory when a refresh fails', async () => {
  useManagedPodsStore.setState({ pods: [pod('managed-one')], loaded: true });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('offline', { status: 503 }));

  await useManagedPodsStore.getState().refresh();

  expect(useManagedPodsStore.getState().pods.map((item) => item.podId)).toEqual(['managed-one']);
  expect(useManagedPodsStore.getState().error).toBe('offline');
});

function pageResponse(pods: ManagedPodSummary[], nextCursor: string | null): Response {
  return new Response(JSON.stringify({ schemaVersion: 1, pods, nextCursor }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function pod(podId: string): ManagedPodSummary {
  return {
    podId,
    dispatcherAttemptId: `attempt-${podId}`,
    state: 'running',
    providerAccountId: 'openai-private',
    model: 'gpt-5.6-terra',
    runtime: 'codex',
    executionTarget: 'sandbox',
    reasoning: 'high',
    profileId: 'dispatcher-research',
    profileVersion: 2,
    providerRequests: 1,
    consumedTokens: 42,
    tokenUsageKnown: true,
    failure: null,
    limitations: [],
    artifacts: [],
    revoked: false,
    stopRequested: false,
    observedExit: false,
    cleanup: 'not-requested',
    exitCode: null,
    createdAt: 100,
    lastEventAt: 101,
  };
}
