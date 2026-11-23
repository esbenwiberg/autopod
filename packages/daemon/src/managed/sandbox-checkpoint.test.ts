import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { expect, it, onTestFinished, vi } from 'vitest';
import { AzureSandboxApiClient } from '../containers/azure-sandbox-api-client.js';
import { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { withVerifiedCheckpointMirror } from '../orchestration/local-checkpoints.js';
import { verifyParentPrivateSource } from '../orchestration/parent-private-source.js';
import { requestTimeFixture } from '../test-utils/managed-fixture.js';
import { ManagedContainerRuntime } from './container-runtime.js';
import { PRIVATE_COMMIT_EFFECTS, PRIVATE_PARENT_VERIFIER } from './private-commit-policy.js';
import {
  allocateSandboxCheckpoint,
  sandboxTreeEntries,
  VERIFY_SANDBOX_PROJECTION,
  withSandboxCodingProjection,
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
it('stages fresh detached Git metadata from the selected revision and nothing from the source configuration', async () => {
  const s = await seed();
  s.git('remote', 'add', 'unrelated', 'https://example.invalid/ignored');
  s.git('config', 'fixture.marker', 'never-copy');
  s.git('tag', 'unrelated');
  await writeFile(path.join(s.repo, '.git', 'hooks', 'pre-commit'), 'unused fixture hook\n');
  await writeFile(path.join(s.repo, 'after.txt'), 'not part of the checkpoint\n');
  s.git('add', 'after.txt');
  s.git('commit', '-qm', 'after checkpoint');
  await withSandboxCodingProjection(s.repo, s.commit, async (dir, manifest) => {
    expect(await readdir(dir)).toEqual(['.agents', '.codex', '.git', 'MAPLE']);
    expect(await readFile(path.join(dir, '.git', 'HEAD'), 'utf8')).toBe(s.commit + '\n');
    const config = await readFile(path.join(dir, '.git', 'config'), 'utf8');
    expect(config).not.toMatch(/unrelated|fixture|never-copy/);
    const entries = JSON.parse(manifest);
    expect(entries.files).toMatchObject({
      'MAPLE/input.txt': createHash('sha256').update('12\n').digest('hex'),
      '.git/HEAD': createHash('sha256')
        .update(s.commit + '\n')
        .digest('hex'),
    });
    expect(Object.keys(entries.files).some((name) => name.startsWith('.git/objects/pack/'))).toBe(
      true,
    );
    expect(entries.dirs).not.toContain('.git/hooks');
  });
  expect(s.git('remote')).toBe('unrelated');
});

it('rejects oversized reachable history before staging or allocating a writable sandbox', async () => {
  const s = await seed();
  const data = path.join(s.repo, 'historical.bin');
  await writeFile(data, randomBytes(1100 * 1024));
  s.git('add', 'historical.bin');
  s.git('commit', '-qm', 'large reachable historical blob');
  s.git('rm', 'historical.bin');
  s.git('commit', '-qm', 'small current tree');
  const use = vi.fn();
  await expect(
    withSandboxCodingProjection(s.repo, s.git('rev-parse', 'HEAD'), use),
  ).rejects.toThrow('managed-git-operation-failed');
  expect(use).not.toHaveBeenCalled();
  expect(await readdir(s.root)).toEqual(['repo']);
});

it('uploads pinned assigned text and reviewed context without Git history, unrelated files, or worktree edits', async () => {
  const s = await seed();
  await writeFile(path.join(s.repo, 'README.md'), 'repository context\n');
  await writeFile(path.join(s.repo, 'historical.bin'), randomBytes(2 * 1024 * 1024));
  await writeFile(path.join(s.repo, 'MAPLE', 'other-role.txt'), 'not for this worker');
  s.git('add', 'README.md', 'historical.bin', 'MAPLE/other-role.txt');
  s.git('commit', '-qm', 'base too large for full projection');
  const commit = s.git('rev-parse', 'HEAD');
  const tree = s.git('rev-parse', 'HEAD^{tree}');
  await writeFile(path.join(s.repo, 'MAPLE', 'input.txt'), 'dirty\n');
  const scope = { tree, files: ['MAPLE/input.txt', 'docs/new.txt'] };
  let uploaded = '';
  const ensureManagedContainer = vi.fn(async (config: ContainerSpawnConfig) => {
    const input = config.volumes!.find((volume) => volume.container === '/repositories/fixture')!;
    expect(input.readOnly).toBe(true);
    uploaded = input.host;
    expect((await readdir(uploaded)).sort()).toEqual([
      '.agents',
      '.codex',
      'MAPLE',
      'README.md',
      'docs',
    ]);
    expect(await readdir(path.join(uploaded, 'docs'))).toEqual([]);
    expect(await readdir(path.join(uploaded, 'MAPLE'))).toEqual(['input.txt']);
    expect(await readFile(path.join(uploaded, 'MAPLE/input.txt'), 'utf8')).toBe('12\n');
    return 'runtime-scoped';
  });
  const execInContainer = vi.fn(async (_ref: string, args: string[]) => {
    const manifest = args[5]!;
    expect(args.slice(0, 5)).toEqual([
      'python3',
      '-I',
      '-c',
      VERIFY_SANDBOX_PROJECTION,
      '/repositories/fixture',
    ]);
    expect(args[6]).toBe('coding');
    expect(JSON.parse(manifest).files).toEqual({
      'MAPLE/input.txt': createHash('sha256').update('12\n').digest('hex'),
      'README.md': createHash('sha256').update('repository context\n').digest('hex'),
    });
    return { exitCode: 0, stdout: createHash('sha256').update(manifest).digest('hex'), stderr: '' };
  });
  const manager = { ensureManagedContainer, execInContainer } as unknown as ContainerManager;
  const config = {
    podId: 'managed-scoped',
    image: 'fixture',
    env: {},
    networkPolicyMode: 'deny-all',
    volumes: [
      { host: s.repo, container: '/repositories/fixture', readOnly: false },
      { host: s.root, container: '/output', readOnly: false },
    ],
  } as ContainerSpawnConfig;
  const checkpoint = { repository: 'fixture', commit, coding: true as const, scopedSource: scope };
  const reserve = vi.fn();
  await expect(allocateSandboxCheckpoint(manager, config, checkpoint, reserve)).resolves.toBe(
    'runtime-scoped',
  );
  expect(reserve).toHaveBeenCalledOnce();
  expect(ensureManagedContainer).toHaveBeenCalledOnce();
  expect(execInContainer).toHaveBeenCalledOnce();
  await expect(readdir(uploaded)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const scopedSource of [
    { ...scope, tree: '0'.repeat(40) },
    { ...scope, files: ['historical.bin'] },
    { ...scope, files: ['MAPLE'] },
    { ...scope, files: ['../untracked'] },
    { ...scope, files: ['readme.md'] },
  ])
    await expect(
      allocateSandboxCheckpoint(manager, config, { ...checkpoint, scopedSource }, reserve),
    ).rejects.toThrow();
  expect(reserve).toHaveBeenCalledOnce();
  expect(ensureManagedContainer).toHaveBeenCalledOnce();
});

it('rejects a valid Git bundle with a tracked executable before materializing a sandbox workspace', async () => {
  const s = await seed();
  s.git('update-index', '--chmod=+x', 'MAPLE/input.txt');
  s.git('commit', '-qm', 'mode');
  const writable = vi.fn();
  await expect(
    withSandboxCodingProjection(s.repo, s.git('rev-parse', 'HEAD'), writable),
  ).rejects.toThrow('sandbox-checkpoint-input');
  expect(writable).not.toHaveBeenCalled();
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
it.skipIf(!image || !socket).each([false, true])(
  'runs verified checkout, real supervisor and bounded Azure export offline (tampered upload: %s)',
  async (tamper) => {
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image) || !socket || !path.isAbsolute(socket))
      throw new Error('local pinned fixture image required');
    const s = await seed();
    const f = requestTimeFixture();
    onTestFinished(() => f.close());
    const docker = (...args: string[]) =>
      execFileSync('docker', ['--host', `unix://${socket}`, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
      }).trim();
    const id = docker(
      'run',
      '--detach',
      '--pull=never',
      '--network',
      'none',
      '--user',
      '0',
      '--entrypoint',
      'sleep',
      image,
      '60',
    );
    try {
      const logger = pino({ level: 'silent' });
      const api = new AzureSandboxApiClient(
        {
          subscriptionId: 'fixture',
          resourceGroup: 'fixture',
          location: 'swedencentral',
          sandboxGroup: 'fixture',
          credential: {
            async getToken() {
              return { token: 'fixture' };
            },
          },
          fetch: async (url, init) => {
            expect(String(url)).toContain(`/sandboxes/${id}/executeShellCommand`);
            expect(init?.method).toBe('POST');
            const body = JSON.parse(String(init?.body));
            const result = spawnSync(
              'docker',
              [
                '--host',
                `unix://${socket}`,
                'exec',
                '--user',
                body.user,
                id,
                '/bin/sh',
                '-c',
                body.command,
              ],
              { encoding: 'utf8', timeout: 10_000 },
            );
            if (result.error || result.status === null) throw new Error('fixture exec interrupted');
            return Response.json({
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.status,
            });
          },
        },
        logger,
      );
      const manager = new SandboxContainerManager(api, logger);
      // Simulate only the volume installation; the verifier and worker run in
      // a real isolated container, through the real Azure serialization and read-back.
      const checkpoints: string[] = [];
      vi.spyOn(manager, 'ensureManagedContainer').mockImplementation(async (config) => {
        const mount = config.volumes?.find(
          (volume) => volume.container === '/repositories/fixture-repo',
        );
        expect(mount?.readOnly).toBe(true);
        if (!mount) throw new Error('missing staged checkout');
        config.onCreated?.(id);
        docker('exec', id, 'mkdir', '-p', mount.container);
        docker('cp', `${mount.host}/.`, `${id}:${mount.container}`);
        docker('exec', id, 'chown', '-R', '0:0', '/repositories');
        docker('exec', id, 'chmod', '0755', '/repositories');
        docker('exec', id, 'chmod', '-R', 'a=rX', mount.container);
        docker('exec', id, 'mkdir', '-p', '/output');
        if (tamper)
          docker(
            'exec',
            id,
            '/bin/sh',
            '-c',
            "printf 'unexpected metadata\\n' >> /repositories/fixture-repo/.git/config",
          );
        return id;
      });
      const request = f.request;
      request.route.executionTarget = 'sandbox';
      request.task.kind = 'implementation';
      request.outputs.source = {
        mode: 'commit',
        repository: 'fixture-repo',
        remote: 'private',
        base: 'main',
        head: 'fixture/change',
      };
      request.outputs.artifacts = {
        mode: 'required',
        include: ['report.md'],
        requiredPaths: ['report.md'],
        limits: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 },
      };
      request.validation.verifierPolicy = PRIVATE_PARENT_VERIFIER;
      const scope = request.effectiveGrant.scope;
      scope.repositories = [
        {
          enrollmentId: 'fixture-repo',
          baseRevision: s.commit,
          access: 'write',
          remote: 'private',
          branchNamespace: 'fixture/',
        },
      ];
      scope.allowedEffects = [...PRIVATE_COMMIT_EFFECTS];
      scope.network.destinations = [];
      scope.identityBindings = [];
      const cp = { repository: 'fixture-repo', commit: s.commit, coding: true as const };
      const podId = 'managed-fixture';
      const now = Math.floor(Date.now() / 1000);
      request.effectiveGrant.budget.expiresAt = now + 60;
      let observedExit = false;
      const attach = vi.fn(async () => {
        expect(
          docker(
            'exec',
            '--user',
            'autopod',
            id,
            'git',
            '-C',
            '/repositories/fixture-repo',
            'rev-parse',
            'HEAD',
          ),
        ).toBe(s.commit);
      });
      const runtime = new ManagedContainerRuntime(
        [
          {
            route: request.route,
            manager,
            image: 'registry.example/worker@sha256:' + 'a'.repeat(64),
            sandboxCodingCheckpoints: true,
            command: [
              'python3',
              '-c',
              `import pathlib,subprocess
r=pathlib.Path('/repositories/fixture-repo')
subprocess.run(['git','-C',str(r),'status','--porcelain'],check=True)
p=r/'MAPLE/input.txt';p.write_text('24\\n')
subprocess.run(['git','-C',str(r),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-am','fixture'],check=True)
p.write_text('dirty and not exported\\n')
`,
              request.route.model,
              request.route.reasoning,
            ],
            quotaReady: async () => true,
            attachProviderChannel: attach,
            prepare: async () => ({
              podId,
              image: 'registry.example/worker@sha256:' + 'a'.repeat(64),
              env: {},
              exposeHostGateway: false,
              allowedHosts: [],
              networkPolicyMode: 'deny-all',
              sandboxCheckpoint: cp,
              workingDir: '/output',
              volumes: [
                { host: s.repo, container: '/repositories/fixture-repo', readOnly: false },
                { host: s.root, container: '/output', readOnly: false },
              ],
            }),
          },
        ],
        (ref) => (ref === id ? { request, podId, createdAt: now, observedExit } : null),
      );
      const binding = {
        podId,
        repository: cp.repository,
        base: cp.commit,
        specDigest: request.executionSpecDigest,
        maxBytes: 1024 * 1024,
      };
      await expect(runtime.exportPrivateHead(id, binding, () => {})).rejects.toThrow(
        'runtime-binding',
      );
      if (tamper) {
        await expect(
          runtime.ensure(podId, request, (ref) => checkpoints.push(ref)),
        ).rejects.toThrow('sandbox-checkpoint-upload-unverified');
        expect(checkpoints).toEqual([id]);
        expect(attach).not.toHaveBeenCalled();
        return;
      }
      await runtime.ensure(podId, request, (ref) => checkpoints.push(ref));
      expect(new Set(checkpoints)).toEqual(new Set([id]));
      expect(attach).toHaveBeenCalledOnce();
      await vi.waitFor(async () => {
        expect(await runtime.observe(id)).toMatchObject({ state: 'stopped', exitCode: 0 });
      });
      observedExit = true;
      const source = await runtime.exportPrivateHead(id, binding, () => {});
      const retained = await verifyParentPrivateSource(s.root, source.bundle, {
        base: cp.commit,
        commit: source.commit,
        tree: source.tree,
        allowlist: [{ kind: 'file', path: 'MAPLE/input.txt' }],
        maxBundleBytes: binding.maxBytes,
      });
      expect(retained.paths).toEqual(['MAPLE/input.txt']);
      expect(
        await withVerifiedCheckpointMirror(
          s.root,
          { predecessor: cp.commit, commit: source.commit, tree: source.tree },
          retained.bundle,
          async (mirror) =>
            execFileSync('git', ['show', `${source.commit}:MAPLE/input.txt`], {
              cwd: mirror,
              encoding: 'utf8',
            }),
        ),
      ).toBe('24\n');
    } finally {
      docker('rm', '-f', id);
    }
  },
  30_000,
);

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
