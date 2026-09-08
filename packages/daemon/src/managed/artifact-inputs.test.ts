import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { fixture, resign } from '../test-utils/managed-fixture.js';
import { ArtifactExports } from './artifact-exports.js';
import { ManagedArtifactInputs } from './artifact-inputs.js';
import { MemoryArtifactStore } from './artifact-store.js';

it('rejects wrong digest before allocation; records exact immutable read-only input through restart', async () => {
  const f = fixture();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-input-')));
  try {
    let service = f.service();
    const store = new MemoryArtifactStore();
    const research = await service.start('installation-one', f.request);
    const output = path.join(root, 'output');
    await mkdir(output);
    await writeFile(path.join(output, 'research.md'), '# Exact research');
    const receipt = (await new ArtifactExports(f.db, store).export(
      {
        podId: research.podId,
        dispatcherAttemptId: f.request.dispatcherAttemptId,
        executionSpecDigest: f.request.executionSpecDigest,
      },
      output,
      f.request.outputs.artifacts,
      true,
    ))!;
    const plan = structuredClone(f.request);
    plan.dispatcherAttemptId = 'planning-attempt';
    plan.dispatcherJobId = 'planning-job';
    plan.startKey = 'planning-start';
    plan.effectiveGrant.dispatcherAttemptId = plan.dispatcherAttemptId;
    plan.inputArtifacts = [
      {
        name: 'research',
        backendArtifactId: receipt.artifactId,
        manifestSha256: receipt.manifestSha256,
        mountPath: '/inputs/research',
        access: 'read',
      },
    ];
    service.inputs = new ManagedArtifactInputs(f.db, store, path.join(root, 'inputs'));
    const wrong = structuredClone(plan);
    wrong.inputArtifacts[0]!.manifestSha256 = `sha256:${'0'.repeat(64)}`;
    resign(wrong);
    await expect(service.start('installation-one', wrong)).rejects.toThrow('digest-mismatch');
    expect(f.launches()).toBe(1);
    await expect(service.start('other-installation', resign(plan))).rejects.toThrow(
      'input-unavailable',
    );
    const handle = await service.start('installation-one', resign(plan));
    const mounted = service.inputs.mounts(handle.podId)[0]!;
    expect(mounted.readOnly).toBe(true);
    expect((await stat(path.join(mounted.hostPath, 'research.md'))).mode & 0o222).toBe(0);
    f.restart();
    service = f.service();
    service.inputs = new ManagedArtifactInputs(f.db, store, path.join(root, 'inputs'));
    await service.inputs.prepare(service.row('installation-one', handle.podId), plan);
    expect(service.inputs.mounts(handle.podId)).toEqual([mounted]);
    expect(f.launches()).toBe(2);
    await chmod(path.join(mounted.hostPath, 'research.md'), 0o644);
    await writeFile(path.join(mounted.hostPath, 'research.md'), 'replaced');
    await expect(
      service.inputs.prepare(service.row('installation-one', handle.podId), plan),
    ).rejects.toThrow('tree-mutated');
    plan.inputArtifacts[0]!.manifestSha256 = `sha256:${'1'.repeat(64)}`;
    await expect(service.start('installation-one', resign(plan))).rejects.toThrow('start-conflict');
  } finally {
    f.close();
    const writable = async (dir: string): Promise<void> => {
      await chmod(dir, 0o700);
      for (const entry of await readdir(dir, { withFileTypes: true }))
        if (entry.isDirectory()) await writable(path.join(dir, entry.name));
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  }
});
