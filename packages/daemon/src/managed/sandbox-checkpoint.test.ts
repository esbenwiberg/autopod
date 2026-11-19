import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { withVerifiedCheckpointMirror } from '../orchestration/local-checkpoints.js';
import {
  allocateSandboxCheckpoint,
  sandboxTreeEntries,
  VERIFY_SANDBOX_PROJECTION,
  withSandboxProjection,
} from './sandbox-checkpoint.js';

async function seed() {
  const root = await mkdtemp(path.join(tmpdir(), 'sandbox-input-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Inspector',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  await mkdir(path.join(repo, 'MAPLE'));
  await writeFile(path.join(repo, 'MAPLE/input.txt'), '12\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  const commit = git('rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'untracked'), 'do not upload');
  return { repo, git, commit, root };
}
it.each([
  Buffer.from([0x61, 0, 0x62]),
  Buffer.from([0xff]),
])('rejects a non-text case blob before commissioning', async (b) => {
  const s = await seed();
  await writeFile(path.join(s.repo, 'MAPLE/input.txt'), b);
  s.git('add', 'MAPLE');
  s.git('commit', '-qm', 'invalid case');
  await expect(sandboxTreeEntries(s.repo, s.git('rev-parse', 'HEAD'), ['MAPLE'])).rejects.toThrow(
    'case-text-invalid',
  );
});
it('projects only pinned regular blobs; local changes and unsupported links fail before an upload', async () => {
  const s = await seed();
  await withSandboxProjection(s.repo, s.commit, async (dir, manifest) => {
    expect((await readdir(dir)).sort()).toEqual(['.agents', '.codex', 'MAPLE']);
    expect(JSON.parse(manifest)).toEqual({
      'MAPLE/input.txt': createHash('sha256').update('12\n').digest('hex'),
    });
  });
  const use = vi.fn();
  await writeFile(path.join(s.repo, 'MAPLE/input.txt'), '13\n');
  await expect(withSandboxProjection(s.repo, s.commit, use)).rejects.toThrow('content');
  await symlink('untracked', path.join(s.repo, 'link'));
  s.git('add', '.');
  s.git('commit', '-qm', 'link');
  await expect(withSandboxProjection(s.repo, s.git('rev-parse', 'HEAD'), use)).rejects.toThrow(
    'input',
  );
  expect(await readdir(s.root)).toEqual(['repo']);
  expect(use).not.toHaveBeenCalled();
});
it('rejects a valid Git bundle with a tracked executable before materializing a sandbox workspace', async () => {
  const s = await seed();
  s.git('update-index', '--chmod=+x', 'MAPLE/input.txt');
  s.git('commit', '-qm', 'mode');
  const file = path.join(s.root, 'exec.bundle');
  s.git('bundle', 'create', file, 'HEAD');
  const subject = {
    commit: s.git('rev-parse', 'HEAD'),
    tree: s.git('rev-parse', 'HEAD^{tree}'),
    predecessor: s.commit,
  };
  await expect(
    withVerifiedCheckpointMirror(s.root, subject, await readFile(file), (mirror) =>
      sandboxTreeEntries(mirror, subject.commit),
    ),
  ).rejects.toThrow('sandbox-checkpoint-input');
});
it('rejects an unproven upload after recording the exact allocated identity', async () => {
  const s = await seed(),
    checkpoint = vi.fn();
  const config = {
    podId: 'managed-fixture',
    env: {},
    image: 'fixture',
    networkPolicyMode: 'deny-all',
    onCreated: checkpoint,
    volumes: [
      { host: s.repo, container: '/repositories/r', readOnly: true },
      { host: s.root, container: '/output', readOnly: false },
    ],
  } satisfies ContainerSpawnConfig;
  const manager = {
    ensureManagedContainer: vi.fn(async (c: ContainerSpawnConfig) => {
      expect(await readFile(path.join(c.volumes![0]!.host, 'MAPLE/input.txt'), 'utf8')).toBe(
        '12\n',
      );
      c.onCreated?.('remote-1');
      return 'remote-1';
    }),
    execInContainer: vi.fn(async () => ({ exitCode: 0, stdout: 'wrong', stderr: '' })),
  };
  await expect(
    allocateSandboxCheckpoint(manager as unknown as ContainerManager, config, {
      repository: 'r',
      commit: s.commit,
    }),
  ).rejects.toThrow('unverified');
  expect(checkpoint).toHaveBeenCalledWith('remote-1');
  expect(manager.ensureManagedContainer).toHaveBeenCalledTimes(1);
  expect(await readdir(s.root)).toEqual(['repo']);
});

const image = process.env.AUTOPOD_MANAGED_DOCKER_IMAGE,
  socket = process.env.AUTOPOD_MANAGED_DOCKER_SOCKET;
it.skipIf(!image || !socket)(
  'runs the actual sandbox receipt verifier as uid 1000: wrong content, extra files and writable roots fail',
  async () => {
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image) || !socket || !path.isAbsolute(socket))
      throw new Error('local verifier image required');
    const args = [
      '--host',
      'unix://' + socket,
      'run',
      '--rm',
      '--pull=never',
      '--user',
      '0',
      '--network',
      'none',
      '--entrypoint',
      'python3',
      image,
      '-c',
    ];
    const harness = `import hashlib,json,os,subprocess,sys,tempfile,pathlib
parent=pathlib.Path(tempfile.mkdtemp());parent.chmod(0o755);root=parent/'repo';root.mkdir()
(root/'.agents').mkdir();(root/'.codex').mkdir()
f=root/'sample';f.write_bytes(b'hello');f.chmod(0o444)
m=json.dumps({"sample":hashlib.sha256(b'hello').hexdigest()},separators=(',',':'))
def verify(ok):
 r=subprocess.run([sys.executable,'-c',sys.argv[1],str(root),m],capture_output=True,user=1000,group=1000)
 assert (r.returncode==0)==ok and (not ok or r.stdout.decode().strip()==hashlib.sha256(m.encode()).hexdigest()),r.stderr
verify(True)
f.write_bytes(b'wrong');verify(False)
f.write_bytes(b'hello');(root/'extra').touch();verify(False)
(root/'extra').unlink();root.chmod(0o777);verify(False)
`;
    execFileSync('docker', [...args, harness, VERIFY_SANDBOX_PROJECTION], {
      timeout: 15000,
      stdio: 'pipe',
    });
  },
  25000,
);
