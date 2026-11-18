import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { registerSavedWorkDraftPrCommand } from './saved-work-draft-pr.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const binding = 'b'.repeat(64);
function fixture() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  mockFetch.mockReset();
  const fetch = mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method!,
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({ podId: 'polite-tarsier', binding, sources: [], blockers: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const client = new AutopodClient({
    baseUrl: 'http://fixture.invalid',
    getToken: async () => 'human-token',
  });
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride();
    registerSavedWorkDraftPrCommand(program, () => client);
    await program.parseAsync(['node', 'ap', 'draft-pr', 'polite-tarsier', ...args]);
  };
  return { calls, fetch, run };
}
describe('saved-work draft CLI exact confirmation', () => {
  it('inspects by default with GET only and preserves full pod identity', async () => {
    const f = fixture();
    await f.run('--json');
    expect(f.calls).toEqual([
      {
        method: 'GET',
        url: 'http://fixture.invalid/pods/polite-tarsier/saved-work-draft',
        body: null,
      },
    ]);
  });
  it('sends explicit saved-source selection then separate exact confirmation and stable request ID', async () => {
    const f = fixture();
    await f.run(
      '--prepare',
      '--source',
      'checkpoint-3',
      '--request-id',
      'stable-human-request',
      '--binding',
      binding,
      '--json',
    );
    await f.run(
      '--confirm',
      '--request-id',
      'stable-human-request',
      '--binding',
      binding,
      '--json',
    );
    expect(f.calls.map((c) => c.body)).toEqual([
      { requestId: 'stable-human-request', expectedBinding: binding, sourceId: 'checkpoint-3' },
      { requestId: 'stable-human-request', expectedBinding: binding, draftOnly: true },
    ]);
    expect(f.calls.map((c) => c.url)).toEqual([
      'http://fixture.invalid/pods/polite-tarsier/saved-work-draft/prepare',
      'http://fixture.invalid/pods/polite-tarsier/saved-work-draft/confirm',
    ]);
  });
  it('observes the same request with GET and no confirmation replay', async () => {
    const f = fixture();
    await f.run('--observe', '--request-id', 'stable-request', '--json');
    expect(f.calls[0]).toMatchObject({
      method: 'GET',
      body: null,
      url: 'http://fixture.invalid/pods/polite-tarsier/saved-work-draft/stable-request',
    });
  });
  it('cancels only an explicit exact operation without granting publication', async () => {
    const f = fixture();
    await f.run('--cancel', '--request-id', 'stable-request', '--binding', binding, '--json');
    expect(f.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://fixture.invalid/pods/polite-tarsier/saved-work-draft/cancel',
      body: { requestId: 'stable-request', expectedBinding: binding },
    });
  });
  it('revokes pending preparation with the original preview binding and source selection', async () => {
    const f = fixture();
    await f.run(
      '--cancel-preparation',
      '--source',
      'checkpoint-2',
      '--request-id',
      'lost-request',
      '--binding',
      binding,
      '--json',
    );
    expect(f.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://fixture.invalid/pods/polite-tarsier/saved-work-draft/cancel-preparation',
      body: { requestId: 'lost-request', expectedBinding: binding, sourceId: 'checkpoint-2' },
    });
  });
  it.each([
    ['--confirm'],
    ['--cancel'],
    ['--cancel', '--confirm'],
    ['--prepare', '--request-id', 'stable', '--binding', binding],
    ['--source', 'checkpoint-1'],
    ['--prepare', '--confirm'],
    ['--observe', '--request-id', 'stable', '--binding', binding],
    ['--confirm', '--request-id', 'stable', '--binding', binding, '--source', 'checkpoint-1'],
  ])('rejects incomplete or ambiguous authority before network %j', async (...args) => {
    const f = fixture();
    await expect(f.run(...args)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('does not retry a timed-out confirmation or substitute a new request', async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error('timeout'));
    await expect(
      f.run('--confirm', '--request-id', 'stable-request', '--binding', binding),
    ).rejects.toThrow(/Observe/);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});
