import { expect, it, vi } from 'vitest';
import { createControlOperationRegistry } from './control-operation-registry.js';
it('tracks original controls through awaits and releases successful/rejected invocations', async () => {
  const registry = createControlOperationRegistry();
  let release = () => {};
  const owner = registry.wrap({
    async resumeSession(_podId: string) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error('original failure');
    },
  });
  const running = owner.resumeSession('pod');
  expect(registry.isActive('pod')).toBe(true);
  release();
  await expect(running).rejects.toThrow('original failure');
  expect(registry.isActive('pod')).toBe(false);
});
it('refuses new mutations under custody while allowing durable reads and source-specific admission', async () => {
  const assertion = vi.fn(() => {
    throw new Error('Source custody held');
  });
  const registry = createControlOperationRegistry(assertion);
  const mutate = vi.fn(async (_id: string) => {});
  const owner = registry.wrap({
    resumeSession: mutate,
    getSession: (id: string) => id,
    adoptSource: async (id: string) => id,
  });
  await expect(owner.resumeSession('pod')).rejects.toThrow('Source custody held');
  expect(mutate).not.toHaveBeenCalled();
  expect(owner.getSession('pod')).toBe('pod');
  await expect(owner.adoptSource('pod')).resolves.toBe('pod');
  expect(registry.isActive('pod')).toBe(false);
});
it('preserves promise identity, shorthand reads and replacement control methods', async () => {
  const registry = createControlOperationRegistry();
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getSession = () => 'pod';
  const touchHeartbeat = () => {};
  const owner = registry.wrap({
    getSession,
    touchHeartbeat,
    completeSession: (_id: string) => promise,
  });
  expect(owner.getSession).toBe(getSession);
  expect(owner.touchHeartbeat).toBe(touchHeartbeat);
  expect(owner.completeSession('pod')).toBe(promise);
  release();
  await promise;
  const replacement = vi.fn(async (_id: string) => {});
  owner.completeSession = replacement;
  await owner.completeSession('pod');
  expect(replacement).toHaveBeenCalledExactlyOnceWith('pod');
});
it('preserves facade this-binding and counts overlapping nested controls independently', async () => {
  const registry = createControlOperationRegistry();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = registry.wrap({
    async inner(_id: string) {
      await gate;
    },
    async outer(id: string) {
      await this.inner(id);
    },
  });
  const first = owner.outer('pod');
  const second = owner.inner('pod');
  expect(registry.isActive('pod')).toBe(true);
  release();
  await Promise.all([first, second]);
  expect(registry.isActive('pod')).toBe(false);
});
