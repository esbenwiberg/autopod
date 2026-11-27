import { createHash, randomBytes } from 'node:crypto';
import {
  AutopodError,
  type EffectiveLaunchConfig,
  type RepositoryPreparationEvidence,
  type RepositoryPreparationTiming,
} from '@autopod/shared';
import { redactSecretText } from '../actions/action-diagnostics.js';
import {
  ExecInterruptedError,
  type ExecInterruption,
  isObservedExitCode,
} from '../containers/exec-exit-evidence.js';
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
    readonly execution?: ExecInterruption,
  ) {
    super(detail, 'REPOSITORY_PREPARATION_FAILED', 409);
  }
}

// Leave time to observe a real exit below the Sandbox bounded-exec ceiling (30 s).
const SOURCE_PROBE_BUDGET_MS = 24_000;
const SOURCE_PROBE_TRANSPORT_MS = 28_000;
const SOURCE_PROBE_EXIT = {
  deadline: 20,
  git: 21,
  invalidInput: 22,
  unstableFile: 23,
  gitDeadline: 24,
} as const;

/** Read bytes without invoking repository programs, Git filters, hooks or a status refresh.
 * Ignored installation/build artifacts are deliberately excluded. All tracked files
 * and nonignored untracked inputs (including new lockfiles) contribute to the hash.
 * Stream regular files through one 64 KiB buffer: repository bytes are not a memory
 * budget. The exec deadline, manifest/file-count bounds and containment checks remain.
 */
export const PREPARATION_SOURCE_PROBE = `
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), crypto=require('node:crypto');
const root='/workspace', real=fs.realpathSync(root), env={...process.env}, deadline=performance.now()+${SOURCE_PROBE_BUDGET_MS};
const exit=${JSON.stringify(SOURCE_PROBE_EXIT)};
const checkDeadline=()=>{if(performance.now()>=deadline) process.exit(exit.deadline);};
for(const key of Object.keys(env)) if(key.startsWith('GIT_')) delete env[key];
Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'});
const git=args=>{
 checkDeadline();
 try { return cp.execFileSync('/usr/bin/git',['--no-replace-objects','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd:root,env,encoding:'utf8',timeout:Math.min(8000,Math.max(1,Math.floor(deadline-performance.now()))),maxBuffer:4*1024*1024}); }
 catch(e){process.exit(e.code==='ETIMEDOUT'?exit.gitDeadline:exit.git);}
};
const head=git(['rev-parse','--verify','HEAD']).trim();
if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) process.exit(exit.git);
const names=[...new Set(git(['ls-files','-z','--cached','--others','--exclude-standard']).split(String.fromCharCode(0)).filter(Boolean))].sort();
if(names.length>30000) process.exit(exit.invalidInput);
const hash=crypto.createHash('sha256'), buffer=Buffer.allocUnsafe(64*1024);
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
for(const name of names){
 checkDeadline();
 if(path.isAbsolute(name)||name.split('/').some(p=>p==='..'||p==='.'||!p)) process.exit(exit.invalidInput);
 const file=path.join(root,name); let stat;
 try { const parent=fs.realpathSync(path.dirname(file)); if(parent!==real&&!parent.startsWith(real+'/')) process.exit(exit.invalidInput); stat=fs.lstatSync(file); }
 catch(e){ if(e.code==='ENOENT'){hash.update(JSON.stringify([name,'missing']));continue;} throw e; }
 if(stat.isSymbolicLink()){
  const content=Buffer.from(fs.readlinkSync(file));
  hash.update(JSON.stringify([name,'link',content.length])); hash.update(content);
 } else {
  if(!stat.isFile()) process.exit(exit.invalidInput);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
   const opened=fs.fstatSync(fd);
   if(!opened.isFile()||!sameFile(stat,opened)) process.exit(exit.unstableFile);
   hash.update(JSON.stringify([name,stat.mode&0o111,stat.size]));
   let offset=0;
   while(offset<stat.size){
    checkDeadline();
    const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,stat.size-offset),null);
    if(count<=0) process.exit(exit.unstableFile);
    hash.update(buffer.subarray(0,count)); offset+=count;
   }
   if(!sameFile(stat,fs.fstatSync(fd))) process.exit(exit.unstableFile);
  } finally {fs.closeSync(fd);}
 }
 if(!sameFile(stat,fs.lstatSync(file))) process.exit(exit.unstableFile);
}
checkDeadline();
process.stdout.write(JSON.stringify({head,fingerprint:hash.digest('hex')}));
`;

// Never include probe stdout/stderr in diagnostics; it can contain paths or secrets.
class PreparationSourceProbeError extends Error {}

const SOURCE_PROBE_FAILURES: Readonly<Record<number, string>> = {
  [SOURCE_PROBE_EXIT.deadline]: `source fingerprint exceeded its ${SOURCE_PROBE_BUDGET_MS / 1000}s read budget`,
  [SOURCE_PROBE_EXIT.git]: 'Git could not verify HEAD or enumerate source paths',
  [SOURCE_PROBE_EXIT.invalidInput]:
    'source inventory has an unsupported path or exceeds its file-count bound',
  [SOURCE_PROBE_EXIT.unstableFile]: 'a source file changed while being read',
  [SOURCE_PROBE_EXIT.gitDeadline]: 'Git source inventory exceeded its read budget',
};

function describeSourceProbeFailure(error: unknown): string {
  return error instanceof PreparationSourceProbeError ? error.message : 'source probe unavailable';
}

export async function inspectPreparationSource(
  cm: ContainerManager,
  containerId: string,
  assertCurrent: () => void = () => {},
): Promise<NonNullable<RepositoryPreparationEvidence['source']>> {
  assertCurrent();
  let result: Awaited<ReturnType<ContainerManager['execInContainer']>>;
  try {
    result = await cm.execInContainer(containerId, ['node', '-e', PREPARATION_SOURCE_PROBE], {
      cwd: '/workspace',
      timeout: SOURCE_PROBE_TRANSPORT_MS,
      assertCurrent,
      requireObservedExit: true,
      maxOutputBytes: 4096,
    });
  } catch (error) {
    assertCurrent();
    throw new PreparationSourceProbeError(
      error instanceof ExecInterruptedError && error.execution?.cause === 'timeout'
        ? `source probe transport timed out (${SOURCE_PROBE_TRANSPORT_MS / 1000}s)`
        : 'source probe execution or exit could not be verified',
    );
  }
  assertCurrent();
  if (result.exitCode !== 0)
    throw new PreparationSourceProbeError(
      SOURCE_PROBE_FAILURES[result.exitCode] ?? 'source probe failed to read the workspace',
    );
  let source: { head?: unknown; fingerprint?: unknown } | null = null;
  if (result.stdout.length <= 1024) {
    try {
      source = JSON.parse(result.stdout);
    } catch {
      // Do not report parser excerpts of untrusted output.
    }
  }
  if (
    !source ||
    typeof source.head !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.head) ||
    typeof source.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.fingerprint)
  )
    throw new PreparationSourceProbeError('source probe returned invalid evidence');
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

/** Basenames whose bytes decide what a dependency install produces (#644 reuse key). */
export const DEPENDENCY_MANIFEST_NAMES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.tool-versions',
] as const;

/**
 * Read-only fingerprint of dependency manifests/lockfiles (tracked and nonignored
 * untracked, outside node_modules) plus the repository files the prepare command names
 * (argv after the work directory). Same Git hardening and containment as the source probe.
 */
export const PREPARATION_DEPENDENCY_PROBE = `
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), crypto=require('node:crypto');
const root='/workspace', real=fs.realpathSync(root), env={...process.env};
const [workRel,...named]=process.argv.slice(1);
for(const key of Object.keys(env)) if(key.startsWith('GIT_')) delete env[key];
Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'});
const git=args=>cp.execFileSync('/usr/bin/git',['--no-replace-objects','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd:root,env,encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024});
const manifests=new Set(${JSON.stringify(DEPENDENCY_MANIFEST_NAMES)});
const listed=git(['ls-files','-z','--cached','--others','--exclude-standard']).split(String.fromCharCode(0)).filter(Boolean);
const names=[...new Set(listed.filter(n=>manifests.has(path.posix.basename(n))&&!n.split('/').includes('node_modules')))].sort();
if(names.length>2000||named.length>50) process.exit(2);
const hash=crypto.createHash('sha256');
const add=(label,file)=>{
 let stat; try{ const parent=fs.realpathSync(path.dirname(file)); if(parent!==real&&!parent.startsWith(real+'/')) process.exit(2); stat=fs.lstatSync(file); }
 catch(e){ if(e.code==='ENOENT'){hash.update(JSON.stringify([label,'missing']));return;} throw e; }
 if(stat.isSymbolicLink()){ hash.update(JSON.stringify([label,'link',fs.readlinkSync(file)])); return; }
 if(!stat.isFile()){ hash.update(JSON.stringify([label,'other'])); return; }
 if(stat.size>64*1024*1024) process.exit(2);
 hash.update(JSON.stringify([label,stat.mode&0o111,stat.size])); hash.update(fs.readFileSync(file));
};
for(const name of names){ if(path.isAbsolute(name)||name.split('/').some(p=>p==='..'||p==='.'||!p)) process.exit(2); add(name,path.join(root,name)); }
const workDir=path.resolve(root,workRel||'.');
if(workDir!==root&&!workDir.startsWith(root+'/')) process.exit(2);
for(const word of named){ const file=path.resolve(workDir,word); if(file!==root&&!file.startsWith(root+'/')){hash.update(JSON.stringify(['named',word,'outside']));continue;} add('named:'+word,file); }
process.stdout.write(JSON.stringify({fingerprint:hash.digest('hex')}));
`;

/** Relative path-like words the prepare command names (scripts, configs), at most 50. */
export function commandNamedPaths(command: string): string[] {
  const words = command.split(/[\s'"`=;|&()<>]+/).filter(Boolean);
  const paths = words.filter(
    (word) =>
      /^(?:\.{1,2}\/)?[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*\/?$/.test(word) &&
      !word.startsWith('-') &&
      (word.includes('/') || /\.(?:sh|bash|m?js|cjs|ts|py|ps1|json|ya?ml|toml|lock)$/.test(word)),
  );
  return [...new Set(paths)].slice(0, 50);
}

export async function inspectDependencyInputs(
  cm: ContainerManager,
  containerId: string,
  command: string,
  buildWorkDir: string | undefined,
  assertCurrent: () => void = () => {},
): Promise<string | null> {
  assertCurrent();
  try {
    const result = await cm.execInContainer(
      containerId,
      [
        'node',
        '-e',
        PREPARATION_DEPENDENCY_PROBE,
        buildWorkDir ?? '.',
        ...commandNamedPaths(command),
      ],
      { cwd: '/workspace', timeout: 15000, maxOutputBytes: 4096 },
    );
    assertCurrent();
    if (result.exitCode !== 0 || result.stdout.length > 1024) return null;
    const parsed = JSON.parse(result.stdout) as { fingerprint?: unknown };
    return typeof parsed.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(parsed.fingerprint)
      ? parsed.fingerprint
      : null;
  } catch {
    assertCurrent();
    return null;
  }
}

/**
 * Lists files changed after `$1` (a marker created just before the command) outside the
 * workspace tree that survives a container: `$HOME`, `/usr/local`, `/opt` and the
 * workspace Git directory. Re-downloadable package-manager caches and agent runtime
 * state are pruned; anything else (e.g. Playwright browsers, NuGet packages, global
 * installs, hook configuration) is a write a dependency snapshot would not carry.
 */
export const OUTSIDE_WORKSPACE_WRITES_SCRIPT = [
  'h="${HOME:-/home/autopod}"; m="$1"',
  '[ -f "$m" ] && command -v find >/dev/null 2>&1 || { rm -f -- "$m"; echo unverified; exit 0; }',
  'set --',
  'for r in "$h" /usr/local /opt /workspace/.git; do [ -e "$r" ] && set -- "$@" "$r"; done',
  // One shell line: a newline inside the find expression would end the command early.
  // Any find error (unreadable directory, bad option) reports "unverified", never "none".
  [
    'first=$( { find "$@" -xdev \\(',
    '-path "$h/.npm" -o -path "$h/.cache/node-gyp" -o -path "$h/.config/configstore"',
    '-o -path "$h/.cache/pnpm" -o -path "$h/.local/share/pnpm/store" -o -path "$h/.cache/yarn"',
    '-o -path "$h/.yarn/berry/cache" -o -path "$h/.cache/pip" -o -path "$h/.cache/node/corepack"',
    '-o -path "$h/.claude" -o -path "$h/.codex" -o -path "$h/.autopod" -o -path "$h/.pi" \\)',
    '-prune -o \\( -type f -o -type l \\) -cnewer "$m" -print 2>/dev/null;',
    'echo "__autopod_find_rc=$?"; } | head -n 1)',
  ].join(' '),
  'rm -f -- "$m"',
  'case "$first" in __autopod_find_rc=0) echo none ;; __autopod_find_rc=*|"") echo unverified ;; *) echo detected ;; esac',
].join('\n');

async function createWriteMarker(
  cm: ContainerManager,
  containerId: string,
): Promise<string | null> {
  const marker = `/tmp/.autopod-prep-writes-${randomBytes(12).toString('hex')}`;
  try {
    const result = await cm.execInContainer(
      containerId,
      ['sh', '-c', ': >"$1" && sleep 1', 'autopod-prep-writes', marker],
      { timeout: 5000, maxOutputBytes: 256 },
    );
    return result.exitCode === 0 ? marker : null;
  } catch {
    return null;
  }
}

async function detectOutsideWorkspaceWrites(
  cm: ContainerManager,
  containerId: string,
  marker: string | null,
): Promise<'none' | 'detected' | 'unverified'> {
  if (!marker) return 'unverified';
  try {
    const result = await cm.execInContainer(
      containerId,
      ['sh', '-c', OUTSIDE_WORKSPACE_WRITES_SCRIPT, 'autopod-prep-writes', marker],
      { timeout: 15000, maxOutputBytes: 256 },
    );
    const verdict = result.stdout.trim();
    return result.exitCode === 0 && (verdict === 'none' || verdict === 'detected')
      ? verdict
      : 'unverified';
  } catch {
    return 'unverified';
  }
}

/** Inputs a continuation reuse decision compares against the snapshot manifest. */
export interface PreparationReuseInputs {
  commandHash: string;
  configurationHash: string;
  dependencyInputs: string | null;
}

export type PreparationReuseAttempt =
  | {
      reused: true;
      sourceContainerId: string;
      restoredArchives: number;
      restoredBytes: number;
      restoreMs: number;
    }
  | { reused: false; reason: string };

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
    /**
     * Provider-continuation reuse (#644). Called once, after the source and dependency
     * probes, with this preparation's reuse inputs; restores a matching snapshot or refuses.
     * Absent for fresh launches and validation, which always prepare in full.
     */
    reuse?: { attempt(current: PreparationReuseInputs): Promise<PreparationReuseAttempt> };
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
  const fail = (
    detail: string,
    terminationUnverified = false,
    execution?: ExecInterruption,
  ): never => {
    evidence.detail = detail;
    finish();
    throw new RepositoryPreparationError(
      `Repository preparation ${evidence.status}: ${detail}`,
      terminationUnverified,
      execution,
    );
  };
  if (!setup || !command) return finish();
  try {
    evidence.source = await probeSource();
  } catch (error) {
    assertCurrent();
    return fail(
      `Source inputs unverified before preparation: ${describeSourceProbeFailure(error)}.`,
    );
  }
  const workDir = setup.buildWorkDir ? `/workspace/${setup.buildWorkDir}` : '/workspace';
  {
    const probeStarted = Date.now();
    evidence.dependencyInputs = await inspectDependencyInputs(
      containerManager,
      containerId,
      command,
      setup.buildWorkDir,
      assertCurrent,
    );
    sourceProbeMs = (sourceProbeMs ?? 0) + (Date.now() - probeStarted);
  }
  if (options.reuse && evidence.commandHash && evidence.configurationHash) {
    let attempt: PreparationReuseAttempt;
    try {
      attempt = await options.reuse.attempt({
        commandHash: evidence.commandHash,
        configurationHash: evidence.configurationHash,
        dependencyInputs: evidence.dependencyInputs ?? null,
      });
    } catch {
      attempt = { reused: false, reason: 'reuse-attempt-failed' };
    }
    assertCurrent();
    if (attempt.reused) {
      let after: RepositoryPreparationEvidence['source'] = null;
      try {
        after = await probeSource();
      } catch {
        assertCurrent();
      }
      if (after && JSON.stringify(after) === JSON.stringify(evidence.source)) {
        evidence.status = 'passed';
        evidence.outsideWorkspaceWrites = 'none';
        evidence.reuse = {
          decision: 'reused',
          reason: 'inputs-unchanged',
          sourceContainerId: attempt.sourceContainerId,
          restoredArchives: attempt.restoredArchives,
          restoredBytes: attempt.restoredBytes,
          restoreMs: attempt.restoreMs,
        };
        return finish();
      }
      // The restore changed tracked inputs: never trust it; the full command reinstalls.
      evidence.reuse = { decision: 'refused', reason: 'source-changed-after-restore' };
    } else {
      evidence.reuse = { decision: 'refused', reason: attempt.reason };
    }
  }
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
  const writeMarker = await createWriteMarker(containerManager, containerId);
  assertCurrent();
  let result: Awaited<ReturnType<ContainerManager['execInContainer']>>;
  const commandStarted = Date.now();
  try {
    const execute = containerManager.execObserved ?? containerManager.execInContainer;
    result = await execute.call(
      containerManager,
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
      !(
        error instanceof ExecInterruptedError &&
        error.execution?.cleanup === 'confirmed' &&
        isObservedExitCode(error.execution.observedExitCode)
      ),
      error instanceof ExecInterruptedError ? error.execution : undefined,
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
  evidence.outsideWorkspaceWrites = await detectOutsideWorkspaceWrites(
    containerManager,
    containerId,
    writeMarker,
  );
  assertCurrent();
  let after: NonNullable<RepositoryPreparationEvidence['source']>;
  try {
    after = await probeSource();
  } catch (error) {
    assertCurrent();
    return fail(
      `Source inputs unverified after preparation: ${describeSourceProbeFailure(error)}.`,
    );
  }
  if (after.head !== evidence.source.head) return fail('Git HEAD changed during preparation.');
  if (after.fingerprint !== evidence.source.fingerprint)
    return fail('Source/dependency file fingerprint changed during preparation.');
  evidence.status = 'passed';
  return finish();
}
