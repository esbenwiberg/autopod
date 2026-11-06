import {
  AutopodError,
  DEFAULT_CONTAINER_MEMORY_GB,
  type EffectiveLaunchConfig,
  ENVIRONMENT_QUALIFICATION_TTL_MS,
  type EnvironmentQualificationBindingV1,
  type EnvironmentQualificationEvidenceV1,
  type EnvironmentQualificationObservationV1,
  type ExecutionProvenanceInput,
  environmentQualificationBindingV1Schema,
  environmentQualificationEvidenceV1Schema,
  type Pod,
} from '@autopod/shared';
import { z } from 'zod';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { assertLaunchRequirements } from '../configuration/launch-requirement-preflight.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { daemonRelease } from '../release.js';
import { inspectExecutionPreflight } from './execution-preflight.js';
import { assertRepairableExecutionRequirements } from './prerequisite-blocker.js';

export const QUALIFICATION_TIMEOUT_MS = 60_000;
export type QualificationProbeNodePath = '/usr/local/bin/node' | '/usr/bin/node';

/** Fixed argv/read-only source observation. No repository shell, file writes or repair command. */
export const QUALIFICATION_SOURCE_PROBE = `
const cp = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const root='/workspace'; const rootReal=fs.realpathSync(root);
const base = process.argv[1];
if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) process.exit(2);
const env = {...process.env};
for(const key of Object.keys(env)) if(key.startsWith('GIT_')) delete env[key];
env.GIT_CONFIG_NOSYSTEM='1'; env.GIT_CONFIG_GLOBAL='/dev/null'; env.GIT_OPTIONAL_LOCKS='0';
const git = (args,maxBuffer=65536) => cp.execFileSync('/usr/bin/git', ['--git-dir='+root+'/.git','--work-tree='+root,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],
  {cwd:root,env,encoding:'utf8',timeout:2000,maxBuffer});
const head=git(['rev-parse','--verify','HEAD']).trim();
const tree=git(['rev-parse','--verify','HEAD^{tree}']).trim();
const entries=git(['ls-tree','-r','-z','HEAD'],4*1024*1024).split(String.fromCharCode(0)).filter(Boolean);
if(entries.length>30000) process.exit(2);
let bytes=0; let trackedMatch=true;
for(const entry of entries) {
  const tab=entry.indexOf(String.fromCharCode(9)); const [mode,type,oid]=entry.slice(0,tab).split(' '); const name=entry.slice(tab+1);
  if(tab<0||type!=='blob'||!['100644','100755','120000'].includes(mode)||path.isAbsolute(name)||name.split('/').includes('..')) process.exit(2);
  const file=path.join(root,name); const parent=fs.realpathSync(path.dirname(file));
  if(parent!==rootReal&&!parent.startsWith(rootReal+'/')) process.exit(2);
  const stat=fs.lstatSync(file); let content;
  if(mode==='120000') { if(!stat.isSymbolicLink()) { trackedMatch=false; break; } content=Buffer.from(fs.readlinkSync(file)); }
  else { if(!stat.isFile()||stat.size>16*1024*1024||((stat.mode&0o111)!==0)!==(mode==='100755')) { trackedMatch=false; break; }
    bytes+=stat.size; if(bytes>64*1024*1024) process.exit(2); content=fs.readFileSync(file); }
  const digest=crypto.createHash(oid.length===40?'sha1':'sha256').update('blob '+content.length+String.fromCharCode(0)).update(content).digest('hex');
  if(digest!==oid) { trackedMatch=false; break; }
}
const clean=trackedMatch&&git(['status','--porcelain=v1','--untracked-files=all']).trim()==='';
git(['merge-base','--is-ancestor',base,'HEAD']);
process.stdout.write(JSON.stringify({platform:process.platform+'/'+({x64:'amd64',arm64:'arm64'}[process.arch]||process.arch),
  uid:process.getuid(),cwd:process.cwd(),head,tree,clean,baseAncestor:true}));
`;
const sourceObservationSchema = z
  .object({
    platform: z.string().max(64),
    uid: z.number().int(),
    cwd: z.string().max(1024),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    clean: z.boolean(),
    baseAncestor: z.literal(true),
  })
  .strict();

function context(profile: PodExecutionSettings, probeNodePath: QualificationProbeNodePath) {
  return {
    user: 'autopod',
    cwd: profile.buildWorkDir ? `/workspace/${profile.buildWorkDir}` : '/workspace',
    env: profile.buildEnv ?? {},
    probeNodePath,
  };
}
/** Configuration-only preview gate. Success is eligibility for an attempt, NEVER qualification. */
export function assertQualificationExecutionContextSupported(
  profile: PodExecutionSettings,
  probeNodePath: QualificationProbeNodePath = '/usr/local/bin/node',
): void {
  const execution = context(profile, probeNodePath);
  if (
    !['/usr/local/bin/node', '/usr/bin/node'].includes(probeNodePath) ||
    !/^\/workspace(?:\/[A-Za-z0-9_.-]+)*$/.test(execution.cwd) ||
    execution.cwd.split('/').includes('..') ||
    execution.env.PATH?.split(':').some(
      (path) => !path.startsWith('/') || /^\/(workspace|mnt|repos|tmp)(\/|$)/.test(path),
    ) ||
    Object.keys(execution.env).some((key) =>
      /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV)$/.test(key),
    )
  )
    throw new AutopodError(
      'Trusted bounded probe context is unsupported; no candidate should be allocated',
      'REPAIR_EXECUTION_CONTEXT_UNSUPPORTED',
      409,
    );
}

/** Hash, never expose, effective frozen buildEnv (which can contain secret values). */
export function qualificationExecutionContextHash(
  profile: PodExecutionSettings,
  probeNodePath: QualificationProbeNodePath = '/usr/local/bin/node',
): string {
  return configurationDigest(context(profile, probeNodePath));
}

export interface EnvironmentQualificationInput {
  binding: EnvironmentQualificationBindingV1;
  pod: Pod;
  profile: PodExecutionSettings;
  /** Effective replacement snapshot, preserving the original contract and authority. */
  launchConfig: EffectiveLaunchConfig;
  containerManager: ContainerManager;
  /** The normal provisioning/repository preparation path completed on this candidate. */
  preparationCompleted: boolean;
  /** Recheck durable operation/custody + source/config/report/credential/resource epochs. Throws if stale. */
  assertCurrent(): void;
  /** Daemon-selected immutable-image runtime location; never worker/operator input; no fallback. */
  probeNodePath?: QualificationProbeNodePath;
  now?: () => Date;
}
export interface EnvironmentQualificationResult {
  evidence: EnvironmentQualificationEvidenceV1;
  /** Backend may persist this independently; evidence never admits a worker. */
  provenance: ExecutionProvenanceInput | null;
}

/** Pure bounded qualification adapter over existing provisioning/preflight/container seams.
 * No DB, receipt consumption, retry, resource creation/wakeup/cleanup or worker dispatch.
 * An uncertain exec retains candidate custody; the caller MUST NOT replay this attempt.
 */
export async function qualifyExecutionEnvironment(
  input: EnvironmentQualificationInput,
): Promise<EnvironmentQualificationResult> {
  input.assertCurrent();
  const binding = environmentQualificationBindingV1Schema.parse(structuredClone(input.binding));
  const pod = structuredClone(input.pod);
  const profile = structuredClone(input.profile);
  const launchConfig = structuredClone(input.launchConfig);
  const { digest: launchDigest, ...launchBody } = launchConfig;
  const cm = input.containerManager;
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const observations: EnvironmentQualificationObservationV1[] = [];
  let provenance: ExecutionProvenanceInput | null = null;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probeNodePath = input.probeNodePath ?? '/usr/local/bin/node';
  const observe = (
    prerequisite: EnvironmentQualificationObservationV1['prerequisite'],
    outcome: EnvironmentQualificationObservationV1['outcome'],
    code: string,
    detail: string,
    launcher?: string,
  ) => {
    observations.push({ prerequisite, outcome, code, detail, ...(launcher ? { launcher } : {}) });
  };
  const assertCurrent = () => {
    input.assertCurrent();
    if (expired)
      throw new AutopodError(
        'Qualification deadline expired; candidate execution remains uncertain',
        'QUALIFICATION_TIMEOUT',
        409,
      );
  };
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    try {
      return await operation();
    } finally {
      assertCurrent();
    }
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new AutopodError('Qualification deadline expired', 'QUALIFICATION_TIMEOUT', 409));
    }, QUALIFICATION_TIMEOUT_MS);
  });
  // Every awaited operation observes the SAME total deadline; timeout cannot dispatch later probes.
  const bounded = <T>(operation: () => Promise<T>) => Promise.race([checked(operation), deadline]);
  try {
    const requirements = pod.contract?.executionRequirements;
    assertRepairableExecutionRequirements(requirements);
    assertLaunchRequirements(launchConfig);
    assertQualificationExecutionContextSupported(profile, probeNodePath);
    const execution = context(profile, probeNodePath);
    if (
      launchDigest !== binding.replacementLaunchDigest ||
      configurationDigest(launchBody) !== launchDigest ||
      launchConfig.execution.target !== 'local' ||
      launchConfig.resolvedEnvironment.platform !== binding.platform ||
      launchConfig.repository?.config.remote !== binding.source.repository ||
      configurationDigest(launchConfig.work.contract?.executionRequirements ?? null) !==
        binding.requirementsHash ||
      profile.containerMemoryGb !== launchConfig.resolvedExecution.main.memoryGb ||
      binding.candidateGeneration !== binding.originalGeneration + 1 ||
      pod.lifecycleGeneration !== binding.candidateGeneration ||
      pod.id !== binding.podId ||
      pod.containerId !== binding.containerId ||
      pod.executionTarget !== 'local' ||
      pod.launchConfigDigest !== binding.replacementLaunchDigest ||
      configurationDigest(requirements) !== binding.requirementsHash ||
      qualificationExecutionContextHash(profile, probeNodePath) !== binding.executionContextHash ||
      (requirements.platform && requirements.platform !== binding.platform)
    ) {
      observe(
        'preparation',
        'unsupported',
        'QUALIFICATION_CONTEXT_MISMATCH',
        'Frozen candidate identity, requirements or trusted execution context do not match.',
      );
    } else if (!input.preparationCompleted) {
      observe(
        'preparation',
        'unknown',
        'PREPARATION_NOT_VERIFIED',
        'Normal candidate preparation has not completed.',
      );
    } else if (
      !cm.getResourceKey ||
      !cm.getExecutionMetadata ||
      cm.supportsStreamingExec !== true
    ) {
      observe(
        'resource_identity',
        'unknown',
        'BACKEND_QUALIFICATION_UNAVAILABLE',
        'Exact Docker resource/metadata/known streaming evidence is required.',
      );
    } else {
      observe(
        'preparation',
        'qualified',
        'PREPARATION_COMPLETED',
        'Normal candidate preparation completed; no repair shell was run.',
      );
      const getResourceKey = cm.getResourceKey.bind(cm);
      const getExecutionMetadata = cm.getExecutionMetadata.bind(cm);
      const resourceKey = await bounded(() => getResourceKey(binding.containerId));
      if (resourceKey !== binding.resourceKey) {
        observe(
          'resource_identity',
          'failed',
          'RESOURCE_IDENTITY_MISMATCH',
          'Candidate resource differs from its immutable reservation.',
        );
      } else {
        observe(
          'resource_identity',
          'qualified',
          'RESOURCE_IDENTITY_MATCH',
          'Exact candidate Docker engine/container identity observed.',
        );
        provenance = await bounded(() =>
          inspectExecutionPreflight(cm, binding.containerId, pod, profile, 'coding', 'worker', {
            assertCurrent,
            user: 'autopod',
            probeNodePath,
            stopOnProbeError: true,
          }),
        );
        observe(
          'image',
          provenance.imageDigest === binding.expectedImage.digest
            ? 'qualified'
            : provenance.imageDigest
              ? 'failed'
              : 'unknown',
          'ACTUAL_IMAGE_IDENTITY',
          'Actual Docker image ID must equal the normally prepared immutable image ID.',
        );
        const memory = provenance.capabilities.memoryLimitBytes;
        const requiredMemory = Math.max(
          (profile.containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB) * 1024 ** 3,
          requirements.minimumMemoryBytes ?? 0,
        );
        observe(
          'memory',
          memory === null ? 'unknown' : memory >= requiredMemory ? 'qualified' : 'failed',
          'ACTUAL_MEMORY_LIMIT',
          'Effective enforced memory must meet frozen profile and manifest minimum.',
        );
        const requiredCpu = Math.max(
          requirements.minimumCpu ?? 0,
          launchConfig.resolvedExecution.main.cpus ?? 0,
        );
        if (requiredCpu > 0) {
          const cpu = provenance.capabilities.cpuLimit;
          observe(
            'cpu',
            cpu === null ? 'unknown' : cpu >= requiredCpu ? 'qualified' : 'failed',
            'ACTUAL_CPU_LIMIT',
            'Effective enforced CPU must meet the frozen manifest minimum.',
          );
        }
        observe(
          'streaming',
          provenance.capabilities.streamingExec === 'supported' ? 'qualified' : 'unknown',
          'STREAMING_EXEC',
          'Known streaming support required before coding.',
        );
        observe(
          'agent_cli',
          provenance.cliPath && provenance.cliVersion ? 'qualified' : 'unknown',
          'AGENT_CLI_PREFLIGHT',
          'Configured CLI must have an observed path and compatible version; this is not execution completion.',
        );
        for (const executable of requirements.executables) {
          const available = provenance.commands.requirements.find(
            (entry) =>
              entry.source === 'contract.executionRequirements' && entry.executable === executable,
          )?.available;
          observe(
            'launcher',
            available === true ? 'qualified' : available === false ? 'failed' : 'unknown',
            'DECLARED_LAUNCHER_LOOKUP',
            'Lookup only: no builder, private access or validation operation is certified.',
            executable,
          );
        }
        if (
          provenance.status === 'blocked' &&
          !observations.some((entry) => entry.outcome !== 'qualified')
        )
          observe(
            'preparation',
            'unknown',
            'CODING_PREFLIGHT_BLOCKED',
            'Normal coding preflight refused; no qualification or worker admission.',
          );
        if (observations.every((entry) => entry.outcome === 'qualified')) {
          const result = await bounded(() =>
            cm.execInContainer(
              binding.containerId,
              [probeNodePath, '-e', QUALIFICATION_SOURCE_PROBE, binding.source.baseCommitSha],
              {
                cwd: execution.cwd,
                env: execution.env,
                user: 'autopod',
                timeout: 10_000,
                maxOutputBytes: 65536,
                assertCurrent,
              },
            ),
          );
          if (
            result.exitCode !== 0 ||
            Buffer.byteLength(result.stdout) > 65536 ||
            Buffer.byteLength(result.stderr) > 65536
          ) {
            observe(
              'source',
              'unknown',
              'SOURCE_PROBE_UNVERIFIED',
              'No bounded successful observed source/platform probe exit; retain candidate custody.',
            );
          } else {
            const actual = sourceObservationSchema.parse(JSON.parse(result.stdout));
            observe(
              'platform',
              actual.platform === binding.platform &&
                actual.uid === 1000 &&
                actual.cwd === execution.cwd
                ? 'qualified'
                : 'failed',
              'ACTUAL_WORKER_PLATFORM_CONTEXT',
              'Observed Linux architecture, worker UID and working directory must match frozen context.',
            );
            observe(
              'source',
              actual.head === binding.source.head &&
                actual.tree === binding.source.tree &&
                actual.clean &&
                actual.baseAncestor
                ? 'qualified'
                : 'failed',
              'ACTUAL_SELECTED_SOURCE',
              'Actual clean candidate HEAD/tree must equal selected host source with pinned-base ancestry.',
            );
          }
        }
        if (observations.every((entry) => entry.outcome === 'qualified')) {
          const key = await bounded(() => getResourceKey(binding.containerId));
          const metadata = await bounded(() => getExecutionMetadata(binding.containerId));
          if (
            key !== binding.resourceKey ||
            metadata.imageDigest !== binding.expectedImage.digest ||
            metadata.memoryLimitBytes !== provenance.capabilities.memoryLimitBytes ||
            metadata.cpuLimit !== provenance.capabilities.cpuLimit ||
            metadata.networkMode !== provenance.capabilities.networkMode
          )
            observe(
              'resource_identity',
              'unknown',
              'RESOURCE_CHANGED_DURING_QUALIFICATION',
              'Resource/image/limits changed during observations; no reusable proof.',
            );
        }
      }
    }
  } catch (error) {
    // A superseded owner MUST propagate; never publish evidence into another lifecycle.
    input.assertCurrent();
    observe(
      'preparation',
      error instanceof AutopodError &&
        ['REPAIR_UNSUPPORTED_NEEDS', 'REPAIR_EXECUTION_CONTEXT_UNSUPPORTED'].includes(error.code)
        ? 'unsupported'
        : 'unknown',
      expired ? 'QUALIFICATION_TIMEOUT' : 'QUALIFICATION_UNVERIFIED',
      'Qualification did not obtain complete bounded evidence; no replay, repair or worker dispatch was attempted.',
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  input.assertCurrent();
  const finishedAt = now().toISOString();
  const outcome = observations.some((entry) => entry.outcome === 'unsupported')
    ? 'unsupported'
    : observations.some((entry) => entry.outcome === 'unknown')
      ? 'unknown'
      : observations.some((entry) => entry.outcome === 'failed')
        ? 'failed'
        : 'qualified';
  const evidence = environmentQualificationEvidenceV1Schema.parse({
    version: 1,
    binding,
    bindingDigest: configurationDigest(binding),
    probeVersion: 1,
    daemonCommit: daemonRelease.commitSha ?? null,
    implementationHash: daemonRelease.validationImplementationHash ?? null,
    startedAt,
    finishedAt,
    expiresAt: new Date(Date.parse(finishedAt) + ENVIRONMENT_QUALIFICATION_TTL_MS).toISOString(),
    outcome,
    observations,
    provenanceId: null,
  });
  return { evidence, provenance };
}
