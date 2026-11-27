import type { SavedWorkDraftPublicationScan } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { publicationScanLines, registerSavedWorkDraftPrCommand } from './saved-work-draft-pr.js';

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
  it('requires an exact explicit retirement request and sends no confirmation', async () => {
    const f = fixture();
    const reason = 'Saved source was delivered manually.';
    await f.run(
      '--retire-uncertain',
      reason,
      '--request-id',
      'stable-request',
      '--binding',
      binding,
      '--json',
    );
    expect(f.calls).toEqual([
      {
        method: 'POST',
        url: 'http://fixture.invalid/pods/polite-tarsier/saved-work-draft/cancel',
        body: {
          requestId: 'stable-request',
          expectedBinding: binding,
          retireUncertainReason: reason,
        },
      },
    ]);
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
    ['--retire-uncertain', 'Saved source was delivered manually.'],
    ['--retire-uncertain', 'short', '--request-id', 'stable', '--binding', binding],
    [
      '--retire-uncertain',
      'Saved source was delivered manually.',
      '--confirm',
      '--request-id',
      'stable',
      '--binding',
      binding,
    ],
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
  it('reports a publication scan refusal as definitive with the daemon detail', async () => {
    const f = fixture();
    const detail =
      'Saved-work publication security scan blocked by 1 finding(s); nothing was pushed: secretlint rule @secretlint/secretlint-rule-basicauth at docs/guide.md:12.';
    f.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'SECURITY_SCAN_BLOCKED', message: detail }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const error = await f
      .run('--confirm', '--request-id', 'stable-request', '--binding', binding)
      .catch((e: unknown) => e as Error);
    expect(error.message).toContain('was not published (SECURITY_SCAN_BLOCKED)');
    expect(error.message).toContain('docs/guide.md:12');
    expect(error.message).toContain('--observe --request-id stable-request');
    expect(error.message).not.toContain('outcome unconfirmed');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('renders recorded publication scan detail when observing', async () => {
    const f = fixture();
    const scan: SavedWorkDraftPublicationScan = {
      outcome: 'blocked',
      code: 'SECURITY_SCAN_BLOCKED',
      scope: 'diff',
      baseCommit: 'a'.repeat(40),
      decision: 'block',
      filesScanned: 2,
      filesSkipped: 0,
      findingCount: 1,
      blockingCount: 1,
      findings: [
        {
          scanner: 'secretlint',
          detector: 'secrets',
          ruleId: '@secretlint/secretlint-rule-basicauth',
          severity: 'critical',
          file: 'docs/guide.md',
          line: 12,
          action: 'block',
        },
      ],
      reasons: [],
      scannedAt: '2026-11-23T00:00:00.000Z',
    };
    f.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ state: 'prepared', publicationScan: scan }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await f.run('--observe', '--request-id', 'stable-request');
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(printed).toContain(
      'Publication security scan: blocked (SECURITY_SCAN_BLOCKED); scope changes since aaaaaaaaaaaa; 2 file(s) scanned.',
    );
    expect(printed).toContain(
      '  block: secretlint rule @secretlint/secretlint-rule-basicauth at docs/guide.md:12 (value redacted)',
    );
    expect(
      publicationScanLines({
        ...scan,
        outcome: 'failed',
        code: 'SECURITY_SCAN_FAILED',
        findings: [],
        findingCount: 0,
        reasons: ['Scanner error: boom'],
      }),
    ).toEqual([
      'Publication security scan: failed (SECURITY_SCAN_FAILED); scope changes since aaaaaaaaaaaa; 2 file(s) scanned.',
      '  reason: Scanner error: boom',
    ]);
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
