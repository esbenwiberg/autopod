import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pod } from '@autopod/shared';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  sandboxRecoveryFixture,
  sandboxValidationAbandonmentFixture,
} from '../test-utils/sandbox-recovery-helpers.js';
import { createControlOperationRegistry } from './control-operation-registry.js';
import { createFileRecovery } from './file-recovery.js';

const finalSourceRace = vi.hoisted(() => ({ onRealpath: undefined as (() => void) | undefined }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    realpath: async (p: Parameters<typeof actual.realpath>[0]) => {
      const value = await actual.realpath(p);
      finalSourceRace.onRealpath?.();
      return value;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  finalSourceRace.onRealpath = undefined;
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
it('keeps host copies independent of stopped originals, binds downloads to source/version/generation and never falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-recovery-'));
  roots.push(root);
  await writeFile(join(root, 'main.ts'), 'saved code');
  const pod = { id: 'p', lifecycleGeneration: 3, status: 'failed', worktreePath: root } as Pod;
  const original = vi.fn(async () => ({
    source: {
      id: 'original',
      kind: 'original' as const,
      label: 'Original',
      binding: '',
      status: 'stopped' as const,
      sandboxId: 's',
      detail: 'Stopped',
      files: [],
      truncated: false,
      skippedEntries: 0,
    },
  }));
  const service = createFileRecovery({ getPod: () => pod, original });
  const snapshot = await service.inspect('p');
  const source = snapshot.sources.find((x) => x.kind === 'saved')!;
  const file = source.files[0]!;
  const selection = {
    sourceId: source.id,
    binding: source.binding,
    generation: 3,
    path: file.path,
    version: file.version,
  };
  const result = await service.read('p', selection);
  expect(Buffer.from(result.content, 'base64').toString()).toBe('saved code');
  expect(original).toHaveBeenCalledTimes(1);
  await expect(service.read('p', { ...selection, binding: 'a'.repeat(64) })).rejects.toThrow();
  await expect(service.read('p', { ...selection, sourceId: 'missing' })).rejects.toThrow();
  pod.lifecycleGeneration++;
  await expect(service.read('p', selection)).rejects.toThrow();
  expect(original).toHaveBeenCalledTimes(1);
});
it('rechecks generation after the final asynchronous root inspection before returning saved bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'final-source-race-'));
  roots.push(root);
  await writeFile(join(root, 'a'), 'saved bytes');
  const pod = { id: 'p', lifecycleGeneration: 3, status: 'failed', worktreePath: root } as Pod;
  const service = createFileRecovery({
    getPod: () => ({ ...pod }),
    original: async () => ({
      source: {
        id: 'original',
        kind: 'original',
        label: 'Unavailable',
        binding: '',
        status: 'unavailable',
        detail: '',
        files: [],
        truncated: false,
        skippedEntries: 0,
      },
    }),
  });
  const snapshot = await service.inspect('p'),
    source = snapshot.sources[0]!,
    file = source.files[0]!;
  let inspections = 0;
  finalSourceRace.onRealpath = () => {
    if (++inspections === 2) pod.lifecycleGeneration++;
  };
  await expect(
    service.read('p', {
      sourceId: source.id,
      binding: source.binding,
      generation: 3,
      path: file.path,
      version: file.version,
    }),
  ).rejects.toThrow('selection changed');
  expect(inspections).toBe(2);
});

it('does not reinterpret a configured saved root symlink as another host directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'saved-root-link-'));
  roots.push(base);
  const workspace = join(base, 'workspace'),
    outside = join(base, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(workspace, 'a'), 'known copy');
  await writeFile(join(outside, 'secret'), 'not a pod file');
  const pod = { id: 'p', lifecycleGeneration: 3, status: 'failed', worktreePath: workspace } as Pod;
  const service = createFileRecovery({
    getPod: () => ({ ...pod }),
    original: async () => ({
      source: {
        id: 'original',
        kind: 'original',
        label: '',
        binding: '',
        status: 'unavailable',
        detail: '',
        files: [],
        truncated: false,
        skippedEntries: 0,
      },
    }),
  });
  const before = await service.inspect('p'),
    source = before.sources[0]!,
    file = source.files[0]!;
  await rm(workspace, { recursive: true });
  await symlink(outside, workspace);
  const after = await service.inspect('p');
  expect(after.sources[0]?.status).toBe('unavailable');
  expect(after.sources[0]?.files).toEqual([]);
  await expect(
    service.read('p', {
      sourceId: source.id,
      binding: source.binding,
      generation: 3,
      path: file.path,
      version: file.version,
    }),
  ).rejects.toThrow();
});

it('research without retained findings cannot fall back to a host workspace', async () => {
  const getPod = () =>
    ({
      id: 'p',
      completionPolicy: 'accept-findings',
      status: 'complete',
      worktreePath: '/never-read',
    }) as Pod;
  const original = vi.fn();
  const service = createFileRecovery({ getPod, original });
  await expect(service.inspect('p')).rejects.toThrow('retained findings receipt');
  expect(original).not.toHaveBeenCalled();
});
function originalFixture(pending = false) {
  const f = sandboxRecoveryFixture(pending);
  const cm = f.cm as typeof f.cm & Pick<ContainerManager, 'listRecoveryFiles' | 'readRecoveryFile'>;
  cm.listRecoveryFiles = vi.fn(async (_id, options) => {
    options.assertCurrent?.();
    return {
      files: [{ path: 'a', size: 1, modified: 0, version: 'a'.repeat(64) }],
      truncated: false,
      skippedEntries: 0,
    };
  });
  cm.readRecoveryFile = vi.fn(async (_id, path, _version, options) => {
    options.assertCurrent?.();
    return {
      path,
      size: 1,
      encoding: 'base64',
      content: 'YQ==',
      sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    };
  });
  return { ...f, cm };
}
it('never wakes stopped, unknown, active, custody-held or unsettled originals to list files', async () => {
  for (const mode of ['stopped', 'pending', 'active', 'custody', 'unsettled']) {
    const f =
      mode === 'unsettled'
        ? sandboxValidationAbandonmentFixture()
        : originalFixture(mode === 'pending');
    if (mode === 'active') f.setIdle(false);
    if (mode === 'custody')
      vi.spyOn(f.podRepo.sourceAdoptions!, 'assertDeletable').mockImplementation(() => {
        throw new Error('Source custody held');
      });
    const snapshot = await f.recovery.files.inspect('prepare');
    const source = snapshot.sources.find((x) => x.kind === 'original')!;
    expect(source.status).not.toBe('available');
    expect(source.files).toEqual([]);
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.deleteSession).not.toHaveBeenCalled();
  }
});
it('reads only the exact running original and keeps mutation guards active during read awaits', async () => {
  const f = originalFixture();
  f.setState('running');
  const before = f.pod();
  const metadata = await f.recovery.files.inspect('prepare');
  expect(metadata.sources.find((x) => x.kind === 'original')?.status).toBe('ready');
  expect(f.cm.listRecoveryFiles).not.toHaveBeenCalled();
  const snapshot = await f.recovery.files.inspect('prepare', true);
  const source = snapshot.sources.find((x) => x.kind === 'original')!;
  expect(source.status).toBe('available');
  const request = {
    sourceId: source.id,
    binding: source.binding,
    generation: snapshot.generation,
    path: 'a',
    version: 'a'.repeat(64),
  };
  f.cm.readRecoveryFile = vi.fn(async (_id, path, _version, options) => {
    expect(() => f.recovery.assertAvailable('prepare')).toThrow('in flight');
    options.assertCurrent?.();
    return {
      path,
      content: 'YQ==',
      encoding: 'base64',
      size: 1,
      sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    };
  });
  const registry = createControlOperationRegistry();
  const facade = registry.wrap({ readRecoveryFile: f.recovery.files.read });
  await expect(facade.readRecoveryFile('prepare', request)).resolves.toMatchObject({ path: 'a' });
  f.cm.getResourceKey.mockResolvedValue('different-namespace');
  await expect(facade.readRecoveryFile('prepare', request)).rejects.toThrow();
  expect(f.cm.readRecoveryFile).toHaveBeenCalledTimes(1);
  expect(f.pod()).toEqual(before);
  expect(f.cm.start).not.toHaveBeenCalled();
});
it('discards an original result if lifecycle/resource ownership changes during the remote read', async () => {
  const f = originalFixture();
  f.setState('running');
  const snapshot = await f.recovery.files.inspect('prepare', true);
  const source = snapshot.sources.find((x) => x.kind === 'original')!;
  f.cm.readRecoveryFile = vi.fn(async (_id, path) => {
    f.podRepo.update('prepare', { containerId: 'replacement' });
    return {
      path,
      content: 'YQ==',
      encoding: 'base64',
      size: 1,
      sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    };
  });
  await expect(
    f.recovery.files.read('prepare', {
      sourceId: source.id,
      binding: source.binding,
      generation: snapshot.generation,
      path: 'a',
      version: 'a'.repeat(64),
    }),
  ).rejects.toThrow();
});
