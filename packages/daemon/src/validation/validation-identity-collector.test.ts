import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ContainerManager, ExecOptions } from '../interfaces/container-manager.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { createValidationIdentityCollector } from './validation-identity-collector.js';

const execAsync = promisify(execFile);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'validation-inputs-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), 'inputs/\n');
  writeFileSync(join(root, 'source.cjs'), 'module.exports = (value) => value + 1;\n');
  mkdirSync(join(root, 'inputs'));
  for (const name of ['tool', 'dependency', 'environment'])
    writeFileSync(join(root, 'inputs', name), `${name}-v1`);
  git('add', '.');
  git(
    '-c',
    'user.name=Local Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  let imageDigest = `sha256:${'a'.repeat(64)}`;
  let secret = 'local-only-fixture-value';
  let networkMode = 'none';
  const cm = {
    getExecutionMetadata: async () => ({
      imageDigest,
      memoryLimitBytes: 1024,
      cpuLimit: 1,
      networkMode,
    }),
    execInContainer: async (_id: string, command: string[], options?: ExecOptions) => {
      try {
        const result = await execAsync(command[0] as string, command.slice(1), {
          cwd: root,
          env: { ...process.env, ...options?.env, CACHE_SECRET: secret },
          timeout: 10000,
        });
        expect(result.stdout).not.toContain(secret);
        return { ...result, exitCode: 0 };
      } catch {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
    },
  } as unknown as ContainerManager;
  const config: ValidationEngineConfig = {
    podId: 'fixture',
    containerId: 'fixture',
    previewUrl: '',
    buildCommand: 'node build.cjs',
    lintCommand: 'node lint.cjs',
    testCommand: 'node test.cjs',
    startCommand: '',
    healthPath: '/',
    healthTimeout: 1,
    smokePages: [],
    attempt: 1,
    task: 'check',
    diff: '',
    contract: {
      contractVersion: 1,
      title: 'Fixed input boundary',
      dependsOn: [],
      scenarios: [],
      requiredFacts: [],
      humanReview: [],
      validationEvidence: {
        version: 1,
        hermetic: true,
        toolchainFiles: ['inputs/tool'],
        dependencyPaths: ['inputs/dependency'],
        environmentFiles: ['inputs/environment'],
        environmentRevision: 'b'.repeat(64),
      },
    },
  };
  return {
    root,
    git,
    config,
    cm,
    setNetwork: (value: string) => {
      networkMode = value;
    },
    setImage: (value: string) => {
      imageDigest = value;
    },
    setSecret: (value: string) => {
      secret = value;
    },
  };
}

describe('actual validation input collection', () => {
  it('fingerprints real source, dependencies, tools, environment and backend image without returning secret contents', async () => {
    const f = fixture();
    try {
      const collect = createValidationIdentityCollector(f.cm, f.config, 'c'.repeat(64));
      const original = await collect();
      expect(original?.hermetic).toBe(true);
      expect(await collect()).toEqual(original);
      writeFileSync(join(f.root, 'inputs/dependency'), 'dependency-v2');
      expect((await collect())?.dependencies).not.toBe(original?.dependencies);
      writeFileSync(join(f.root, 'inputs/tool'), 'tool-v2');
      expect((await collect())?.toolchain).not.toBe(original?.toolchain);
      f.setSecret('changed-local-fixture-value');
      expect((await collect())?.environment).not.toBe(original?.environment);
      f.setImage(`sha256:${'d'.repeat(64)}`);
      expect((await collect())?.environment).not.toBe(original?.environment);
      f.git('update-index', '--assume-unchanged', 'source.cjs');
      writeFileSync(join(f.root, 'source.cjs'), 'module.exports = (value) => value - 1;\n');
      expect((await collect())?.sourceTree).not.toBe(original?.sourceTree);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
  it('declines reuse for unknown image, missing declared files or uncommitted source', async () => {
    const f = fixture();
    try {
      const collect = createValidationIdentityCollector(f.cm, f.config, 'c'.repeat(64));
      f.setNetwork('bridge');
      expect(await collect()).toBeUndefined();
      f.setNetwork('none');
      f.setImage('mutable-tag');
      expect(await collect()).toBeUndefined();
      f.setImage(`sha256:${'d'.repeat(64)}`);
      rmSync(join(f.root, 'inputs/environment'));
      expect(await collect()).toBeUndefined();
      writeFileSync(join(f.root, 'inputs/environment'), 'restored');
      writeFileSync(join(f.root, 'source.cjs'), 'uncommitted');
      expect(await collect()).toBeUndefined();
      expect(
        await createValidationIdentityCollector(
          f.cm,
          { ...f.config, contract: undefined },
          'c'.repeat(64),
        )(),
      ).toBeUndefined();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
});
