import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerManager,
  DirectoryExtractionOptions,
} from '../interfaces/container-manager.js';
import { createCodexSandboxRollout } from './codex-sandbox-rollout.js';

function fixture() {
  const controller = new AbortController();
  let owned = true;
  let sessionId = 'thread';
  let release = () => {};
  let captured: DirectoryExtractionOptions | undefined;
  const extract = vi.fn(
    async (
      _id: string,
      _path: string,
      _host: string,
      _excludes?: string[],
      options?: DirectoryExtractionOptions,
    ) => {
      captured = options;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      options?.assertCurrent?.();
    },
  );
  const rollout = createCodexSandboxRollout({
    containerManager: { extractDirectoryFromContainer: extract } as unknown as ContainerManager,
    containerId: 'sandbox',
    containerPath: '/sessions',
    hostPath: '/host',
    signal: controller.signal,
    assertCurrent: () => {
      if (!owned) throw new Error('Superseded invocation');
    },
    sessionId: () => sessionId,
  });
  return {
    rollout,
    extract,
    controller,
    release: () => release(),
    options: () => captured,
    supersede: () => {
      owned = false;
    },
    changeSession: () => {
      sessionId = 'other-thread';
    },
  };
}

describe('owned Codex sandbox rollout snapshots', () => {
  it('coalesces concurrent readers and guards publication', async () => {
    const f = fixture();
    const a = f.rollout.refresh(1000);
    const b = f.rollout.refresh(1000);
    expect(a).toBe(b);
    await Promise.resolve();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(f.options()?.signal?.aborted).toBe(false);
    f.release();
    await a;
    expect(f.options()?.signal?.aborted).toBe(true);
  });

  it.each([
    'cancel',
    'owner',
    'session',
  ] as const)('fences late publication after %s changes', async (mode) => {
    const f = fixture();
    const pending = f.rollout.refresh(1000);
    const rejected = expect(pending).rejects.toThrow();
    await Promise.resolve();
    if (mode === 'cancel') f.controller.abort(new Error('Suspended'));
    if (mode === 'owner') f.supersede();
    if (mode === 'session') f.changeSession();
    expect(() => f.options()?.assertCurrent?.()).toThrow();
    f.release();
    await rejected;
  });

  it('bounds a coalesced live read by the shorter finalization budget and rejects late publication', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const live = f.rollout.refresh(30_000);
      await Promise.resolve();
      const final = f.rollout.refresh(100);
      expect(final).toBe(live);
      const rejected = expect(final).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(f.options()?.signal?.aborted).toBe(true);
      expect(() => f.options()?.assertCurrent?.()).toThrow();
      f.release();
      await Promise.resolve();
    } finally {
      f.controller.abort();
      vi.useRealTimers();
    }
  });
});
