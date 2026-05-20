import type { PodStatus } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { availableActions, runAction, toggleSkipValidation } from './pod-actions.js';
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

  it('awaiting_input pods only expose kill (answer is the EscalationCard, not an ActionBar button)', () => {
    expect(availableActions('awaiting_input').map((a) => a.kind)).toEqual(['kill']);
  });

  it('validated pods expose approve, reject, kill', () => {
    expect(availableActions('validated').map((a) => a.kind)).toEqual(['approve', 'reject', 'kill']);
  });

  it('review_required pods add extend-attempts + spawn-fix to the bar', () => {
    expect(availableActions('review_required').map((a) => a.kind)).toEqual([
      'approve',
      'reject',
      'extend_attempts',
      'spawn_fix',
      'kill',
    ]);
  });

  it('failed pods expose the full recovery set', () => {
    expect(availableActions('failed').map((a) => a.kind)).toEqual([
      'resume',
      'update_from_base',
      'extend_pr_attempts',
      'spawn_fix',
      'force_complete',
      'kill',
    ]);
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

  it('approve posts to /pods/:id/approve with an empty body', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'approve');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/approve');
    expect((spy.mock.calls[0]?.[1] as RequestInit).body).toBe('{}');
  });

  it('reject without feedback posts an empty body', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'reject');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/reject');
    expect((spy.mock.calls[0]?.[1] as RequestInit).body).toBe('{}');
  });

  it('reject with feedback puts it under `feedback`', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'reject', 'try again with stricter facts');
    const body = (spy.mock.calls[0]?.[1] as RequestInit).body;
    expect(body).toBe(JSON.stringify({ feedback: 'try again with stricter facts' }));
  });

  it('extend_attempts requests +3 by default', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'extend_attempts');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/extend-attempts');
    const body = (spy.mock.calls[0]?.[1] as RequestInit).body;
    expect(body).toBe(JSON.stringify({ additionalAttempts: 3 }));
  });

  it('extend_pr_attempts requests +3 by default', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'extend_pr_attempts');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/extend-pr-attempts');
  });

  it('update_from_base posts with no body', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'update_from_base');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/update-from-base');
    expect((spy.mock.calls[0]?.[1] as RequestInit).body).toBeUndefined();
  });

  it('spawn_fix posts the supplied message', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'spawn_fix', 'fix the lint regression');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/spawn-fix');
    const body = (spy.mock.calls[0]?.[1] as RequestInit).body;
    expect(body).toBe(JSON.stringify({ message: 'fix the lint regression' }));
  });

  it('force_complete carries the reason when one is supplied', async () => {
    const spy = mockFetch();
    await runAction('pod-1', 'force_complete', 'merge conflict resolved by hand');
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/force-complete');
    const body = (spy.mock.calls[0]?.[1] as RequestInit).body;
    expect(body).toBe(JSON.stringify({ reason: 'merge conflict resolved by hand' }));
  });

  it('toggleSkipValidation posts the skip flag', async () => {
    const spy = mockFetch();
    await toggleSkipValidation('pod-1', true);
    expect(spy.mock.calls[0]?.[0]).toBe('/pods/pod-1/skip-validation');
    const body = (spy.mock.calls[0]?.[1] as RequestInit).body;
    expect(body).toBe(JSON.stringify({ skip: true }));
  });
});
