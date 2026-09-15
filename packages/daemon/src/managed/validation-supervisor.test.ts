import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, 'runtime/validation-supervisor.py');
const git =
  process.platform === 'darwin' ? '/Library/Developer/CommandLineTools/usr/bin/git' : 'git';

async function setup(command: string, expiresAt = Math.floor(Date.now() / 1000) + 30) {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-validation-supervisor-'));
  const source = path.join(root, 'source');
  const workspace = path.join(root, 'workspace');
  await mkdir(source);
  await writeFile(path.join(source, 'README.md'), 'frozen source\n');
  execFileSync('git', ['init', '--quiet'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'validation-supervisor@autopod.invalid'], {
    cwd: source,
  });
  execFileSync('git', ['config', 'user.name', 'AutoPod Validation Supervisor'], {
    cwd: source,
  });
  execFileSync('git', ['add', 'README.md'], { cwd: source });
  execFileSync('git', ['commit', '--quiet', '-m', 'frozen source'], { cwd: source });
  execFileSync('git', ['checkout', '--detach', '--quiet'], { cwd: source });
  const newCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
  }).trim();
  await writeFile(
    path.join(root, 'launch.json'),
    JSON.stringify({
      specDigest: 'spec',
      configurationDigest: 'configuration',
      candidateDigest: 'candidate',
      newCommit,
      expiresAt,
      workerUid: process.getuid?.(),
      workerGid: process.getgid?.(),
      source,
      workspace,
      phases: [{ phase: 'build', command, timeoutMs: 5000, cwd: workspace }],
    }),
  );
  return { root, source, workspace, newCommit };
}

async function cleanup(fixture: Awaited<ReturnType<typeof setup>>) {
  try {
    execFileSync('chmod', ['-R', 'u+w', fixture.root]);
  } catch {}
  await rm(fixture.root, { recursive: true, force: true });
}

it('provides locked-down Git metadata for source-aware validation commands', async () => {
  const fixture = await setup(
    `${git} rev-parse --verify HEAD >/dev/null && ${git} ls-files --error-unmatch README.md >/dev/null`,
  );
  try {
    execFileSync('/usr/bin/python3', [script, fixture.root]);
    expect(await receipt(fixture.root)).toMatchObject({
      observedExit: true,
      result: 'passed',
      phases: [{ phase: 'build', status: 'passed' }],
    });
    const metadata = path.join(fixture.root, 'git');
    expect(await readFile(path.join(metadata, 'HEAD'), 'utf8')).toBe(`${fixture.newCommit}\n`);
    expect((await stat(metadata)).mode & 0o222).toBe(0);
    expect((await stat(path.join(metadata, 'config'))).mode & 0o222).toBe(0);
    await expect(stat(path.join(fixture.workspace, '.git'))).rejects.toThrow();
    const config = await readFile(path.join(metadata, 'config'), 'utf8');
    expect(config).toContain('hooksPath = /dev/null');
    expect(config).not.toContain('[remote');
  } finally {
    await cleanup(fixture);
  }
});

async function receipt(root: string) {
  return JSON.parse(await readFile(path.join(root, 'execution.json'), 'utf8')) as {
    state: string;
    observedExit: boolean;
    result: string;
    reason: string;
    phases: Array<{ phase: string; status: string }>;
  };
}

async function waitFor(
  root: string,
  predicate: (value: Awaited<ReturnType<typeof receipt>>) => boolean,
) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const value = await receipt(root);
      if (predicate(value)) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('validation-supervisor-test-timeout');
}

it('runs an exact plan once and preserves frozen source files', async () => {
  const fixture = await setup(
    "python3 -c \"from pathlib import Path; p=Path('count'); p.write_text(str(int(p.read_text())+1) if p.exists() else '1')\"",
  );
  try {
    execFileSync('/usr/bin/python3', [script, fixture.root]);
    execFileSync('/usr/bin/python3', [script, fixture.root]);
    expect(await receipt(fixture.root)).toMatchObject({
      observedExit: true,
      result: 'passed',
      phases: [{ phase: 'build', status: 'passed' }],
    });
    expect(await readFile(path.join(fixture.workspace, 'count'), 'utf8')).toBe('1');
  } finally {
    await cleanup(fixture);
  }
});

it.each([
  ['command-failed', 'exit 7', 'failed'],
  ['source-mutated', "printf 'changed' > README.md", 'failed'],
  ['expired', 'exit 0', 'unavailable'],
] as const)('records %s without claiming a pass', async (reason, command, result) => {
  const fixture = await setup(
    command,
    reason === 'expired' ? Math.floor(Date.now() / 1000) - 1 : undefined,
  );
  try {
    execFileSync('/usr/bin/python3', [script, fixture.root]);
    expect(await receipt(fixture.root)).toMatchObject({ observedExit: true, result, reason });
  } finally {
    await cleanup(fixture);
  }
});

it('rejects a writable dependency cache as unavailable infrastructure', async () => {
  const fixture = await setup('exit 0');
  const dependencyCache = path.join(fixture.root, 'dependency-cache');
  try {
    await mkdir(dependencyCache);
    await chmod(dependencyCache, 0o777);
    const launchPath = path.join(fixture.root, 'launch.json');
    const launch = JSON.parse(await readFile(launchPath, 'utf8')) as Record<string, unknown>;
    await writeFile(launchPath, JSON.stringify({ ...launch, dependencyCache }));
    execFileSync('/usr/bin/python3', [script, fixture.root]);
    expect(await receipt(fixture.root)).toMatchObject({
      observedExit: true,
      result: 'unavailable',
      reason: 'dependency-cache-untrusted',
    });
  } finally {
    await cleanup(fixture);
  }
});

it('survives its caller and observes revocation before reporting terminal state', async () => {
  const fixture = await setup('python3 -c "import time; time.sleep(20)"');
  try {
    execFileSync('/usr/bin/python3', [script, fixture.root, '--detach']);
    await waitFor(fixture.root, (value) => value.state === 'running');
    await writeFile(path.join(fixture.root, 'revoked'), 'true');
    expect(await waitFor(fixture.root, (value) => value.observedExit)).toMatchObject({
      result: 'unavailable',
      reason: 'revoked',
      phases: [{ phase: 'build', status: 'failed' }],
    });
  } finally {
    await writeFile(path.join(fixture.root, 'revoked'), 'true').catch(() => {});
    await cleanup(fixture);
  }
});
