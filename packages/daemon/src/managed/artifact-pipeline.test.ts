import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { fixture } from '../test-utils/managed-fixture.js';
import { ArtifactExports } from './artifact-exports.js';
import { ManagedArtifactPipeline } from './artifact-pipeline.js';
import { MemoryArtifactStore } from './artifact-store.js';
import { ManagedControls } from './managed-controls.js';

it('required research export completes after observed exit and does not rerun the worker or extraction on replay', async () => {
  const f = fixture();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-pipeline-')));
  try {
    const service = f.service();
    const controls = new ManagedControls(service);
    const store = new MemoryArtifactStore();
    const exports = new ArtifactExports(f.db, store);
    const pipeline = new ManagedArtifactPipeline(service, exports, root, controls);
    let extractions = 0;
    f.runtime.extractOutput = async (_ref, dest) => {
      extractions++;
      await mkdir(dest);
      await writeFile(path.join(dest, 'research.md'), '# Research');
    };
    const handle = await service.start('installation-one', f.request);
    await expect(pipeline.finish('installation-one', handle.podId)).rejects.toThrow(
      'not-observed-exited',
    );
    await f.runtime.stop(handle.podId);
    await service.enforceExpiry();
    await pipeline.tick();
    const result = controls.observe('installation-one', handle.podId, '0').result;
    expect(result.state).toBe('complete');
    expect(result.artifacts).toHaveLength(1);
    expect(result.source).toEqual([]);
    expect(result.evidence[0]?.name).toBe('artifact-integrity');
    await pipeline.tick();
    expect(extractions).toBe(1);
    expect(f.launches()).toBe(1);
  } finally {
    f.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('missing required output becomes one visible limitation, without completion or agent retry', async () => {
  const f = fixture();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-pipeline-')));
  try {
    const service = f.service();
    const controls = new ManagedControls(service);
    const pipeline = new ManagedArtifactPipeline(
      service,
      new ArtifactExports(f.db, new MemoryArtifactStore()),
      root,
      controls,
    );
    let extractions = 0;
    f.runtime.extractOutput = async (_ref, dest) => {
      extractions++;
      await mkdir(dest);
    };
    const handle = await service.start('installation-one', f.request);
    await f.runtime.stop(handle.podId);
    await service.enforceExpiry();
    await pipeline.tick();
    await pipeline.tick();
    const result = controls.observe('installation-one', handle.podId, '0').result;
    expect(result.state).toBe('review_required');
    expect(result.artifacts).toEqual([]);
    expect(result.limitations).toEqual(['artifact-export-incomplete']);
    expect(extractions).toBe(1);
    expect(f.launches()).toBe(1);
  } finally {
    f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reports a nonzero managed agent exit separately from artifact export failure', async () => {
  const f = fixture();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-pipeline-')));
  try {
    const service = f.service();
    const controls = new ManagedControls(service);
    const pipeline = new ManagedArtifactPipeline(
      service,
      new ArtifactExports(f.db, new MemoryArtifactStore()),
      root,
      controls,
    );
    f.runtime.extractOutput = async () => {
      throw new Error('managed-agent-exit-failed');
    };
    const handle = await service.start('installation-one', f.request);
    await f.runtime.stop(handle.podId);
    await service.enforceExpiry();
    f.db
      .prepare('INSERT INTO managed_results (pod_id,limitations_json) VALUES (?,?)')
      .run(handle.podId, '["agent-request-limit-reached"]');
    await pipeline.tick();

    const result = controls.observe('installation-one', handle.podId, '0').result;
    expect(result.state).toBe('review_required');
    expect(result.limitations).toEqual(['agent-request-limit-reached', 'agent-runtime-failed']);
    expect(result.artifacts).toEqual([]);
    expect(f.launches()).toBe(1);
  } finally {
    f.close();
    await rm(root, { recursive: true, force: true });
  }
});
