import { createHash } from 'node:crypto';
import {
  AutopodError,
  type EffectiveLaunchConfig,
  type RepositoryPreparationEvidence,
  type RepositoryPreparationTiming,
} from '@autopod/shared';
import { redactSecretText } from '../actions/action-diagnostics.js';
import { ExecInterruptedError, isObservedExitCode } from '../containers/exec-exit-evidence.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { sanitizeProviderMessage } from '../runtimes/provider-error-classifier.js';
import { boundOutput } from '../util/bounded-output.js';
import {
  CACHE_SIGNAL_SCRIPT,
  instrumentPrepareCommand,
  parseCacheSignals,
  parseStageTiming,
  preparationTimingPath,
  prepareStageLabel,
  splitPrepareStages,
} from './preparation-timing.js';
import { wrapValidationExecCommand } from './registry-injector.js';

/** Uses existing validation termination gates when preparation may still be running. */
export class RepositoryPreparationError extends AutopodError {
  constructor(
    detail: string,
    readonly terminationUnverified: boolean,
  ) {
    super(detail, 'REPOSITORY_PREPARATION_FAILED', 409);
  }
}

/** Read bytes without invoking repository programs, Git filters, hooks or a status refresh.
 * Ignored installation/build artifacts are deliberately excluded. All tracked files
 * and nonignored untracked inputs (including new lockfiles) contribute to the hash.
 * Stream regular files through one 64 KiB buffer: repository bytes are not a memory
 * budget. The exec deadline, manifest/file-count bounds and containment checks remain.
 */
export const PREPARATION_SOURCE_PROBE = `
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), crypto=require('node:crypto');
const root='/workspace', real=fs.realpathSync(root), env={...process.env}, deadline=Date.now()+12000;
const checkDeadline=()=>{if(Date.now()>=deadline) process.exit(2);};
for(const key of Object.keys(env)) if(key.startsWith('GIT_')) delete env[key];
Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'});
const git=args=>cp.execFileSync('/usr/bin/git',['--no-replace-objects','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd:root,env,encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024});
const head=git(['rev-parse','--verify','HEAD']).trim();
if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) process.exit(2);
const names=[...new Set(git(['ls-files','-z','--cached','--others','--exclude-standard']).split(String.fromCharCode(0)).filter(Boolean))].sort();
if(names.length>30000) process.exit(2);
const hash=crypto.createHash('sha256'), buffer=Buffer.allocUnsafe(64*1024);
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
for(const name of names){
 checkDeadline();
 if(path.isAbsolute(name)||name.split('/').some(p=>p==='..'||p==='.'||!p)) process.exit(2);
 const file=path.join(root,name); let stat;
 try { const parent=fs.realpathSync(path.dirname(file)); if(parent!==real&&!parent.startsWith(real+'/')) process.exit(2); stat=fs.lstatSync(file); }
 catch(e){ if(e.code==='ENOENT'){hash.update(JSON.stringify([name,'missing']));continue;} throw e; }
 if(stat.isSymbolicLink()){
  const content=Buffer.from(fs.readlinkSync(file));
  hash.update(JSON.stringify([name,'link',content.length])); hash.update(content);
 } else {
  if(!stat.isFile()) process.exit(2);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
   const opened=fs.fstatSync(fd);
   if(!opened.isFile()||!sameFile(stat,opened)) process.exit(2);
   hash.update(JSON.stringify([name,stat.mode&0o111,stat.size]));
   let offset=0;
   while(offset<stat.size){
    checkDeadline();
    const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,stat.size-offset),null);
    if(count<=0) process.exit(2);
    hash.update(buffer.subarray(0,count)); offset+=count;
   }
   if(!sameFile(stat,fs.fstatSync(fd))) process.exit(2);
  } finally {fs.closeSync(fd);}
 }
 if(!sameFile(stat,fs.lstatSync(file))) process.exit(2);
}
process.stdout.write(JSON.stringify({head,fingerprint:hash.digest('hex')}));
`;

export async function inspectPreparationSource(
  cm: ContainerManager,
  containerId: string,
  assertCurrent: () => void = () => {},
): Promise<NonNullable<RepositoryPreparationEvidence['source']>> {
  assertCurrent();
  const result = await cm.execInContainer(containerId, ['node', '-e', PREPARATION_SOURCE_PROBE], {
    cwd: '/workspace',
    timeout: 15000,
    assertCurrent,
    requireObservedExit: true,
    maxOutputBytes: 4096,
  });
  assertCurrent();
  if (result.exitCode !== 0 || result.stdout.length > 1024)
    throw new Error('Source inputs unverified');
  const source = JSON.parse(result.stdout) as { head?: unknown; fingerprint?: unknown };
  if (
    typeof source.head !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.head) ||
    typeof source.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.fingerprint)
  )
    throw new Error('Source inputs unverified');
  return { head: source.head, fingerprint: source.fingerprint };
}

export async function assertPreparationSourceCurrent(
  evidence: RepositoryPreparationEvidence | undefined,
  cm: ContainerManager,
  containerId: string,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  if (!evidence || evidence.status === 'not-configured') return;
  let source: RepositoryPreparationEvidence['source'] = null;
  try {
    source = await inspectPreparationSource(cm, containerId, assertCurrent);
  } catch {
    assertCurrent();
  }
  assertCurrent();
  if (
    evidence.status !== 'passed' ||
    evidence.containerId !== containerId ||
    !source ||
    JSON.stringify(source) !== JSON.stringify(evidence.source)
  )
    throw new AutopodError(
      'Repository preparation inputs changed or are unverified; prepare this candidate again before execution.',
      'REPOSITORY_PREPARATION_FAILED',
      409,
    );
}

/** Shorter per-word command fragments are ordinary words, not plausible credentials. */
const MIN_COMMAND_WORD_SECRET_LENGTH = 8;
/** Persisted detail budget; the tail carries the verdict, so most of it goes there. */
const FAILURE_DETAIL_LIMIT = 1100;
const FAILURE_DETAIL_HEAD = 200;

function failureDetail(
  raw: string,
  command: string,
  env: Record<string, string>,
  secrets: string[],
  publicLiterals: Record<string, string> = {},
): string {
  // Command literals may themselves be credentials. Suppress the full command and
  // credential-length command words as well as xtrace lines, resolved env values and
  // registry secrets. Declared public buildEnv literals (already visible in argv) are
  // not secrets: hiding values such as "1" or "true" destroys unrelated output.
  const hidden = new Set([
    ...Object.entries(env)
      .filter(([key, value]) => publicLiterals[key] !== value)
      .map(([, value]) => value),
    ...secrets,
    command,
    ...command
      .split(/[\s'"`=;|&()]+/)
      .filter((word) => word.length >= MIN_COMMAND_WORD_SECRET_LENGTH),
  ]);
  const text = raw
    .replace(/^\s*\+.*$/gm, '[shell trace withheld]')
    .replace(
      /^.*(?:_auth|password|passwd|secret|token|authorization|credential|bearer|api[_ -]?key).*$/gim,
      '[credential-bearing line withheld]',
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL withheld]');
  // Redact without truncation, then bound keeping the tail (where failures are reported)
  // before final sanitization, whose own 1200-character cap would otherwise keep only
  // the head of long install output.
  return sanitizeProviderMessage(
    boundOutput(redactSecretText(text, hidden), FAILURE_DETAIL_LIMIT, FAILURE_DETAIL_HEAD),
  );
}

/** Source-dependent preparation runs only in this pod after checkout and scoped feed setup. */
export async function prepareLaunchRepository(
  config: EffectiveLaunchConfig | null,
  containerManager: ContainerManager,
  containerId: string,
  env: Record<string, string>,
  options: {
    assertCurrent?(): void;
    record?(evidence: RepositoryPreparationEvidence): void;
    sensitiveValues?: string[];
    /** Duration of the execution preflight the caller ran just before, for the timing record. */
    preflightMs?: number | null;
  } = {},
): Promise<RepositoryPreparationEvidence> {
  const startedAt = Date.now();
  const assertCurrent = options.assertCurrent ?? (() => {});
  assertCurrent();
  const setup = config?.repository?.setup;
  const command = setup?.prepareCommand;
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const evidence: RepositoryPreparationEvidence = {
    status: command ? 'unverified' : 'not-configured',
    containerId,
    commandHash: command ? hash(command) : null,
    configurationHash: command
      ? hash([
          setup?.buildWorkDir,
          setup?.buildTimeout,
          Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
        ])
      : null,
    source: null,
    exitCode: null,
  };
  const literals = Object.fromEntries(
    Object.entries(setup?.buildEnv ?? {}).flatMap(([key, binding]) =>
      'value' in binding ? [[key, binding.value]] : [],
    ),
  );
  const stages = command ? splitPrepareStages(command) : [];
  const hiddenLabelWords = new Set([
    ...Object.entries(env)
      .filter(([key, value]) => literals[key] !== value)
      .map(([, value]) => value),
    ...(options.sensitiveValues ?? []),
  ]);
  const labels = stages.map((stage, i) => prepareStageLabel(stage, i + 1, hiddenLabelWords));
  let sourceProbeMs: number | null = null;
  let commandMs: number | null = null;
  // Until markers are read, every stage is "not run" (e.g. the source probe failed first).
  let stageTiming: Pick<RepositoryPreparationTiming, 'stageTiming' | 'stages'> = {
    stageTiming: 'unavailable',
    stages: labels.map((label, i) => ({
      index: i + 1,
      label,
      durationMs: null,
      status: 'not-run',
    })),
  };
  const probeSource = async () => {
    const probeStarted = Date.now();
    try {
      return await inspectPreparationSource(containerManager, containerId, assertCurrent);
    } finally {
      sourceProbeMs = (sourceProbeMs ?? 0) + (Date.now() - probeStarted);
    }
  };
  const finish = () => {
    assertCurrent();
    if (command)
      evidence.timing = {
        totalMs: Date.now() - startedAt,
        commandMs,
        ...(options.preflightMs !== undefined ? { preflightMs: options.preflightMs } : {}),
        sourceProbeMs,
        ...stageTiming,
      };
    options.record?.(evidence);
    return evidence;
  };
  const fail = (detail: string, terminationUnverified = false): never => {
    evidence.detail = detail;
    finish();
    throw new RepositoryPreparationError(
      `Repository preparation ${evidence.status}: ${detail}`,
      terminationUnverified,
    );
  };
  if (!setup || !command) return finish();
  try {
    evidence.source = await probeSource();
  } catch {
    assertCurrent();
    return fail('Source/dependency inputs could not be verified before preparation.');
  }
  const workDir = setup.buildWorkDir ? `/workspace/${setup.buildWorkDir}` : '/workspace';
  evidence.cache = parseCacheSignals(
    await containerManager
      .execInContainer(containerId, ['sh', '-c', CACHE_SIGNAL_SCRIPT], {
        cwd: workDir,
        timeout: 5000,
        maxOutputBytes: 1024,
      })
      .then((probe) => (probe.exitCode === 0 ? probe.stdout : null))
      .catch(() => null),
  );
  assertCurrent();
  const timingPath = preparationTimingPath();
  const readStageTiming = async (exitCode: number | null) => {
    const text = await containerManager
      .execInContainer(
        containerId,
        ['sh', '-c', 'cat -- "$1" 2>/dev/null; rm -f -- "$1"', 'autopod-prep-timing', timingPath],
        { timeout: 5000, maxOutputBytes: 4096 },
      )
      .then((read) => (read.exitCode === 0 ? read.stdout : null))
      .catch(() => null);
    stageTiming = parseStageTiming(text, labels, exitCode);
  };
  let result: Awaited<ReturnType<ContainerManager['execInContainer']>>;
  const commandStarted = Date.now();
  try {
    result = await containerManager.execInContainer(
      containerId,
      wrapValidationExecCommand(instrumentPrepareCommand(stages, timingPath), env, literals),
      {
        cwd: workDir,
        timeout: (setup.buildTimeout ?? 300) * 1000,
        env,
        assertCurrent,
        requireObservedExit: true,
        maxOutputBytes: 65536,
      },
    );
    commandMs = Date.now() - commandStarted;
    assertCurrent();
  } catch (error) {
    commandMs = Date.now() - commandStarted;
    assertCurrent();
    await readStageTiming(null);
    assertCurrent();
    const category =
      error instanceof ExecInterruptedError && error.execution?.cause === 'timeout'
        ? 'timed out'
        : 'exit unverified';
    return fail(
      `${category}; ${failureDetail(error instanceof Error ? error.message : 'transport unavailable', command, env, options.sensitiveValues ?? [], literals)}`,
      true,
    );
  }
  evidence.exitCode = isObservedExitCode(result.exitCode) ? result.exitCode : null;
  await readStageTiming(evidence.exitCode);
  assertCurrent();
  if (evidence.exitCode !== 0) {
    evidence.status = evidence.exitCode === null ? 'unverified' : 'failed';
    return fail(
      `${evidence.exitCode === null ? 'exit unverified' : `exit code ${evidence.exitCode}`}; ${failureDetail(`${result.stdout}\n${result.stderr}`, command, env, options.sensitiveValues ?? [], literals)}`,
      evidence.exitCode === null,
    );
  }
  let after: RepositoryPreparationEvidence['source'] = null;
  try {
    after = await probeSource();
  } catch {
    assertCurrent();
  }
  if (!after || JSON.stringify(after) !== JSON.stringify(evidence.source))
    return fail('Source/dependency inputs changed or became unverified during preparation.');
  evidence.status = 'passed';
  return finish();
}
