import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ArtifactOutput, FollowUpEnvelope, ManagedPodRequest, Route } from '@autopod/shared';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { canonical } from './canonical.js';
import type { ManagedRuntimePort } from './managed-service.js';

export interface ReviewedContainerBoundary {
  route: Route;
  profileId?: string;
  identityBinding?: { alias: string; bindingDigest: string };
  manager: ContainerManager;
  image: string;
  /** Literal reviewed command including the exact model/reasoning; no user-selected executable. */
  command: readonly string[];
  /** Exact dependency cache expected behind the repository's node_modules link. */
  dependencyCache?: { enrollmentId: string; path: string };
  /** Resolve the daemon-owned host workspace for an enrolled repository. */
  sourceWorkspace?(podId: string, repositoryId: string): string;
  /** Trusted worktree provisioning and scope-derived network enforcement. */
  prepare(podId: string, request: ManagedPodRequest): Promise<ContainerSpawnConfig>;
  /** Account-bound provider gateway checks quota before each request and persists trusted usage. */
  sendMessage?(runtimeRef: string, message: FollowUpEnvelope, key: string): Promise<void>;
  quotaReady(request: ManagedPodRequest): Promise<boolean>;
  attachQuota(
    podId: string,
    runtimeRef: string,
    stateRoot: string,
    request: ManagedPodRequest,
  ): Promise<void>;
}

const ROOT_WRITE = `import os,sys
p=sys.argv[1]; os.makedirs(os.path.dirname(p),mode=0o700,exist_ok=True)
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f: f.write(sys.argv[2]); f.flush(); os.fsync(f.fileno())
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
    private readonly lookup: (
      ref: string,
    ) => { request: ManagedPodRequest; podId: string; createdAt: number } | null,
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
      !boundary.manager.ensureManagedContainer ||
      !boundary.manager.extractManagedOutput ||
      !boundary.command.includes(request.route.model) ||
      (request.route.reasoning !== 'none' && !boundary.command.includes(request.route.reasoning)) ||
      !boundary.image.includes('@sha256:') ||
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
    const runtimeRef = await allocate.call(boundary.manager, {
      ...config,
      managedSpecDigest: request.executionSpecDigest,
      onCreated: checkpoint,
    });
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
        ...('maxTokens' in grant.budget
          ? { maxTokens: grant.budget.maxTokens }
          : { budgetMode: 'request-time' }),
        requireQuotaReceipt: requiresQuotaReceipt,
        workerUid: 1000,
        workerGid: 1000,
        environment: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' },
        cwd: config.workingDir ?? '/output',
        argv: [...boundary.command, '--', request.task.objective],
      }),
    );
    if (requiresQuotaReceipt) await boundary.attachQuota(podId, runtimeRef, root, request);
    const result = await boundary.manager.execInContainer(
      runtimeRef,
      ['python3', `${root}/supervisor.py`, root, '--detach'],
      { user: 'root' },
    );
    if (result.exitCode !== 0) throw new Error('managed-supervisor-start-failed');
    if (fault === 'after-agent-start') throw new Error('injected-after-agent-start');
    return { runtimeRef };
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
      | 'agent-quota-feed-unavailable'
      | 'agent-auto-compaction-unsupported'
      | 'agent-context-window-exceeded'
      | 'agent-tool-permission-denied'
      | 'agent-channel-unavailable'
      | 'agent-followup-channel-failed'
      | 'agent-output-invalid'
      | 'agent-cli-exit';
  }> {
    const { boundary, podId } = this.resolve(ref);
    const result = await boundary.manager.execInContainer(
      ref,
      [
        'python3',
        '-c',
        'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())',
        `/run/dispatcher-${podId}/execution.json`,
      ],
      { user: 'root' },
    );
    if (result.exitCode !== 0) {
      const state = await boundary.manager.getStatus(ref);
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
        | 'agent-quota-feed-unavailable'
        | 'agent-auto-compaction-unsupported'
        | 'agent-context-window-exceeded'
        | 'agent-tool-permission-denied'
        | 'agent-channel-unavailable'
        | 'agent-followup-channel-failed'
        | 'agent-output-invalid'
        | 'agent-cli-exit'
        | undefined;
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
  async extractSource(ref: string, repositoryId: string): Promise<void> {
    const { boundary, podId, request } = this.resolve(ref);
    const repository = request.effectiveGrant.scope.repositories.find(
      (item) => item.enrollmentId === repositoryId,
    );
    if (
      request.route.executionTarget !== 'sandbox' ||
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
      ['node_modules'],
      { assertCurrent },
    );
  }
  async send(ref: string, message: FollowUpEnvelope, key: string): Promise<void> {
    const { boundary } = this.resolve(ref);
    if (!boundary.sendMessage) throw new Error('managed-follow-up-unavailable');
    await boundary.sendMessage(ref, message, key);
  }
  async cleanup(ref: string): Promise<boolean> {
    const { boundary } = this.resolve(ref);
    if ((await this.observe(ref)).state !== 'stopped')
      throw new Error('managed-cleanup-before-exit');
    await boundary.manager.kill(ref);
    return (await boundary.manager.getStatus(ref)) === 'deleted';
  }
  async stop(ref: string): Promise<void> {
    const { boundary, podId } = this.resolve(ref);
    await boundary.manager.execInContainer(
      ref,
      ['python3', '-c', ROOT_WRITE, `/run/dispatcher-${podId}/revoked`, 'true'],
      { user: 'root' },
    );
    const observed = await boundary.manager.execInContainer(
      ref,
      [
        'python3',
        '-c',
        `import json,pathlib,sys,time
p=pathlib.Path(sys.argv[1]);deadline=time.monotonic()+3
while time.monotonic()<deadline:
 try:
  if json.loads(p.read_text()).get('observedExit'):sys.exit(0)
 except (OSError,ValueError):pass
 time.sleep(0.05)
sys.exit(1)
`,
        `/run/dispatcher-${podId}/execution.json`,
      ],
      { user: 'root' },
    );
    if (observed.exitCode !== 0) throw new Error('managed-stop-not-yet-observed');
    // Keep the empty runtime available for output extraction; cleanup destroys it later.
  }
}
