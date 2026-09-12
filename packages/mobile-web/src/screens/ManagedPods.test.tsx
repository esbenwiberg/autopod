import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedPodSummary } from '../store/managed-pods.js';
import { useManagedPodsStore } from '../store/managed-pods.js';
import { ManagedPodDetail } from './ManagedPodDetail.js';
import { ManagedPods } from './ManagedPods.js';

let root: Root;
let container: HTMLDivElement;
const originalState = useManagedPodsStore.getState();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useManagedPodsStore.setState({
    pods: [fixture()],
    loading: false,
    loaded: true,
    error: null,
    refresh: vi.fn(async () => {}),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useManagedPodsStore.setState(originalState, true);
});

it('renders a separate read-only managed pod inventory', async () => {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ManagedPods />
      </MemoryRouter>,
    );
  });

  expect(container.querySelector('h1')?.textContent).toBe('Managed Pods');
  expect(container.textContent).toContain('Read-only Dispatcher attempts');
  expect(container.textContent).toContain('managed-one');
  expect(container.textContent).toContain('42 observed tokens');
  expect(container.querySelector('a[href="/managed-pod/managed-one"]')).not.toBeNull();
  expect(useManagedPodsStore.getState().refresh).toHaveBeenCalledOnce();
});

it('renders managed runtime, failure, limitation and artifact evidence', async () => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/managed-pod/managed-one']}>
        <Routes>
          <Route path="/managed-pod/:id" element={<ManagedPodDetail />} />
        </Routes>
      </MemoryRouter>,
    );
  });

  expect(container.textContent).toContain('attempt-one');
  expect(container.textContent).toContain('Latest provider failure');
  expect(container.textContent).toContain('rate-limited');
  expect(container.textContent).toContain('billing attribution unavailable');
  expect(container.textContent).toContain('artifact-one');
  expect(container.textContent).toContain('2 files');
});

function fixture(): ManagedPodSummary {
  return {
    podId: 'managed-one',
    dispatcherAttemptId: 'attempt-one',
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
    failure: { phase: 'http', reason: 'rate-limited', httpStatus: 429 },
    limitations: ['billing attribution unavailable'],
    artifacts: [
      {
        artifactId: 'artifact-one',
        status: 'committed',
        fileCount: 2,
        totalBytes: 64,
        committedAt: 101,
      },
    ],
    revoked: false,
    stopRequested: false,
    observedExit: false,
    cleanup: 'not-requested',
    exitCode: null,
    createdAt: 100,
    lastEventAt: 101,
  };
}
