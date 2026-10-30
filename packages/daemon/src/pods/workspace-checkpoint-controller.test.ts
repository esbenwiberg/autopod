import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    captureAuthority: () => () => {},
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
    observe,
    records,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('WorkspaceCheckpointController interval and durability lease', () => {
  it('refuses delayed queued checkpoint after custody changes and preserves original source/reports', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'queued-checkpoint-custody-'));
    const source = path.join(root, 'source.txt');
    const report = path.join(root, 'report.txt');
    await writeFile(source, 'original source');
    await writeFile(report, 'original partial report');
    let release = () => {};
    let started = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let held = false;
    const checkpoint = vi.fn(async (id: string, _reason: string, sequence: number) => {
      if (id === 'other') {
        started();
        await gate;
      } else {
        await writeFile(source, 'unsafe host promotion');
        await writeFile(report, 'unsafe guest checkpoint');
      }
      return success(sequence);
    });
    const controller = new WorkspaceCheckpointController({
      captureAuthority: (id: string) => () => {
        if (id === 'original' && held) throw new Error('Original validation custody held');
      },
      observe: async () => fingerprint,
      checkpoint,
      maxConcurrent: 1,
      records: {
        save: async () => {},
        latest: async () => null,
        latestVerified: async () => null,
        incomplete: async () => [],
      },
    });
    try {
      const first = controller.request('other', 'completion');
      await entered;
      const delayed = controller.poll('original');
      void delayed.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
      held = true;
      release();
      await first;
      await expect(delayed).rejects.toThrow('Original validation custody held');
      expect(checkpoint.mock.calls.filter(([id]) => id === 'original')).toHaveLength(0);
      expect(await readFile(source, 'utf8')).toBe('original source');
      expect(await readFile(report, 'utf8')).toBe('original partial report');
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rechecks captured authority after retry backoff before another guest checkpoint', async () => {
    let held = false;
    const checkpoint = vi.fn(async (_id: string, _reason: string, sequence: number) => ({
      ...success(sequence),
      promoted: false,
      materialized: false,
      error: { phase: 'capture', code: 'FAILED', retryable: true, message: 'Retryable failure' },
    }));
    const controller = new WorkspaceCheckpointController({
      captureAuthority: () => () => {
        if (held) throw new Error('Validation custody changed during backoff');
      },
      observe: async () => fingerprint,
      checkpoint,
      sleep: async () => {
        held = true;
      },
      records: {
        save: async () => {},
        latest: async () => null,
        latestVerified: async () => null,
        incomplete: async () => [],
      },
    });
    await expect(controller.request('original', 'completion')).rejects.toThrow(
      'Validation custody changed during backoff',
    );
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });
  it('interval checkpoints changed dirty work once per interval', async () => {
    const h = harness();
    await h.controller.poll('pod');
    h.advance(30_000);
    await h.controller.poll('pod');
    await h.controller.poll('pod');
    expect(h.checkpoint).toHaveBeenCalledTimes(1);
    expect(h.checkpoint).toHaveBeenCalledWith(
      'pod',
      'interval',
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('does not report degraded durability when the verified checkpoint matches the live tree', async () => {
    const h = harness();
    expect((await h.controller.poll('pod')).checkpointed).toBe(true);
    h.advance(60_001);
    // An idle agent leaves the same dirty tree in place: the checkpoint still covers it.
    expect((await h.controller.poll('pod')).degraded).toBe(false);
    h.advance(600_000);
    expect((await h.controller.poll('pod')).degraded).toBe(false);
    expect(h.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('reports degraded durability once unverified work outlives the lease', async () => {
    const h = harness();
    await h.controller.poll('pod');
    const edited: WorkspaceFingerprint = { ...fingerprint, tree: 'e'.repeat(40) };
    h.observe.mockResolvedValue(edited);
    h.checkpoint.mockResolvedValue({
      ...success(2),
      promoted: false,
      materialized: false,
      error: {
        phase: 'promotion',
        code: 'LINEAGE_CONFLICT',
        retryable: false,
        message: 'feature branch diverged from checkpoint source',
      },
    });
    h.advance(30_000);
    expect((await h.controller.poll('pod')).degraded).toBe(true);
    h.advance(10_000);
    // Inside the lease, the last verified checkpoint is still recent enough.
    expect((await h.controller.poll('pod')).degraded).toBe(false);
    h.advance(50_001);
    expect((await h.controller.poll('pod')).degraded).toBe(true);
    expect(await h.controller.mayDestroy('pod')).toBe(false);
  });

  it('reports degraded durability for dirty work that was never checkpointed', async () => {
    const h = harness();
    h.checkpoint.mockResolvedValue({
      ...success(1),
      promoted: false,
      materialized: false,
      error: { phase: 'capture', code: 'CHECKPOINT_FAILED', retryable: false, message: 'boom' },
    });
    await h.controller.poll('pod');
    h.advance(1_000);
    expect((await h.controller.poll('pod')).degraded).toBe(true);
  });

  it('keeps the lease on destruction even when the checkpoint still matches', async () => {
    const h = harness();
    await h.controller.poll('pod');
    h.advance(60_001);
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
      captureAuthority: () => () => {},
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
  it('continues a pod checkpoint sequence after a daemon restart', async () => {
    const persisted: CheckpointRecord = {
      podId: 'pod',
      sequence: 48,
      fingerprint,
      result: success(48),
      verifiedAt: new Date(90_000).toISOString(),
      attempts: 1,
      error: undefined,
    };
    const saved: CheckpointRecord[] = [];
    const checkpoint = vi.fn(async (_pod: string, _reason: string, sequence: number) =>
      success(sequence),
    );
    const controller = new WorkspaceCheckpointController({
      captureAuthority: () => () => {},
      observe: async () => fingerprint,
      checkpoint,
      records: {
        save: async (record) => {
          saved.push(record);
        },
        latest: async () => persisted,
        latestVerified: async () => persisted,
        incomplete: async () => [],
      },
      now: () => 100_000,
    });

    await controller.request('pod', 'completion');

    expect(checkpoint).toHaveBeenCalledWith('pod', 'completion', 49, expect.any(Function));
    expect(saved.map((record) => record.sequence)).toEqual([49]);
  });

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
