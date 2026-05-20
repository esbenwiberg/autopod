import type { PodStatus } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { availableActions, runAction } from './pod-actions.js';
import { STORAGE_KEY } from './token.js';

describe('availableActions', () => {
  it('running pods can be paused, nudged, or killed', () => {
    const labels = availableActions('running').map((a) => a.kind);
    expect(labels).toEqual(['pause', 'nudge', 'kill']);
  });

  it('paused pods expose resume, nudge, kill', () => {
    const labels = availableActions('paused').map((a) => a.kind);
    expect(labels).toEqual(['resume', 'nudge', 'kill']);
  });

  it('awaiting_input pods only expose kill at this step (answer comes in step 6)', () => {
    expect(availableActions('awaiting_input').map((a) => a.kind)).toEqual(['kill']);
  });

  it('terminal pods have no actions', () => {
    expect(availableActions('complete')).toEqual([]);
    expect(availableActions('killed')).toEqual([]);
  });

  it('non-listed statuses fall back to empty', () => {
    const unknown = 'never-heard-of-it' as unknown as PodStatus;
    expect(availableActions(unknown)).toEqual([]);
  });

  it('every action carries a tone and a known kind', () => {
    for (const status of ['running', 'paused'] as PodStatus[]) {
      for (const a of availableActions(status)) {
        expect(['neutral', 'warn', 'danger']).toContain(a.tone);
        expect(['pause', 'resume', 'kill', 'nudge']).toContain(a.kind);
      }
    }
  });
});

describe('runAction', () => {
  beforeEach(() => {
    window.localStorage.setItem(STORAGE_KEY, 'tok');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  function mockFetch() {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  }

  it('pause posts to /pods/:id/pause', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'pause');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/pause');
    expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
  });

  it('kill posts to /pods/:id/kill', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'kill');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/kill');
  });

  it('resume sends a "continue" nudge', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'resume');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/nudge');
    const body = (spy.mock.calls[0]?.[1] as RequestInit).body;
    expect(body).toBe(JSON.stringify({ message: 'continue' }));
  });

  it('nudge passes through the supplied message', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'nudge', 'try the other config');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/nudge');
    const body = (spy.mock.calls[0]?.[1] as RequestInit).body;
    expect(body).toBe(JSON.stringify({ message: 'try the other config' }));
  });
});
