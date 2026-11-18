import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManagedRuntimePort } from '../managed/managed-service.js';
import { startFixtureProcess } from './owned-fixture-process.js';

// Test only: the parent owns these children across SQLite reopen. This is not a sandbox
// or a runtime that can adopt arbitrary processes after the parent dies.
export function waveProcessRuntime(root: string) {
  const script = fileURLToPath(new URL('./wave-worker.mjs', import.meta.url));
  const start = startFixtureProcess<{ type: 'ready'; pid: number }>;
  const owned = new Map<string, ReturnType<typeof start>>();
  const worker = (id: string) => {
    const w = owned.get(id);
    assert(w, 'unknown fixture child');
    w.assertHealthy();
    return w;
  };
  const port: ManagedRuntimePort = {
    async preflight() {},
    async ensure(id, spec, checkpoint) {
      const pin = spec.effectiveGrant.scope.repositories[0]?.baseRevision;
      assert(pin);
      if (!owned.has(id))
        owned.set(id, start(script, [spec.startKey, pin], path.join(root, id), 40_000));
      const w = worker(id);
      const ready = await w.message;
      assert.equal(ready.type, 'ready');
      assert.equal(ready.pid, w.child.pid);
      checkpoint(id);
      return { runtimeRef: id };
    },
    async observe(id) {
      const { child } = worker(id);
      if (child.exitCode !== null || child.signalCode !== null)
        return { state: 'stopped', exitCode: child.exitCode ?? 1, consumedTokens: 0 };
      assert(child.pid);
      process.kill(child.pid, 0); // OS existence check on an owned, not-yet-reaped child.
      return { state: 'running', consumedTokens: 0 };
    },
    async stop(id) {
      await worker(id).dispose();
    },
    async extractOutput(id, staging) {
      assert.equal(worker(id).child.exitCode, 0);
      await cp(path.join(root, id, 'fixture-output'), staging, { recursive: true });
    },
  };
  return {
    port,
    async finish(id: string) {
      const w = worker(id);
      w.child.send('finish');
      assert.deepEqual(await w.exit, { code: 0, signal: null });
    },
    async live() {
      const result = new Map<string, number>();
      for (const [id, w] of owned) {
        if ((await port.observe(id)).state === 'running') {
          assert(w.child.pid);
          result.set(id, w.child.pid);
        }
      }
      return result;
    },
    count: () => owned.size,
    dispose: () => Promise.all([...owned.values()].map((w) => w.dispose())),
  };
}
