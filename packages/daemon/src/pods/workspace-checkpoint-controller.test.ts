import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceCheckpointResult } from '../worktrees/sandbox-workspace-checkpoint.js';
import {
  type CheckpointRecord,
  WorkspaceCheckpointController,
  type WorkspaceFingerprint,
} from './workspace-checkpoint-controller.js';

const fingerprint: WorkspaceFingerprint = {
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  dirty: true,
};
function success(sequence: number): WorkspaceCheckpointResult {
  return {
    sequence,
    sourceHead: fingerprint.head,
    sourceTree: fingerprint.tree,
    snapshotCommit: 'c'.repeat(40),
    snapshotTree: 'd'.repeat(40),
    transferVerified: true,
    bundleVerified: true,
    hostImported: true,
    lineageVerified: true,
    promoted: true,
    materialized: true,
    quarantineRef: 'refs/autopod-quarantine/pod/1',
  };
}
function harness() {
  let time = 100_000;
  const records: CheckpointRecord[] = [];
  const observe = vi.fn(async () => fingerprint);
  const checkpoint = vi.fn(async (_pod: string, _reason: string, sequence: number) =>
    success(sequence),
  );
  const controller = new WorkspaceCheckpointController({
    observe,
    checkpoint,
    records: {
      save: async (record) => {
        records.push(record);
      },
      latest: async () => records.at(-1) ?? null,
      latestVerified: async () => records.findLast((record) => !!record.verifiedAt) ?? null,
      incomplete: async () => records.filter((record) => !record.verifiedAt),
    },
    now: () => time,
    sleep: async () => {},
    random: () => 0.5,
    intervalMs: 30_000,
    durabilityLeaseMs: 60_000,
  });
  return {
    controller,
    checkpoint,
    records,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('WorkspaceCheckpointController interval and durability lease', () => {
  it('interval checkpoints changed dirty work once per interval', async () => {
    const h = harness();
    await h.controller.poll('pod');
    h.advance(30_000);
    await h.controller.poll('pod');
    await h.controller.poll('pod');
    expect(h.checkpoint).toHaveBeenCalledTimes(1);
    expect(h.checkpoint).toHaveBeenCalledWith('pod', 'interval', expect.any(Number));
  });

  it('durability lease marks dirty work degraded and blocks destruction', async () => {
    const h = harness();
    await h.controller.poll('pod');
    h.advance(60_001);
    expect((await h.controller.poll('pod')).degraded).toBe(true);
    expect(await h.controller.mayDestroy('pod')).toBe(false);
  });

  it('global semaphore bounds parallel checkpoint operations', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    const records: CheckpointRecord[] = [];
    const controller = new WorkspaceCheckpointController({
      observe: async () => fingerprint,
      checkpoint: async (_pod, _reason, sequence) => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return success(sequence);
      },
      records: {
        save: async (record) => {
          records.push(record);
        },
        latest: async () => records.at(-1) ?? null,
        latestVerified: async () => records.findLast((record) => !!record.verifiedAt) ?? null,
        incomplete: async () => [],
      },
      maxConcurrent: 1,
    });
    const first = controller.request('one', 'completion');
    const second = controller.request('two', 'completion');
    await new Promise((resolve) => setImmediate(resolve));
    expect(peak).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });
});

describe('WorkspaceCheckpointController checkpoint chaos matrix', () => {
  it('retries only typed retryable failures and never reports an unverified result as checkpointed', async () => {
    const h = harness();
    h.checkpoint.mockResolvedValueOnce({
      ...success(1),
      promoted: false,
      materialized: false,
      error: { phase: 'transfer', code: 'AZURE_429', retryable: true, message: 'retrying' },
    });
    const decision = await h.controller.request('pod', 'completion');
    expect(h.checkpoint).toHaveBeenCalledTimes(2);
    expect(decision.checkpointed).toBe(true);
  });

  it('coalesces duplicate requests and preserves the latest verified checkpoint on corruption', async () => {
    const h = harness();
    await h.controller.request('pod', 'completion');
    h.checkpoint.mockResolvedValue({
      ...success(2),
      transferVerified: false,
      promoted: false,
      materialized: false,
      error: {
        phase: 'hash',
        code: 'CHUNK_HASH_MISMATCH',
        retryable: false,
        message: 'corrupt chunk',
      },
    });
    const [one, two] = await Promise.all([
      h.controller.request('pod', 'destructive'),
      h.controller.request('pod', 'destructive'),
    ]);
    expect(one.checkpointed).toBe(false);
    expect(two.result?.error?.code).toBe('CHUNK_HASH_MISMATCH');
    expect(await h.controller.mayDestroy('pod')).toBe(true);
  });
});
