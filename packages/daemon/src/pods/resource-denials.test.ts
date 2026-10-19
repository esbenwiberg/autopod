import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createResourceFixture, deferred } from '../test-utils/resource-helpers.js';
describe('resource denial receiver', () => {
  it('uses the real stream parser to persist denial events and deletes handle authority before stopping', async () => {
    const f = createResourceFixture();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exit = deferred<number>();
    const kill = vi.fn(async () => {
      stdout.end();
      stderr.end();
      exit.resolve(0);
    });
    vi.mocked(f.cm.execStreaming).mockResolvedValueOnce({
      stdout,
      stderr,
      exitCode: exit.promise,
      kill,
    });
    const owner = f.denials();
    await owner.startHaproxyDenyReceiver(f.pod(), 'container-123');
    stdout.write(
      '<134>May 12 20:47:25 haproxy[1]: sni=blocked.example src=127.0.0.1 action=DENY\n',
    );
    stdout.write(
      '<134>May 12 20:47:25 haproxy[1]: sni=allowed.example src=127.0.0.1 action=ALLOW\n',
    );
    expect(f.deps.eventRepo?.getForSession('prepare').map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'pod.firewall_denied', sni: 'blocked.example' }),
      ]),
    );
    await owner.stopHaproxyDenyReceiver('prepare');
    await owner.stopHaproxyDenyReceiver('prepare');
    expect(kill).toHaveBeenCalledOnce();
  });
  it('warns on startup or stop failure without blocking cleanup', async () => {
    const f = createResourceFixture();
    const owner = f.denials();
    vi.mocked(f.cm.execStreaming).mockRejectedValueOnce(new Error('Synthetic receiver'));
    await owner.startHaproxyDenyReceiver(f.pod(), 'container-123');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    vi.mocked(f.cm.execStreaming).mockResolvedValueOnce({
      stdout,
      stderr,
      exitCode: Promise.resolve(0),
      kill: async () => {
        throw new Error('Synthetic stop');
      },
    });
    await owner.startHaproxyDenyReceiver(f.pod(), 'container-123');
    await owner.stopHaproxyDenyReceiver('prepare');
    await owner.stopHaproxyDenyReceiver('prepare');
    stdout.end();
    stderr.end();
    expect(f.deps.logger.warn).toHaveBeenCalledTimes(2);
  });
});
