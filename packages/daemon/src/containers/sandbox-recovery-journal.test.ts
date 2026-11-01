import { describe, expect, it, vi } from 'vitest';
import {
  TEST_WAKEUP_ID,
  TEST_WAKEUP_KEY,
  createSandboxWakeupFixture,
  createTestWakeupClient,
} from '../test-utils/sandbox-wakeup-helpers.js';

describe('exact-resource abandonment capability at Azure transport', () => {
  function fixture() {
    const f = createSandboxWakeupFixture(true, true);
    const intent = f.journal.claim(TEST_WAKEUP_KEY, TEST_WAKEUP_ID, 'pod');
    f.journal.beginDispatch(intent.id);
    const receipt = f.journal.recovery.admit({
      id: 'abandon',
      podId: 'pod',
      sandboxId: TEST_WAKEUP_ID,
      resourceKey: TEST_WAKEUP_KEY,
      generation: 1,
      action: 'abandon',
      userId: 'human',
      reason: 'Explicitly discard unpreserved source',
      requestHash: 'a'.repeat(64),
      binding: 'b'.repeat(64),
      intentIds: [intent.id],
    });
    let deleted = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return deleted
        ? new Response(null, { status: 404 })
        : Response.json({ id: TEST_WAKEUP_ID, state: 'Stopped' });
    });
    const client = createTestWakeupClient(f.journal, fetch);
    return { ...f, intent, receipt, fetch, client };
  }
  it('ordinary DELETE remains blocked, scoped DELETE succeeds, wakeup history stays unresolved', async () => {
    const f = fixture();
    await expect(f.client.destroy(TEST_WAKEUP_ID)).rejects.toThrow('exact abandonment owner');
    expect(f.fetch).not.toHaveBeenCalled();
    await f.journal.recovery.withAbandonment(
      'abandon',
      () => {},
      () => f.client.destroy(TEST_WAKEUP_ID),
    );
    expect(f.fetch.mock.calls.filter((c) => c[1]?.method === 'DELETE')).toHaveLength(1);
    expect(f.journal.retains(TEST_WAKEUP_ID)).toBe(true);
    f.journal.recovery.complete('abandon', 'deleted');
    expect(f.journal.retains(TEST_WAKEUP_ID)).toBe(false);
    expect(f.journal.listForPod('pod')[0]?.endedAt).toBeNull();
    await expect(f.client.resume(TEST_WAKEUP_ID)).rejects.toMatchObject({
      code: 'SANDBOX_ABANDONED',
    });
  });
  it('rechecks the ownership capability before transport and never leaks it to unrelated calls', async () => {
    const f = fixture();
    let valid = true;
    const client = createTestWakeupClient(f.journal, f.fetch, {
      credential: {
        getToken: async () => {
          valid = false;
          return { token: 'synthetic' };
        },
      },
    });
    await expect(
      f.journal.recovery.withAbandonment(
        'abandon',
        () => {
          if (!valid) throw new Error('owner changed');
        },
        () => client.destroy(TEST_WAKEUP_ID),
      ),
    ).rejects.toThrow('owner changed');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(() => f.journal.assertReleasable(TEST_WAKEUP_ID)).toThrow('exact abandonment owner');
    expect(f.journal.recovery.get('abandon')?.completedAt).toBeNull();
  });
  it('does not grant authority over a different provider namespace, even with the same sandbox ID', async () => {
    const f = fixture();
    const other = TEST_WAKEUP_KEY.replace('rg-1', 'rg-other');
    f.journal.observeRunning(other, TEST_WAKEUP_ID);
    const next = f.journal.claim;
    // A human abandonment now blocks all new wakeup claims, not only the old namespace.
    expect(() => next(other, TEST_WAKEUP_ID, 'pod')).toThrow('abandoned');
    await expect(
      f.journal.recovery.withAbandonment(
        'abandon',
        () => {},
        () =>
          createTestWakeupClient(f.journal, f.fetch, { resourceGroup: 'rg-other' }).destroy(
            TEST_WAKEUP_ID,
          ),
      ),
    ).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
