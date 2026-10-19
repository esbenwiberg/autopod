import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
import {
  isAcrQualifiedImage,
  resolvePodSpawnImage,
  verifySandboxWarmImageAccess,
} from './provisioning-image-policy.js';
import {
  ensureSeriesArtifactsDir,
  materializeSpecContextFiles,
  normalizeCommitEmail,
  resolveSpecFilePath,
  safeFsSegment,
} from './provisioning-materials.js';
import {
  buildAgentEnvFile,
  buildCodeIntelligenceServers,
  repairSandboxAgentHomeOwnership,
} from './provisioning-runtime-files.js';
const fixtures: ReturnType<typeof createProvisioningFixture>[] = [];
function fixture() {
  const f = createProvisioningFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
});
describe('provisioning policy and local material', () => {
  it('rejects escaping spec paths and retains nested relative paths', () => {
    const f = fixture();
    expect(resolveSpecFilePath(f.directory, 'nested/spec.md')).toBe(
      join(f.directory, 'nested/spec.md'),
    );
    expect(() => resolveSpecFilePath(f.directory, '../escape')).toThrow(
      expect.objectContaining({ code: 'INVALID_SPEC_FILE_PATH' }),
    );
    expect(safeFsSegment('a/b?c')).toBe('a_b_c');
    expect(safeFsSegment('')).toBe('unknown');
  });
  it('resets context files and keeps series artifacts in the selected private data directory', async () => {
    const f = fixture();
    const root = await materializeSpecContextFiles(
      'prepare',
      [{ path: 'nested/a.md', content: 'first' }],
      f.deps.logger,
    );
    if (!root) throw new Error('Missing context root');
    expect(readFileSync(join(root, 'nested/a.md'), 'utf8')).toBe('first');
    await materializeSpecContextFiles(
      'prepare',
      [{ path: 'new.md', content: 'second' }],
      f.deps.logger,
    );
    expect(existsSync(join(root, 'nested/a.md'))).toBe(false);
    expect(readFileSync(join(root, 'new.md'), 'utf8')).toBe('second');
    expect(await materializeSpecContextFiles('prepare', [], f.deps.logger)).toBeNull();
    const series = await ensureSeriesArtifactsDir(
      { ...f.pod(), seriesId: 'series/one' },
      f.deps.logger,
    );
    expect(series).toBe(join(f.directory, 'pod-artifacts', 'series_one'));
    expect(existsSync(join(series ?? '', 'handovers'))).toBe(true);
  });
  it('commits only changed spec paths and hashes allowed deployment scripts from actual local Git', async () => {
    const f = fixture();
    const root = join(f.directory, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/deploy.sh'), 'echo initial\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'Initial',
    ]);
    vi.mocked(f.worktreeManager.commitFiles).mockImplementation(async (cwd, paths, message) => {
      execFileSync('git', ['-C', cwd, 'add', '--', ...paths]);
      execFileSync('git', [
        '-C',
        cwd,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        message,
      ]);
    });
    const files = [
      { path: 'spec/task.md', content: 'Task bytes\n' },
      { path: 'scripts/deploy.sh', content: 'echo initial\n' },
    ];
    const sha = await f.materials.materializeSpecFiles(
      root,
      files,
      f.worktreeManager,
      f.deps.logger,
    );
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(f.worktreeManager.commitFiles).toHaveBeenCalledExactlyOnceWith(
      root,
      ['spec/task.md'],
      'docs(spec): add pod spec files',
    );
    await f.materials.materializeSpecFiles(root, files, f.worktreeManager, f.deps.logger);
    expect(f.worktreeManager.commitFiles).toHaveBeenCalledOnce();
    expect(
      await f.materials.captureDeployBaselineHashes(
        join(root, '.git'),
        'HEAD',
        ['scripts/*.sh'],
        f.deps.logger,
      ),
    ).toEqual({ 'scripts/deploy.sh': createHash('sha256').update('echo initial\n').digest('hex') });
    expect(
      await f.materials.captureDeployBaselineHashes(
        join(root, '.git'),
        'missing',
        undefined,
        f.deps.logger,
      ),
    ).toBeNull();
  });
  it('quotes environment bytes for actual shell sourcing and rejects invalid names', () => {
    const f = fixture();
    const value = "line one\nO'Connor;$literal";
    const file = join(f.directory, 'env.sh');
    writeFileSync(file, buildAgentEnvFile({ SAFE: value }));
    expect(
      execFileSync('sh', ['-c', '. "$1"; printf "%s" "$SAFE"', 'sh', file], { encoding: 'utf8' }),
    ).toBe(value);
    expect(() => buildAgentEnvFile({ 'BAD-NAME': 'x' })).toThrow('Invalid agent env var name');
    expect(normalizeCommitEmail(' developer ')).toBe('developer@autopod.local');
    expect(normalizeCommitEmail(' person@example.test ')).toBe('person@example.test');
    expect(normalizeCommitEmail(null)).toBeNull();
  });
  it('retains image guards and optional warm-image verification', async () => {
    const f = fixture();
    const profile = f.profiles.get('test-profile');
    expect(resolvePodSpawnImage(profile, 'node22', 'local')).toContain('node22');
    expect(() => resolvePodSpawnImage(profile, 'node22', 'sandbox')).toThrow(
      expect.objectContaining({ code: 'SANDBOX_WARM_IMAGE_REQUIRED' }),
    );
    expect(isAcrQualifiedImage('example.azurecr.io/autopod/test:latest')).toBe(true);
    expect(isAcrQualifiedImage('local:latest')).toBe(false);
    const warm = { ...profile, warmImageTag: 'example.azurecr.io/autopod/test:latest' };
    expect(resolvePodSpawnImage(warm, 'node22', 'sandbox')).toBe(warm.warmImageTag);
    await expect(
      verifySandboxWarmImageAccess(warm, warm.warmImageTag, async () => false),
    ).rejects.toThrow('not found');
    await expect(verifySandboxWarmImageAccess(warm, warm.warmImageTag)).resolves.toBeUndefined();
  });
  it('retains code-intel definitions and sandbox infrastructure error identity', async () => {
    const f = fixture();
    const servers = buildCodeIntelligenceServers({
      ...f.profiles.get('test-profile'),
      codeIntelligence: { serena: true, roslynCodeLens: true },
    });
    expect(servers.map((s) => s.name)).toEqual(['serena', 'roslyn-codelens']);
    expect(servers[0]?.args).toEqual([
      'start-mcp-server',
      '--context=claude-code',
      '--project=/workspace',
    ]);
    const error = new SandboxInfrastructureError(403, {});
    vi.mocked(f.cm.execInContainer).mockRejectedValueOnce(error);
    await expect(repairSandboxAgentHomeOwnership(f.cm, 'container', 'sandbox')).rejects.toBe(error);
    expect(error.message).toContain('repair agent home ownership');
  });
});
