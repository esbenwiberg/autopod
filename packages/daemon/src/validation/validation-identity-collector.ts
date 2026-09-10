import { createHash } from 'node:crypto';
import type { ValidationInputIdentity } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { daemonRelease } from '../release.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

// Runs in the same working directory and effective environment as the check. Only
// hashes leave the container; no credential values or file contents are returned.
export const VALIDATION_IDENTITY_PROBE = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const manifest = JSON.parse(process.argv[1]);
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
let files = 0, bytes = 0;
async function fingerprint(inputs) {
  const digest = crypto.createHash('sha256');
  async function visit(input, ancestors) {
    const resolved = fs.realpathSync(input);
    const stat = fs.statSync(resolved);
    if (++files > 100000 || ancestors.has(resolved)) throw new Error('input boundary unavailable');
    digest.update(JSON.stringify([input, resolved, stat.mode, stat.size]));
    if (stat.isDirectory()) {
      const next = new Set([...ancestors, resolved]);
      for (const name of fs.readdirSync(resolved).sort()) await visit(path.join(resolved, name), next);
    } else if (stat.isFile()) {
      for await (const chunk of fs.createReadStream(resolved)) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 ** 3) throw new Error('input boundary too large');
        digest.update(chunk);
      }
    } else throw new Error('unversioned device or socket');
  }
  for (const input of [...inputs].sort()) await visit(input, new Set());
  return digest.digest('hex');
}
(async () => {
  const status = cp.execFileSync('git', ['status','--porcelain','--untracked-files=all'], {encoding:'utf8'});
  if (status.trim()) throw new Error('source not clean');
  const tree = cp.execFileSync('git', ['rev-parse','HEAD^{tree}'], {encoding:'utf8'}).trim();
  if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error('tree unavailable');
  const root = cp.execFileSync('git', ['rev-parse','--show-toplevel'], {encoding:'utf8'}).trim();
  const resolveInput = input => path.isAbsolute(input) ? input : path.join(root, input);
  const resolveCommand = name => {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(dir, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
    throw new Error('command identity unavailable');
  };
  const tracked = cp.execFileSync('git', ['ls-files','-z'], {cwd:root,encoding:'utf8',maxBuffer:10000000}).split('\0').filter(Boolean);
  const sourceFiles = await fingerprint(tracked.map(resolveInput));
  const toolchain = await fingerprint([...manifest.toolchainFiles.map(resolveInput), process.execPath, resolveCommand('git'), resolveCommand('sh')]);
  const dependencies = await fingerprint(manifest.dependencyPaths.map(resolveInput));
  const environmentFiles = await fingerprint(manifest.environmentFiles.map(resolveInput));
  const env = Object.entries(process.env).sort(([a],[b]) => a.localeCompare(b));
  const cgroups = ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/cpu.max','/sys/fs/cgroup/memory/memory.limit_in_bytes','/sys/fs/cgroup/cpu/cpu.cfs_quota_us','/sys/fs/cgroup/cpu/cpu.cfs_period_us'].map(p => fs.existsSync(p) ? [p,fs.readFileSync(p,'utf8')] : [p,null]);
  process.stdout.write(JSON.stringify({sourceTree:hash(JSON.stringify([tree,sourceFiles])), toolchain, dependencies,
    environment:hash(JSON.stringify({env, environmentFiles, cgroups, revision:manifest.environmentRevision,
      os:[os.platform(),os.release(),os.arch()], versions:process.versions, uid:process.getuid?.(), gid:process.getgid?.()}))}));
})().catch(() => { process.stdout.write('null'); process.exitCode=1; });
`;

/** Opt-in manifest describes the complete hermetic read set; missing proofs disable reuse. */
export function createValidationIdentityCollector(
  cm: ContainerManager,
  config: ValidationEngineConfig,
  implementationOverride?: string,
): () => Promise<ValidationInputIdentity | undefined> {
  let implementationPromise: Promise<string | undefined> | undefined;
  return async () => {
    const manifest = config.contract?.validationEvidence;
    if (!manifest?.hermetic || manifest.version !== 1 || !cm.getExecutionMetadata) return undefined;
    try {
      implementationPromise ??= implementationOverride
        ? Promise.resolve(implementationOverride)
        : daemonRelease.source === 'build' &&
            /^[a-f0-9]{64}$/.test(daemonRelease.validationImplementationHash ?? '')
          ? Promise.resolve(daemonRelease.validationImplementationHash as string)
          : Promise.resolve(undefined);
      const implementation = await implementationPromise;
      if (!implementation || !/^[a-f0-9]{64}$/.test(implementation)) return undefined;
      const metadata = await cm.getExecutionMetadata(config.containerId);
      if (
        metadata.networkMode !== 'none' ||
        !metadata.imageDigest ||
        !/^sha256:[a-f0-9]{64}$/.test(metadata.imageDigest)
      )
        return undefined;
      const result = await cm.execInContainer(
        config.containerId,
        ['node', '-e', VALIDATION_IDENTITY_PROBE, JSON.stringify(manifest)],
        {
          cwd: config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace',
          timeout: 30000,
          ...(config.extraExecEnv ? { env: config.extraExecEnv } : {}),
        },
      );
      if (result.exitCode !== 0) return undefined;
      const captured = JSON.parse(result.stdout) as Record<string, unknown> | null;
      if (
        !captured ||
        ['sourceTree', 'toolchain', 'dependencies', 'environment'].some(
          (k) => typeof captured[k] !== 'string' || !/^[a-f0-9]{64}$/.test(captured[k] as string),
        )
      )
        return undefined;
      return {
        version: 1,
        hermetic: true,
        sourceTree: captured.sourceTree as string,
        toolchain: captured.toolchain as string,
        dependencies: captured.dependencies as string,
        contract: hash(config.contract),
        implementation,
        commands: hash({
          setup: config.validationSetupCommand,
          lint: config.lintCommand,
          test: config.testCommand,
          build: config.buildCommand,
          workDir: config.buildWorkDir,
          lintTimeout: config.lintTimeout,
          testTimeout: config.testTimeout,
          buildTimeout: config.buildTimeout,
        }),
        environment: hash({
          captured: captured.environment,
          metadata,
          containerId: config.containerId,
        }),
      };
    } catch {
      return undefined;
    }
  };
}
