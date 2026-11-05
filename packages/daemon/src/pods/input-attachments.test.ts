import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputBundleStore } from '../inputs/input-bundle-store.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

const roots: string[] = [];
const databases: ReturnType<typeof createTestContext>['db'][] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe('source-free reference provisioning', () => {
  it('persists and pins the reference, mounts exact bytes outside workspace and leaves Git unchanged', async () => {
    const context = createTestContext();
    databases.push(context.db);
    const root = mkdtempSync(join(tmpdir(), 'pod-inputs-'));
    roots.push(root);
    const repository = join(root, 'repo');
    execFileSync('git', ['init', '-q', repository]);
    writeFileSync(join(repository, 'README.md'), 'Repository source\n');
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'Initial',
    ]);
    const before = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    });
    vi.mocked(context.worktreeManager.create).mockResolvedValue({
      worktreePath: repository,
      bareRepoPath: join(root, 'bare.git'),
      startCommitSha: before.trim(),
    });
    vi.stubEnv('DATA_DIR', join(root, 'data'));
    const store = new InputBundleStore(context.db);
    const bytes = Buffer.from('<!doctype html><h1>Original wireframe</h1>');
    const upload = store.create(
      {
        requestKey: randomUUID(),
        files: [
          {
            path: 'wireframe.html',
            mediaType: 'text/html',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      'owner',
    );
    store.put(upload.id, 'owner', 0, bytes);
    const { status: _, ...ref } = store.seal(upload.id, 'owner');
    const manager = createPodManager(context.deps);
    const pod = manager.createSession(
      {
        profileName: 'test-profile',
        task: 'Implement the reference',
        skipValidation: true,
        inputBundle: ref,
      },
      'owner',
    );
    expect(context.podRepo.getOrThrow(pod.id).inputBundle).toEqual(ref);
    expect(
      context.db.prepare('SELECT bundle_id FROM pod_input_bundles WHERE pod_id=?').get(pod.id),
    ).toEqual({ bundle_id: ref.id });
    await manager.processPod(pod.id);
    const volume = vi
      .mocked(context.containerManager.spawn)
      .mock.calls[0]?.[0].volumes?.find((item) => item.container === '/autopod/inputs');
    expect(volume).toEqual({
      host: join(root, 'data/inputs', ref.id),
      container: '/autopod/inputs',
      readOnly: true,
    });
    expect(readFileSync(join(volume?.host ?? '', 'files/wireframe.html'))).toEqual(bytes);
    expect(context.worktreeManager.commitFiles).not.toHaveBeenCalled();
    expect(
      execFileSync('git', ['-C', repository, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).toBe('');
    expect(execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(
      before,
    );
    expect(store.sweep(Date.now() + 30 * 24 * 3600_000)).toBe(0);
  });
});
