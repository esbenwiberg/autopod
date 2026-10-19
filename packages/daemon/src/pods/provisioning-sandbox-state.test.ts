import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
const fixtures: ReturnType<typeof createProvisioningFixture>[] = [];
function fixture() {
  const f = createProvisioningFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
});
describe('provisioning sandbox state', () => {
  it('guards only automatic sandbox execution on unsupported streaming backends', () => {
    const f = fixture();
    f.cm.supportsStreamingExec = false;
    const p = f.profiles.get('test-profile');
    expect(() =>
      f.sandbox.assertSandboxAgentStreamingExecSupported(p, 'sandbox', f.pod().options),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SANDBOX_STREAMING_EXEC' }));
    expect(() =>
      f.sandbox.assertSandboxAgentStreamingExecSupported(p, 'local', f.pod().options),
    ).not.toThrow();
    expect(() =>
      f.sandbox.assertSandboxAgentStreamingExecSupported(p, 'sandbox', {
        ...f.pod().options,
        agentMode: 'interactive',
      }),
    ).not.toThrow();
  });
  it('passes ownership and aborts the extraction signal after session synchronization', async () => {
    const f = fixture();
    const pod = { ...f.pod(), executionTarget: 'sandbox' as const, containerId: 'container' };
    const owns = vi.fn(() => true);
    await f.sandbox.syncSandboxRuntimeSessionState(pod, owns);
    const args = vi.mocked(f.cm.extractDirectoryFromContainer).mock.calls[0];
    expect(args?.[0]).toBe('container');
    expect(args?.[1]).toContain('/.claude/projects');
    expect(args?.[2]).toBe(join(f.directory, 'claude', 'prepare'));
    expect(args?.[4]?.signal?.aborted).toBe(true);
    expect(() => args?.[4]?.assertCurrent?.()).not.toThrow();
    expect(owns).toHaveBeenCalled();
  });
  it('uses the live timeout and clears the timer while aborting a stuck extraction', async () => {
    const f = fixture();
    f.deps.sandboxRuntimeSessionSyncTimeoutMs = 3;
    vi.useFakeTimers();
    vi.mocked(f.cm.extractDirectoryFromContainer).mockReturnValueOnce(new Promise<void>(() => {}));
    const pending = f.sandbox.syncSandboxRuntimeSessionState(
      { ...f.pod(), executionTarget: 'sandbox', containerId: 'container' },
      () => true,
    );
    await vi.advanceTimersByTimeAsync(4);
    await pending;
    expect(vi.mocked(f.cm.extractDirectoryFromContainer).mock.calls[0]?.[4]?.signal?.aborted).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('synchronizes a sandbox series handover to the private host directory', async () => {
    const f = fixture();
    f.db
      .prepare(
        "UPDATE pods SET execution_target='sandbox',series_id='series',container_id='container' WHERE id='prepare'",
      )
      .run();
    vi.mocked(f.cm.readFile).mockResolvedValueOnce('Retained handover');
    await f.sandbox.syncSandboxSeriesHandover('prepare');
    expect(
      readFileSync(join(f.directory, 'pod-artifacts', 'series', 'handovers', 'prepare.md'), 'utf8'),
    ).toBe('Retained handover');
  });
});
