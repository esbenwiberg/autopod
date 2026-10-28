import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { NativeGoalProcessIdentity } from '@autopod/shared';
import { vi } from 'vitest';
import type { StreamingExecResult } from '../interfaces/container-manager.js';
import { preserveSourceWorkspaces } from '../pods/source-adoption-preservation.js';
import { sourcePodFingerprint } from '../pods/source-adoption-repository.js';
import { createSourceContainerAdoption } from '../pods/source-container-adoption.js';
import { createMockContainerManager } from './mock-helpers.js';
import { createOperatorFixture } from './operator-helpers.js';
const exec = promisify(execFile);

/** Local fake data plane with real Git/process exits; never Docker/Azure or a model worker. */
export async function createSourceContainerFixture(options: { ignoredCollision?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'source-container-'));
  const host = path.join(root, 'host');
  const guest = path.join(root, 'guest');
  await mkdir(host);
  const git = (directory: string, ...args: string[]) =>
    exec('/usr/bin/git', [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-C',
      directory,
      ...args,
    ]);
  await git(host, 'init', '-b', 'repair');
  await writeFile(path.join(host, '.gitignore'), 'ignored-report.bin\n');
  await writeFile(path.join(host, 'code.txt'), 'original');
  await git(host, 'add', '.');
  await git(host, 'commit', '-m', 'original');
  const old = (await git(host, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(path.join(host, 'code.txt'), 'repaired');
  if (options.ignoredCollision) {
    await writeFile(path.join(host, 'ignored-report.bin'), 'target tracked content');
    await git(host, 'add', '-f', 'ignored-report.bin');
  }
  await git(host, 'commit', '-am', 'repaired');
  const target = (await git(host, 'rev-parse', 'HEAD')).stdout.trim();
  const tree = (await git(host, 'rev-parse', 'HEAD^{tree}')).stdout.trim();
  await git(host, 'update-ref', 'refs/autopod/source-adoption/source-adapter/old', old);
  await git(host, 'update-ref', 'refs/autopod/source-adoption/source-adapter/target', target);
  await git(host, 'reset', '--hard', old);
  const bundle = path.join(root, 'source.bundle');
  await git(
    host,
    'bundle',
    'create',
    bundle,
    'refs/autopod/source-adoption/source-adapter/old',
    'refs/autopod/source-adoption/source-adapter/target',
  );
  await exec('/usr/bin/git', [
    'clone',
    '--no-local',
    '--single-branch',
    '--branch',
    'repair',
    host,
    guest,
  ]);
  await writeFile(path.join(guest, 'ignored-report.bin'), Buffer.from([0, 1, 255]));
  const f = createOperatorFixture();
  const podId = f.pod().id;
  f.podRepo.update(podId, { worktreePath: host, branch: 'repair', lastValidationResult: null });
  f.events.transition(f.pod(), 'failed');
  const cm = {
    ...createMockContainerManager(),
    supportsExecRecovery: true,
    supportsStreamingExec: true,
    getResourceKey: vi.fn(async () => 'local:test-source'),
  };
  const transfer = path.join(root, 'guest-transfer');
  const map = (value: string) =>
    value
      .replaceAll('/tmp/.autopod-source-source-adapter', transfer)
      .replaceAll('/workspace', guest);
  let sequence = 0;
  vi.mocked(cm.execStreaming).mockImplementation(async (containerId, argv, options) => {
    const identity: NativeGoalProcessIdentity = {
      backend: 'docker',
      containerId,
      execId: `local-fixture-${++sequence}`,
      pidPath: `/tmp/local-fixture-${sequence}`,
    };
    options?.onProcessCreated?.(identity);
    const [program, ...args] = argv.map(map);
    if (!program) throw new Error('No fixture program');
    const child = spawn(program, args, { cwd: guest, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('spawn', () => options?.onProcessStarted?.(identity));
    const exitCode = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === null) reject(new Error(`Fixture process signal ${signal}`));
        else resolve(code);
      });
    });
    const result: StreamingExecResult = {
      stdout: child.stdout,
      stderr: child.stderr,
      exitCode,
      async kill() {
        child.kill('SIGTERM');
        await exitCode;
      },
    };
    return result;
  });
  vi.mocked(cm.writeFile).mockImplementation(async (_id, name, content) => {
    const destination = map(name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  });
  vi.mocked(cm.extractDirectoryFromContainer).mockImplementation(
    async (_id, _source, destination) => {
      await cp(guest, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
    },
  );
  const journal = f.podRepo.sourceAdoptions;
  if (!journal) throw new Error('No source journal');
  const pod = f.pod();
  journal.claim(
    'source-adapter',
    podId,
    {
      generation: pod.lifecycleGeneration,
      fingerprint: sourcePodFingerprint(pod),
      repository: 'https://github.com/org/repo',
      branch: 'repair',
      baseBranch: 'main',
      containerId: pod.containerId ?? '',
      worktreePath: host,
      resourceKey: 'local:test-source',
      oldHead: old,
      targetHead: target,
    },
    { type: 'human', userId: 'fixture-owner' },
    'Adopt exact repaired source',
    () => {},
  );
  const snapshots = await preserveSourceWorkspaces({
    containerManager: cm,
    containerId: pod.containerId ?? '',
    worktreePath: host,
    archiveRoot: path.join(root, 'archive'),
    generation: pod.lifecycleGeneration,
    assertCurrent: () => {},
  });
  journal.advance('source-adapter', 'claimed', 'preserved', {
    preservation: {
      ...snapshots,
      bundle,
      bundleHash: createHash('sha256')
        .update(await readFile(bundle))
        .digest('hex'),
      tree,
    },
  });
  const generation = f.podRepo.incrementLifecycleGeneration(podId);
  journal.advance('source-adapter', 'preserved', 'applying', { generation });
  const record = journal.get('source-adapter');
  if (!record) throw new Error('No source record');
  const adapter = createSourceContainerAdoption({
    record,
    journal,
    containerManager: cm,
    backend: 'docker',
    assertCurrent: () => {},
  });
  return { root, host, guest, git, old, target, tree, f, cm, journal, record, adapter, snapshots };
}
