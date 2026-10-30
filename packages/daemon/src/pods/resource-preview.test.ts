import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResourceFixture,
  result,
  unusedLocalPreviewUrl,
} from '../test-utils/resource-helpers.js';
afterEach(() => vi.unstubAllEnvs());
describe('resource preview caches and transport', () => {
  it('persists native URL through SQLite reopen, reuses only matching container and unexposes once', async () => {
    vi.stubEnv('AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS', 'reviewer@invalid.example');
    const f = createResourceFixture(true);
    f.sandbox();
    const expose = vi.fn(async () => ({ port: 3000, url: 'https://synthetic.invalid/preview' }));
    const unexpose = vi.fn(async () => {});
    f.cm.exposePort = expose;
    f.cm.unexposePort = unexpose;
    await expect(f.preview.ensureSandboxPreviewProxy(f.pod())).resolves.toBe(
      'https://synthetic.invalid/preview',
    );
    await f.preview.ensureSandboxPreviewProxy(f.pod());
    expect(expose).toHaveBeenCalledOnce();
    expect(expose).toHaveBeenCalledWith('container-123', 3000, {
      entraEmails: ['reviewer@invalid.example'],
    });
    f.podRepo.update('prepare', { containerId: 'replacement' });
    await f.preview.ensureSandboxPreviewProxy(f.pod());
    expect(expose).toHaveBeenCalledTimes(2);
    await f.preview.stopSandboxPreviewProxy('prepare');
    await f.preview.stopSandboxPreviewProxy('prepare');
    expect(unexpose).toHaveBeenCalledOnce();
    expect(unexpose).toHaveBeenCalledWith('replacement', 3000);
    const saved = f.pod();
    const profile = f.profiles.get('test-profile');
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('falls back to a real local HTTP proxy, reuses it and closes on replacement', async () => {
    vi.stubEnv('AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS', '');
    const f = createResourceFixture();
    f.sandbox();
    f.podRepo.update('prepare', { previewUrl: await unusedLocalPreviewUrl() });
    vi.mocked(f.cm.execInContainer).mockResolvedValue(
      result(
        JSON.stringify({
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          bodyBase64: Buffer.from('local preview').toString('base64'),
        }),
      ),
    );
    const url = await f.preview.ensureSandboxPreviewProxy(f.pod());
    expect(await (await fetch(url)).text()).toBe('local preview');
    expect(await f.preview.ensureSandboxPreviewProxy(f.pod())).toBe(url);
    await f.preview.stopSandboxPreviewProxy('prepare');
    await expect(fetch(url)).rejects.toThrow();
    f.podRepo.update('prepare', {
      containerId: 'replacement',
      previewUrl: await unusedLocalPreviewUrl(),
    });
    const replacement = await f.preview.ensureSandboxPreviewProxy(f.pod());
    expect(await (await fetch(replacement)).text()).toBe('local preview');
    await f.preview.stopSandboxPreviewProxy('prepare');
  });
  it('replaces a cached status guard after pause while still refusing stale requests', async () => {
    vi.stubEnv('AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS', '');
    const f = createResourceFixture();
    f.sandbox();
    f.podRepo.update('prepare', { previewUrl: await unusedLocalPreviewUrl() });
    vi.mocked(f.cm.execInContainer).mockResolvedValue(
      result(JSON.stringify({ statusCode: 200, headers: {}, bodyBase64: '' })),
    );
    const url = await f.preview.ensureSandboxPreviewProxy(f.pod());
    try {
      expect((await fetch(url, { headers: { connection: 'close' } })).status).toBe(200);
      f.events.transition(f.pod(), 'paused');
      const calls = vi.mocked(f.cm.execInContainer).mock.calls.length;
      expect((await fetch(url, { headers: { connection: 'close' } })).status).toBe(502);
      expect(f.cm.execInContainer).toHaveBeenCalledTimes(calls);
      expect(await f.preview.ensureSandboxPreviewProxy(f.pod())).toBe(url);
      expect((await fetch(url, { headers: { connection: 'close' } })).status).toBe(200);
      f.podRepo.update('prepare', { lifecycleGeneration: f.pod().lifecycleGeneration + 1 });
      const renewedCalls = vi.mocked(f.cm.execInContainer).mock.calls.length;
      expect((await fetch(url, { headers: { connection: 'close' } })).status).toBe(502);
      expect(f.cm.execInContainer).toHaveBeenCalledTimes(renewedCalls);
    } finally {
      await f.preview.stopSandboxPreviewProxy('prepare');
    }
  });

  it('warns and falls back when native exposure fails or has no assigned URL', async () => {
    vi.stubEnv('AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS', 'reviewer@invalid.example');
    const f = createResourceFixture();
    f.sandbox();
    f.podRepo.update('prepare', { previewUrl: await unusedLocalPreviewUrl() });
    f.cm.exposePort = vi
      .fn()
      .mockRejectedValueOnce(new Error('Synthetic exposure'))
      .mockResolvedValueOnce({ port: 3000 });
    expect(await f.preview.tryNativeSandboxPreview(f.pod(), 'container-123')).toBeNull();
    expect(await f.preview.tryNativeSandboxPreview(f.pod(), 'container-123')).toBeNull();
    expect(f.deps.logger.warn).toHaveBeenCalledTimes(2);
    const url = await f.preview.ensureSandboxPreviewProxy(f.pod());
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await f.preview.stopSandboxPreviewProxy('prepare');
  });
  it('retains local URL and sandbox no-container admission errors', async () => {
    const f = createResourceFixture();
    f.podRepo.update('prepare', { previewUrl: null });
    await expect(f.preview.ensureSandboxPreviewProxy(f.pod())).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.sandbox();
    f.podRepo.update('prepare', { containerId: null });
    await expect(f.preview.ensureSandboxPreviewProxy(f.pod())).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});
