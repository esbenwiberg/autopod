import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourceFixture, result } from '../test-utils/resource-helpers.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('resource public preview controls', () => {
  it('rejects missing/removed containers before starting preview', async () => {
    const f = createResourceFixture();
    f.podRepo.update('prepare', { containerId: null });
    await expect(f.controls.startPreview('prepare')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.podRepo.update('prepare', {
      containerId: 'container-123',
      previewUrl: 'http://127.0.0.1:12345',
    });
    vi.mocked(f.cm.getStatus).mockResolvedValue('unknown');
    await expect(f.controls.startPreview('prepare')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(f.cm.start).not.toHaveBeenCalled();
  });
  it('reuses a live supervisor idempotently and schedules only its auto-stop', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    f.podRepo.update('prepare', { previewUrl: 'http://127.0.0.1:12345' });
    f.profiles.update('test-profile', { startCommand: 'serve app' });
    vi.mocked(f.cm.execInContainer)
      .mockResolvedValueOnce(result('123'))
      .mockResolvedValueOnce(result('1'));
    await expect(f.controls.startPreview('prepare')).resolves.toEqual({
      previewUrl: 'http://127.0.0.1:12345',
    });
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.execInContainer).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    f.timers.clearPreviewTimer('prepare');
  });
  it('starts a stopped container, uses the health deadline and still returns preview after failure', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    f.podRepo.update('prepare', { previewUrl: 'http://127.0.0.1:12345' });
    f.profiles.update('test-profile', {
      startCommand: 'serve app',
      healthTimeout: 10,
      healthPath: '/health',
    });
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    const probe = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', probe);
    const pending = f.controls.startPreview('prepare');
    await vi.advanceTimersByTimeAsync(10000);
    await expect(pending).resolves.toEqual({ previewUrl: 'http://127.0.0.1:12345' });
    expect(f.cm.start).toHaveBeenCalledWith('container-123', {
      assertCurrent: expect.any(Function),
    });
    vi.mocked(f.cm.start).mock.calls[0]?.[1]?.assertCurrent?.();
    expect(probe).toHaveBeenCalledTimes(5);
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:12345/health', expect.any(Object));
    f.timers.clearPreviewTimer('prepare');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears preview timer/proxy before stopping and returns safe defaults for unavailable status', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    f.timers.schedulePreviewAutoStop('prepare', 'container-123', 'local');
    await f.controls.stopPreview('prepare');
    expect(vi.getTimerCount()).toBe(0);
    expect(f.cleanupCaptured.stopSandboxPreviewProxy).toHaveBeenCalledWith('prepare');
    expect(f.cm.stop).toHaveBeenCalledWith('container-123');
    f.podRepo.update('prepare', { containerId: null });
    await expect(f.controls.previewStatus('prepare')).resolves.toMatchObject({
      running: false,
      reachable: false,
      restartCount: 0,
      lastError: null,
    });
  });
  it('combines localhost HTTP reachability with confirmed supervisor PID and restart log', async () => {
    const f = createResourceFixture();
    f.podRepo.update('prepare', { previewUrl: 'http://127.0.0.1:12345' });
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, args) =>
      result(
        args[2]?.includes('supervisor.pid')
          ? '123'
          : args[2]?.includes('restart-count')
            ? '2'
            : args[2]?.includes('kill -0')
              ? '1'
              : 'first\nlast error',
      ),
    );
    await expect(f.controls.previewStatus('prepare')).resolves.toEqual({
      running: true,
      reachable: true,
      restartCount: 2,
      lastError: 'last error',
      previewUrl: 'http://127.0.0.1:12345',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('probes native preview from inside the container rather than the gated external URL', async () => {
    vi.stubEnv('AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS', 'reviewer@invalid.example');
    const f = createResourceFixture();
    f.sandbox();
    f.cm.exposePort = vi.fn(async () => ({ port: 3000, url: 'https://synthetic.invalid/preview' }));
    f.cm.unexposePort = vi.fn(async () => {});
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, args) =>
      result(
        args[2]?.includes('supervisor.pid')
          ? '123'
          : args[2]?.includes('restart-count')
            ? '0'
            : args[2]?.includes('kill -0')
              ? '1'
              : args[2]?.includes('curl -s')
                ? '200'
                : '',
      ),
    );
    await expect(f.controls.previewStatus('prepare')).resolves.toMatchObject({
      running: true,
      reachable: true,
      previewUrl: 'https://synthetic.invalid/preview',
    });
    expect(fetcher).not.toHaveBeenCalled();
    await f.preview.stopSandboxPreviewProxy('prepare');
  });
});
