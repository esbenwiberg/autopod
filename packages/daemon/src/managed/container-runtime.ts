import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ArtifactOutput, FollowUpEnvelope, ManagedPodRequest, Route } from '@autopod/shared';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { canonical } from './canonical.js';
import type { ManagedRuntimePort } from './managed-service.js';
import {
  assertPrivateParentCommit,
  isPrivateParentCommit,
  isPrivateSubmission,
  PRIVATE_SUBMISSION_FILE,
} from './private-commit-policy.js';
import { collectPrivateHead } from './private-head-export.js';
import { allocateSandboxCheckpoint } from './sandbox-checkpoint.js';

export interface ReviewedContainerBoundary {
  route: Route;
  profileId?: string;
  identityBinding?: { alias: string; bindingDigest: string };
  manager: ContainerManager;
  image: string;
  /** Explicitly enabled by the trusted sandbox composition, never by a worker. */
  sandboxCodingCheckpoints?: boolean;
  /** Literal reviewed command including the exact model/reasoning; no user-selected executable. */
  command: readonly string[];
  /** Exact dependency cache expected behind the repository's node_modules link. */
  dependencyCache?: { enrollmentId: string; path: string };
  /** Resolve the daemon-owned host workspace for an enrolled repository. */
  sourceWorkspace?(podId: string, repositoryId: string): string;
  cleanupNetwork?(podId: string): Promise<void>;
  /** Trusted worktree provisioning and scope-derived network enforcement. */
  prepare(
    podId: string,
    request: ManagedPodRequest,
  ): Promise<
    ContainerSpawnConfig & {
      sandboxCheckpoint?: { repository: string; commit: string; coding?: true };
    }
  >;
  /** Attach the account-bound provider channel; hard-token routes may also attach a quota feed. */
  sendMessage?(runtimeRef: string, message: FollowUpEnvelope, key: string): Promise<void>;
  quotaReady(request: ManagedPodRequest): Promise<boolean>;
  attachProviderChannel(
    podId: string,
    runtimeRef: string,
    stateRoot: string,
    request: ManagedPodRequest,
    existingOnly?: true,
  ): Promise<void>;
}

// Only the root supervisor holds launch.lock while executing. A stale 'running'
// file, a claimed launch, or a manager reporting a live container isn't sufficient.
const READ_CHECKPOINT_EXECUTION = `import fcntl,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1])
if root.resolve()!=root or root.stat().st_uid!=0 or root.stat().st_mode & 0o077: sys.exit(1)
launch=json.loads((root/'launch.json').read_text());receipt=json.loads((root/'execution.json').read_text())
if receipt.get('state')!='running' or type(receipt.get('pid')) is not int or receipt['pid']<=0: sys.exit(1)
# Never take even a probe lock before the supervisor has published its running receipt.
lock=(root/'launch.lock').open('r')
try: fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
except BlockingIOError: pass
else: sys.exit(1)
os.kill(receipt['pid'],0)
print(json.dumps({'verified':launch['verifiedCheckpoint'],'execution':receipt}))`;

const ROOT_WRITE = `import os,sys
p=sys.argv[1]; os.makedirs(os.path.dirname(p),mode=0o700,exist_ok=True)
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f: f.write(sys.argv[2]); f.flush(); os.fsync(f.fileno())
`;

// Share the supervisor's one-start lock so cancellation before provisioning
// cannot race a delayed launch into creating a worker after authority withdrawal.
export const STOP_SUPERVISOR = `import fcntl,json,os,pathlib,sys,time
root=pathlib.Path(sys.argv[1]);root.mkdir(mode=0o700,parents=True,exist_ok=True)
(root / 'revoked').write_text('true')
lock=(root / 'launch.lock').open('a')
try:
 fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: pass
else:
 receipt=root / 'execution.json'
 if not receipt.exists():
  temporary=root / 'execution.tmp'
  with temporary.open('w') as stream:
   json.dump({'state':'cancelled-before-start','specDigest':sys.argv[2],
              'consumedTokens':0,'observedExit':True},stream)
   stream.flush();os.fsync(stream.fileno())
  os.replace(temporary,receipt)
 fcntl.flock(lock.fileno(),fcntl.LOCK_UN)
p=root / 'execution.json';deadline=time.monotonic()+3
while time.monotonic()<deadline:
 try:
  value=json.loads(p.read_text())
  if value.get('specDigest')==sys.argv[2] and value.get('observedExit'):sys.exit(0)
 except (OSError,ValueError):pass
 time.sleep(0.05)
sys.exit(1)
`;

export const WORKER_WRITABLE = `import os,stat,sys
def prepare(fd):
 for name in os.listdir(fd):
  item=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if stat.S_ISLNK(item.st_mode): continue
  child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  try:
   actual=os.fstat(child)
   if stat.S_ISDIR(actual.st_mode): prepare(child)
   elif stat.S_ISREG(actual.st_mode) and actual.st_nlink==1:
    os.fchown(child,1000,1000);os.fchmod(child,0o700 if actual.st_mode & 0o111 else 0o600)
   else: raise RuntimeError('unsafe writable entry')
  finally: os.close(child)
 os.fchown(fd,1000,1000);os.fchmod(fd,0o700)
for root in sys.argv[1:]:
 if root != '/output' and not (root.startswith('/repositories/') and len(root.split('/')) == 3): raise RuntimeError('invalid writable root')
 if os.path.realpath(root) != root: raise RuntimeError('unsafe writable root')
 parent=os.stat(os.path.dirname(root))
 if parent.st_uid!=0 or parent.st_mode & 0o022: raise RuntimeError('unsafe writable parent')
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try: prepare(fd)
 finally: os.close(fd)
`;

/** Concrete mechanics reuse AutoPod container managers, with a trusted detached guard. */
export class ManagedContainerRuntime implements ManagedRuntimePort {
  cleanupUnallocated?: (podId: string, request: ManagedPodRequest) => Promise<boolean>;
  private readonly known = new Map<string, ReviewedContainerBoundary>();
  constructor(
    private readonly boundaries: readonly ReviewedContainerBoundary[],
    private readonly lookup: (ref: string) => {
      request: ManagedPodRequest;
      podId: string;
      createdAt: number;
      observedExit?: boolean;
    } | null,
    private readonly supervisorSource = readFileSync(
      fileURLToPath(new URL('./runtime/supervisor.py', import.meta.url)),
      'utf8',
    ),
  ) {}

  private boundary(request: ManagedPodRequest): ReviewedContainerBoundary {
    const matches = this.boundaries.filter(
      (binding) =>
        canonical(binding.route) === canonical(request.route) &&
        (binding.profileId === undefined ||
          binding.profileId === request.profileSnapshot.profileId),
    );
    if (matches.length !== 1) throw new Error('managed-route-unavailable');
    return matches[0]!;
  }
  async preflight(request: ManagedPodRequest): Promise<void> {
    const boundary = this.boundary(request);
    if (
      request.route.executionTarget === 'sandbox' &&
      isPrivateParentCommit(request) &&
      !boundary.sandboxCodingCheckpoints
    )
      throw new Error('managed-sandbox-coding-checkpoint-required');
    if (
      !boundary.manager.ensureManagedContainer ||
      !boundary.manager.extractManagedOutput ||
      !boundary.command.includes(request.route.model) ||
      (request.route.reasoning !== 'none' && !boundary.command.includes(request.route.reasoning)) ||
      !(
        /@sha256:[a-f0-9]{64}$/.test(boundary.image) ||
        (request.route.executionTarget === 'local' && /^sha256:[a-f0-9]{64}$/.test(boundary.image))
      ) ||
      !(await boundary.quotaReady(request)) ||
      process.env.AUTOPOD_FAIL_OPEN_FIREWALL === '1'
    ) {
      throw new Error('managed-enforcement-unavailable');
    }
    const identities = request.effectiveGrant.scope.identityBindings;
    if (
      identities.length > 0 &&
      (!boundary.identityBinding ||
        identities.length !== 1 ||
        canonical(identities[0]) !== canonical(boundary.identityBinding))
    )
      throw new Error('managed-identity-broker-unavailable');
  }
  async ensure(
    podId: string,
    request: ManagedPodRequest,
    checkpoint: (ref: string) => void,
    fault?: string,
  ): Promise<{ runtimeRef: string }> {
    return this.ensureAtBoundary(podId, request, checkpoint, fault, () => {});
  }
  async ensureAtBoundary(
    podId: string,
    request: ManagedPodRequest,
    checkpoint: (ref: string) => void,
    fault: string | undefined,
    beforeAllocate: () => void,
  ): Promise<{ runtimeRef: string }> {
    await this.preflight(request);
    const boundary = this.boundary(request);
    const config = await boundary.prepare(podId, request);
    const scope = request.effectiveGrant.scope;
    if (
      config.podId !== podId ||
      config.image !== boundary.image ||
      Object.keys(config.env).length ||
      config.exposeHostGateway !== false ||
      canonical([...(config.allowedHosts ?? [])].sort()) !==
        canonical([...scope.network.destinations].sort()) ||
      config.networkPolicyMode !== (scope.network.destinations.length ? 'restricted' : 'deny-all')
    ) {
      throw new Error('managed-runtime-scope-mismatch');
    }
    if (
      request.route.executionTarget === 'local' &&
      (!config.firewallScript || !config.networkName)
    ) {
      throw new Error('managed-network-enforcement-unavailable');
    }
    const volumes = config.volumes ?? [];
    for (const repository of scope.repositories) {
      const mount = volumes.find(
        (volume) => volume.container === `/repositories/${repository.enrollmentId}`,
      );
      if (!mount || mount.readOnly !== (repository.access === 'read'))
        throw new Error('managed-repository-mount-mismatch');
    }
    if (
      request.outputs.artifacts.mode !== 'none' &&
      !volumes.some((volume) => volume.container === '/output' && !volume.readOnly)
    ) {
      throw new Error('managed-output-mount-required');
    }
    const allowedMounts = new Set([
      '/output',
      ...(request.task.contextFiles?.length ? ['/inputs/context'] : []),
      ...scope.repositories.map((repo) => `/repositories/${repo.enrollmentId}`),
      ...request.inputArtifacts.map((input) => input.mountPath),
    ]);
    if (
      volumes.some((volume) => !allowedMounts.has(volume.container)) ||
      request.inputArtifacts.some(
        (input) =>
          !volumes.some((volume) => volume.container === input.mountPath && volume.readOnly),
      )
    ) {
      throw new Error('managed-inherited-mount-forbidden');
    }
    const allocate = boundary.manager.ensureManagedContainer;
    if (!allocate) throw new Error('managed-allocation-unavailable');
    const { sandboxCheckpoint, ...spawn } = config;
    if (request.route.executionTarget === 'sandbox' && isPrivateParentCommit(request)) {
      if (!boundary.sandboxCodingCheckpoints || !sandboxCheckpoint?.coding)
        throw new Error('managed-sandbox-coding-checkpoint-required');
      assertPrivateParentCommit(
        request,
        sandboxCheckpoint.repository,
        sandboxCheckpoint.commit,
        'sandbox',
      );
    } else if (sandboxCheckpoint?.coding) {
      throw new Error('managed-sandbox-coding-checkpoint-required');
    }
    const launch = {
      ...spawn,
      managedSpecDigest: request.executionSpecDigest,
      onCreated: checkpoint,
    };
    if (!sandboxCheckpoint) beforeAllocate();
    const runtimeRef = sandboxCheckpoint
      ? await allocateSandboxCheckpoint(boundary.manager, launch, sandboxCheckpoint, beforeAllocate)
      : await allocate.call(boundary.manager, launch);
    checkpoint(runtimeRef);
    this.known.set(runtimeRef, boundary);
    if (fault === 'after-runtime-identity') throw new Error('injected-after-runtime-identity');
    const writable = volumes.filter((volume) => !volume.readOnly).map((volume) => volume.container);
    if (writable.length) {
      const prepared = await boundary.manager.execInContainer(
        runtimeRef,
        ['python3', '-c', WORKER_WRITABLE, ...writable],
        { user: 'root' },
      );
      if (prepared.exitCode !== 0) throw new Error('managed-writable-mount-unavailable');
    }
    if (boundary.dependencyCache) {
      const { enrollmentId, path: cachePath } = boundary.dependencyCache;
      if (
        !scope.repositories.some((repository) => repository.enrollmentId === enrollmentId) ||
        !/^\/opt\/autopod-managed\/[A-Za-z0-9_.-]+\/node_modules$/.test(cachePath)
      )
        throw new Error('managed-dependency-cache-binding');
      const verified = await boundary.manager.execInContainer(
        runtimeRef,
        [
          'python3',
          '-c',
          `import os,stat,sys
link,target=sys.argv[1:]
item=os.lstat(link)
actual=os.stat(target)
if not stat.S_ISLNK(item.st_mode) or os.readlink(link)!=target: raise RuntimeError('link')
if not stat.S_ISDIR(actual.st_mode) or actual.st_uid!=0 or actual.st_mode & 0o022: raise RuntimeError('target')
`,
          `/repositories/${enrollmentId}/node_modules`,
          cachePath,
        ],
        { user: 'root' },
      );
      if (verified.exitCode !== 0) throw new Error('managed-dependency-cache-unavailable');
    }
    const root = `/run/dispatcher-${podId}`;
    const write = async (name: string, value: string) => {
      const result = await boundary.manager.execInContainer(
        runtimeRef,
        ['python3', '-c', ROOT_WRITE, `${root}/${name}`, value],
        { user: 'root' },
      );
      if (result.exitCode !== 0) throw new Error('managed-supervisor-provisioning-failed');
    };
    const grant = request.effectiveGrant;
    const requiresQuotaReceipt = 'maxTokens' in grant.budget;
    await write('supervisor.py', this.supervisorSource);
    await write(
      'launch.json',
      canonical({
        expiresAt: Math.min(
          grant.budget.expiresAt,
          this.resolve(runtimeRef).createdAt + grant.budget.maxDurationSeconds,
        ),
        maxDurationSeconds: grant.budget.maxDurationSeconds,
        specDigest: request.executionSpecDigest,
        // Written in the supervisor's private root only after remote byte verification.
        ...(sandboxCheckpoint
          ? {
              verifiedCheckpoint: {
                ...sandboxCheckpoint,
                podId,
                runtimeRef,
                specDigest: request.executionSpecDigest,
              },
            }
          : {}),
        ...('maxTokens' in grant.budget
          ? { maxTokens: grant.budget.maxTokens }
          : { budgetMode: 'request-time' }),
        requireQuotaReceipt: requiresQuotaReceipt,
        workerUid: 1000,
        workerGid: 1000,
        environment: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' },
        cwd: config.workingDir ?? '/output',
        argv: [
          ...boundary.command,
          ...(grant.scope.network.destinations.length > 0 ? ['--network-enabled'] : []),
          '--',
          request.task.objective,
        ],
      }),
    );
    await boundary.attachProviderChannel(podId, runtimeRef, root, request);
    const result = await boundary.manager.execInContainer(
      runtimeRef,
      ['python3', `${root}/supervisor.py`, root, '--detach'],
      { user: 'root' },
    );
    if (result.exitCode !== 0) throw new Error('managed-supervisor-start-failed');
    if (fault === 'after-agent-start') throw new Error('injected-after-agent-start');
    return { runtimeRef };
  }
  async restoreCheckpoint(podId: string, ref: string, specDigest: string): Promise<boolean> {
    const record = this.resolve(ref);
    const { boundary, request } = record;
    const repos = request.effectiveGrant.scope.repositories;
    if (
      record.podId !== podId ||
      request.executionSpecDigest !== specDigest ||
      request.route.executionTarget !== 'sandbox' ||
      repos.length !== 1 ||
      repos[0]?.access !== 'read'
    )
      return false;
    const root = `/run/dispatcher-${podId}`;
    const proof = await boundary.manager
      .execInContainer(ref, ['python3', '-I', '-c', READ_CHECKPOINT_EXECUTION, root], {
        user: 'root',
      })
      .catch(() => null);
    if (proof?.exitCode !== 0) return false;
    try {
      const { verified, execution } = JSON.parse(proof.stdout);
      if (
        execution.state !== 'running' ||
        execution.observedExit !== false ||
        execution.specDigest !== specDigest ||
        canonical(verified) !==
          canonical({
            repository: repos[0].enrollmentId,
            commit: repos[0].baseRevision,
            podId,
            runtimeRef: ref,
            specDigest,
          })
      )
        return false;
    } catch {
      return false;
    }
    await boundary.attachProviderChannel(podId, ref, root, request, true);
    return true;
  }
  private resolve(ref: string) {
    const record = this.lookup(ref);
    if (!record) throw new Error('managed-runtime-unbound');
    return { ...record, boundary: this.known.get(ref) ?? this.boundary(record.request) };
  }
  async observe(ref: string): Promise<{
    state: 'running' | 'stopped' | 'unknown';
    consumedTokens: number;
    exitCode?: number;
    limitation?:
      | 'agent-request-limit-reached'
      | 'agent-provider-request-limit-reached'
      | 'agent-quota-feed-unavailable'
      | 'agent-auto-compaction-unsupported'
      | 'agent-context-window-exceeded'
      | 'agent-tool-permission-denied'
      | 'agent-channel-unavailable'
      | 'agent-followup-channel-failed'
      | 'agent-output-invalid'
      | 'agent-cli-exit'
      | 'managed-worker-never-started';
  }> {
    const { boundary, podId } = this.resolve(ref);
    // An exec against a deleted sandbox throws rather than returning an exit
    // code. Only the manager's explicit deleted/stopped state confirms exit.
    const result = await boundary.manager
      .execInContainer(
        ref,
        [
          'python3',
          '-c',
          'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())',
          `/run/dispatcher-${podId}/execution.json`,
        ],
        { user: 'root' },
      )
      .catch(() => null);
    if (!result || result.exitCode !== 0) {
      const state = await boundary.manager.getStatus(ref, 'managed-exit');
      return {
        state:
          state === 'deleted' ||
          (state === 'stopped' && this.resolve(ref).request.route.executionTarget === 'local')
            ? 'stopped'
            : 'unknown',
        consumedTokens: 0,
      };
    }
    try {
      const receipt = JSON.parse(result.stdout) as {
        observedExit: boolean;
        state: string;
        consumedTokens: number;
        specDigest: string;
        exitCode?: number;
      };
      if (
        receipt.specDigest !== this.resolve(ref).request.executionSpecDigest ||
        !Number.isSafeInteger(receipt.consumedTokens) ||
        (receipt.exitCode !== undefined && !Number.isSafeInteger(receipt.exitCode))
      )
        throw new Error('binding');
      let limitation:
        | 'agent-request-limit-reached'
        | 'agent-provider-request-limit-reached'
        | 'agent-quota-feed-unavailable'
        | 'agent-auto-compaction-unsupported'
        | 'agent-context-window-exceeded'
        | 'agent-tool-permission-denied'
        | 'agent-channel-unavailable'
        | 'agent-followup-channel-failed'
        | 'agent-output-invalid'
        | 'agent-cli-exit'
        | 'managed-worker-never-started'
        | undefined;
      if (receipt.observedExit && receipt.state === 'cancelled-before-start') {
        return {
          state: 'stopped',
          consumedTokens: receipt.consumedTokens,
          limitation: 'managed-worker-never-started',
        };
      }
      if (receipt.observedExit) {
        if (receipt.state === 'quota-unavailable') limitation = 'agent-quota-feed-unavailable';
        const diagnostic = await boundary.manager.execInContainer(
          ref,
          [
            'python3',
            '-c',
            'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())',
            `/run/dispatcher-${podId}/channel-failure.json`,
          ],
          { user: 'root' },
        );
        if (diagnostic.exitCode === 0) {
          try {
            const failure = JSON.parse(diagnostic.stdout) as Record<string, unknown>;
            if (
              failure.phase === 'provider' &&
              failure.reason === 'request-limit' &&
              receipt.exitCode !== undefined &&
              receipt.exitCode !== 0
            )
              limitation = 'agent-provider-request-limit-reached';
            else if (
              failure.phase === 'request' &&
              failure.reason === 'request-limit' &&
              Number.isSafeInteger(failure.actualBytes) &&
              Number.isSafeInteger(failure.maximumBytes) &&
              Number(failure.actualBytes) > Number(failure.maximumBytes)
            )
              limitation = 'agent-request-limit-reached';
            else if (
              failure.phase === 'request' &&
              failure.reason === 'unsupported-auto-compaction'
            )
              limitation = 'agent-auto-compaction-unsupported';
            else if (
              failure.phase === 'agent' &&
              Number.isSafeInteger(failure.exitCode) &&
              Number(failure.exitCode) >= 1 &&
              Number(failure.exitCode) <= 255 &&
              [
                'context-window-exceeded',
                'tool-permission-denied',
                'channel-unavailable',
                'followup-channel-failed',
                'output-invalid',
                'cli-exit',
              ].includes(String(failure.reason))
            )
              limitation = `agent-${String(failure.reason)}` as
                | 'agent-context-window-exceeded'
                | 'agent-tool-permission-denied'
                | 'agent-channel-unavailable'
                | 'agent-followup-channel-failed'
                | 'agent-output-invalid'
                | 'agent-cli-exit';
          } catch {
            /* Untrusted runtime diagnostics are ignored unless fully allowlisted. */
          }
        }
      }
      return {
        state: receipt.observedExit
          ? 'stopped'
          : receipt.state === 'running'
            ? 'running'
            : 'unknown',
        consumedTokens: receipt.consumedTokens,
        ...(receipt.observedExit && receipt.exitCode !== undefined
          ? { exitCode: receipt.exitCode }
          : {}),
        ...(limitation ? { limitation } : {}),
      };
    } catch {
      throw new Error('managed-runtime-receipt-invalid');
    }
  }
  async extractOutput(ref: string, staging: string, output: ArtifactOutput): Promise<void> {
    const { boundary } = this.resolve(ref);
    const observed = await this.observe(ref);
    if (observed.state !== 'stopped') throw new Error('artifact-writer-still-active');
    if (observed.exitCode !== undefined && observed.exitCode !== 0)
      throw new Error('managed-agent-exit-failed');
    if (!boundary.manager.extractManagedOutput) throw new Error('managed-output-unavailable');
    await boundary.manager.extractManagedOutput(ref, staging, output);
  }
  /** Read only the opted-in final response, never the repository or unsubmitted edits. */
  async readPrivateSubmission(
    ref: string,
    podId: string,
    spec: string,
    assertAuthority: () => void,
  ) {
    const assertCurrent = () => {
      assertAuthority();
      const row = this.resolve(ref);
      if (
        !row.observedExit ||
        row.podId !== podId ||
        row.request.executionSpecDigest !== spec ||
        !row.boundary.sandboxCodingCheckpoints ||
        !isPrivateSubmission(row.request)
      )
        throw new Error('parent-private-submission-binding');
      return row;
    };
    const { boundary, request } = assertCurrent();
    const base = request.effectiveGrant.scope.repositories[0]?.baseRevision;
    if (!base || request.outputs.source.mode !== 'commit')
      throw new Error('parent-private-submission-binding');
    assertPrivateParentCommit(request, request.outputs.source.repository, base, 'sandbox');
    await this.provePrivateSandboxExit(boundary.manager, ref, podId, spec, assertCurrent);
    const limit = Math.min(
      request.outputs.artifacts.limits.maxFileBytes,
      request.outputs.artifacts.limits.maxTotalBytes,
    );
    const cap = Math.ceil(limit / 3) * 4;
    const result = await boundary.manager.execInContainer(
      ref,
      [
        'python3',
        '-I',
        '-c',
        `import base64,os,stat,sys
limit=int(sys.argv[2])
try:
 if os.geteuid()!=1000: sys.exit(1)
 root=os.open('/output',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=root)
 with os.fdopen(fd,'rb') as f:
  st=os.fstat(f.fileno())
  if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_uid!=1000 or not 0<st.st_size<=limit: sys.exit(1)
  data=f.read(limit+1)
  if len(data)!=st.st_size: sys.exit(1)
 sys.stdout.buffer.write(base64.b64encode(data))
except OSError:sys.exit(1)`,
        PRIVATE_SUBMISSION_FILE,
        String(limit),
      ],
      {
        user: 'autopod',
        timeout: 10_000,
        maxOutputBytes: cap,
        requireObservedExit: true,
        assertCurrent,
      },
    );
    assertCurrent();
    if (result.exitCode !== 0 || result.stderr || !result.stdout || result.stdout.length > cap)
      throw new Error('parent-private-submission-unavailable');
    const bytes = Buffer.from(result.stdout, 'base64');
    if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== result.stdout)
      throw new Error('parent-private-submission-unavailable');
    return bytes;
  }

  private async provePrivateSandboxExit(
    manager: ContainerManager,
    ref: string,
    podId: string,
    specDigest: string,
    assertCurrent: () => void,
  ) {
    const proof = await manager.execInContainer(
      ref,
      [
        'python3',
        '-I',
        '-c',
        'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())',
        `/run/dispatcher-${podId}/execution.json`,
      ],
      {
        user: 'root',
        timeout: 10_000,
        maxOutputBytes: 2048,
        requireObservedExit: true,
        assertCurrent,
      },
    );
    assertCurrent();
    if (proof.exitCode !== 0 || proof.stderr)
      throw new Error('parent-private-export-runtime-not-successful');
    const receipt = JSON.parse(proof.stdout);
    if (
      receipt?.specDigest !== specDigest ||
      receipt.observedExit !== true ||
      receipt.state !== 'exited' ||
      receipt.exitCode !== 0
    )
      throw new Error('parent-private-export-runtime-not-successful');
  }

  async exportPrivateHead(
    ref: string,
    binding: {
      podId: string;
      specDigest: string;
      repository: string;
      base: string;
      maxBytes: number;
    },
    assertAuthority: () => void,
  ) {
    const { podId, specDigest, repository, base, maxBytes } = binding;
    const assertCurrent = () => {
      assertAuthority();
      const record = this.resolve(ref);
      const { request } = record;
      const scope = request.effectiveGrant.scope;
      const privateCommit = isPrivateParentCommit(request);
      if (privateCommit) {
        const target =
          request.route.executionTarget === 'sandbox' && record.boundary.sandboxCodingCheckpoints
            ? 'sandbox'
            : 'local';
        assertPrivateParentCommit(request, repository, base, target);
      }
      if (
        !record.observedExit ||
        record.podId !== podId ||
        request.executionSpecDigest !== specDigest ||
        request.outputs.source.mode !== 'commit' ||
        request.outputs.source.repository !== repository ||
        request.outputs.source.remote !== 'private' ||
        scope.network.destinations.length !== 0 ||
        scope.identityBindings.length !== 0 ||
        scope.repositories.length !== 1 ||
        scope.repositories[0]?.enrollmentId !== repository ||
        scope.repositories[0]?.access !== 'write' ||
        scope.repositories[0]?.baseRevision !== base ||
        (!privateCommit &&
          scope.allowedEffects.some(
            (effect) => effect !== 'repository.read' && effect !== 'repository.write',
          ))
      )
        throw new Error('parent-private-export-runtime-binding');
    };
    assertCurrent();
    const { boundary, request } = this.resolve(ref);
    if (isPrivateSubmission(request)) throw new Error('parent-private-submission-required');
    if (request.route.executionTarget === 'sandbox') {
      if (!boundary.sandboxCodingCheckpoints || !isPrivateParentCommit(request))
        throw new Error('parent-private-export-bounded-transport-unavailable');
      // Use only the bound, root-owned supervisor observation.
      await this.provePrivateSandboxExit(boundary.manager, ref, podId, specDigest, assertCurrent);
      return collectPrivateHead(boundary.manager, ref, repository, maxBytes, assertCurrent);
    }
    if (request.route.executionTarget !== 'local')
      throw new Error('parent-private-export-bounded-transport-unavailable');
    const observed = await this.observe(ref);
    assertCurrent();
    if (observed.state !== 'stopped' || observed.exitCode !== 0)
      throw new Error('parent-private-export-runtime-not-successful');
    return collectPrivateHead(boundary.manager, ref, repository, maxBytes, assertCurrent);
  }

  async extractSource(ref: string, repositoryId: string): Promise<void> {
    const { boundary, podId, request } = this.resolve(ref);
    const repository = request.effectiveGrant.scope.repositories.find(
      (item) => item.enrollmentId === repositoryId,
    );
    if (
      request.outputs.source.mode === 'none' ||
      request.outputs.source.repository !== repositoryId ||
      repository?.access !== 'write'
    )
      throw new Error('managed-source-sync-scope-mismatch');
    const observed = await this.observe(ref);
    if (observed.state !== 'stopped') throw new Error('source-writer-still-active');
    if (observed.exitCode !== undefined && observed.exitCode !== 0)
      throw new Error('managed-agent-exit-failed');
    const destination = boundary.sourceWorkspace?.(podId, repositoryId);
    if (!destination) throw new Error('managed-source-workspace-unavailable');
    // Local workers write the exact daemon-owned bind mount. Copying it onto itself
    // would destroy Git metadata; source freezing still verifies the candidate below.
    if (request.route.executionTarget === 'local') return;
    const assertCurrent = () => {
      const current = this.resolve(ref);
      if (
        current.podId !== podId ||
        current.request.executionSpecDigest !== request.executionSpecDigest
      )
        throw new Error('managed-source-sync-stale');
    };
    await boundary.manager.extractDirectoryFromContainer(
      ref,
      `/repositories/${repositoryId}`,
      destination,
      // The sandbox receives a copy of the repository, but the trusted host
      // remains the sole owner of Git metadata and dependency caches. Mirroring
      // either back can corrupt candidate creation or stage runtime-only files.
      ['.git', 'node_modules'],
      { assertCurrent },
    );
  }
  async send(ref: string, message: FollowUpEnvelope, key: string): Promise<void> {
    const { boundary } = this.resolve(ref);
    if (!boundary.sendMessage) throw new Error('managed-follow-up-unavailable');
    await boundary.sendMessage(ref, message, key);
  }
  async cleanup(ref: string): Promise<boolean> {
    const record = this.lookup(ref);
    if (!record) throw new Error('managed-runtime-unbound');
    let boundary: ReviewedContainerBoundary;
    try {
      boundary = this.known.get(ref) ?? this.boundary(record.request);
    } catch (error) {
      // Retiring a model/profile must not strand an already-stopped Azure sandbox.
      // Only teardown may use the unique configured sandbox manager; no command,
      // provider channel, source access, or local network policy is inherited.
      if (
        !(error instanceof Error) ||
        error.message !== 'managed-route-unavailable' ||
        !record.observedExit ||
        record.request.route.executionTarget !== 'sandbox'
      )
        throw error;
      const matches = this.boundaries.filter(
        (entry) => entry.route.executionTarget === 'sandbox' && !entry.cleanupNetwork,
      );
      const managers = new Set(matches.map((entry) => entry.manager));
      if (managers.size !== 1 || !matches[0]) throw error;
      await matches[0].manager.kill(ref);
      return true;
    }
    const { podId, observedExit } = record;
    // Durable exit evidence permits a retry after container removal succeeded but
    // network cleanup failed. A Docker 404 alone never supplies exit evidence.
    if (!observedExit && (await this.observe(ref)).state !== 'stopped')
      throw new Error('managed-cleanup-before-exit');
    await boundary.manager.kill(ref);
    // kill resolves after confirmed removal; Docker projects a subsequent 404 as unknown.
    await boundary.cleanupNetwork?.(podId);
    return true;
  }
  async stop(ref: string): Promise<void> {
    const { boundary, podId, request, observedExit } = this.resolve(ref);
    if (observedExit) return;
    const observed = await boundary.manager.execInContainer(
      ref,
      ['python3', '-c', STOP_SUPERVISOR, `/run/dispatcher-${podId}`, request.executionSpecDigest],
      { user: 'root' },
    );
    if (observed.exitCode !== 0) throw new Error('managed-stop-not-yet-observed');
    // Keep the empty runtime available for output extraction; cleanup destroys it later.
  }
}
