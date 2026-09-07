import { createHash } from 'node:crypto';
import type { TaskRetryIdentity } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { daemonRelease } from '../release.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Source content, not a commit ID or container ID. Only hashes leave the container. */
export const RETRY_IDENTITY_PROBE = String.raw`
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path'), crypto = require('node:crypto');
try {
  const root = cp.execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8',timeout:10000}).trim();
  const files = cp.execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:10000000}).split('\0').filter(Boolean);
  if (files.length > 100000) throw new Error('source bound');
  const digest = crypto.createHash('sha256'); let bytes=0;
  for (const name of [...new Set(files)].sort()) {
    digest.update(JSON.stringify(name)); let stat;
    try { stat=fs.lstatSync(path.join(root,name)); } catch(e) { if(e.code==='ENOENT') { digest.update('deleted'); continue; } throw e; }
    digest.update(String(stat.mode));
    if(stat.isSymbolicLink()) digest.update(fs.readlinkSync(path.join(root,name)));
    else if(stat.isFile()) { bytes+=stat.size; if(bytes>1024**3) throw new Error('source bound'); const fd=fs.openSync(path.join(root,name),'r'); try { const chunk=Buffer.alloc(65536); let count; while((count=fs.readSync(fd,chunk,0,chunk.length,null))>0) digest.update(chunk.subarray(0,count)); } finally { fs.closeSync(fd); } }
    else throw new Error('source type unavailable');
  }
  process.stdout.write(JSON.stringify({ source:digest.digest('hex'), node:process.versions.node }));
} catch { process.stdout.write('null'); process.exitCode=1; }
`;

export async function captureValidationRetryIdentity(
  cm: ContainerManager,
  config: ValidationEngineConfig,
): Promise<TaskRetryIdentity> {
  const identity: TaskRetryIdentity = {
    source: null,
    contract: hash({
      contract: config.contract ?? null,
      task: config.task,
      suite: config.validationSuite,
    }),
    commands: hash({
      setup: config.validationSetupCommand,
      build: config.buildCommand,
      test: config.testCommand,
      lint: config.lintCommand,
      sast: config.sastCommand,
      workDir: config.buildWorkDir,
      timeouts: [config.buildTimeout, config.testTimeout, config.lintTimeout, config.sastTimeout],
    }),
    environment: null,
    implementation: null,
  };
  try {
    const result = await cm.execInContainer(
      config.containerId,
      ['node', '-e', RETRY_IDENTITY_PROBE],
      {
        cwd: config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace',
        timeout: 30000,
      },
    );
    const output =
      result.exitCode === 0
        ? (JSON.parse(result.stdout) as { source?: string; node?: string } | null)
        : null;
    if (output?.source && /^[a-f0-9]{64}$/.test(output.source)) identity.source = output.source;
    const metadata = await cm.getExecutionMetadata?.(config.containerId);
    if (metadata?.imageDigest && /^sha256:[a-f0-9]{64}$/.test(metadata.imageDigest) && output?.node)
      identity.environment = hash({
        image: metadata.imageDigest,
        memory: metadata.memoryLimitBytes,
        cpu: metadata.cpuLimit,
        network: metadata.networkMode,
        node: output.node,
      });
  } catch {
    /* Missing source/environment does not prove changed conditions. */
  }
  if (
    daemonRelease.source === 'build' &&
    /^[a-f0-9]{64}$/.test(daemonRelease.validationImplementationHash ?? '')
  )
    identity.implementation = daemonRelease.validationImplementationHash ?? null;
  return identity;
}
