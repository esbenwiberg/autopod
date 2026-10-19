import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AutopodError,
  CONTAINER_HOME_DIR,
  DEFAULT_CONTAINER_MEMORY_GB,
  generateId,
  resolveContainerNanoCpus,
} from '@autopod/shared';
import type { LaunchRegistryMaterial } from '../configuration/execution-credentials.js';
import { computeNetworkPolicyAllowlist } from '../containers/docker-network-manager.js';
import { launchSidecarSpec } from '../containers/launch-sidecars.js';
import { resolveSidecarSpec, sidecarPodEnv } from '../containers/sidecar-resolver.js';
import { RUNTIME_TELEMETRY_OPT_OUT_ENV } from '../runtime-env.js';
import { ensureClaudeStateDir } from '../runtimes/claude-state-store.js';
import { ensureCodexStateDir } from '../runtimes/codex-state-store.js';
import { buildValidationContextEnv } from '../validation/validation-context-env.js';
import { mergeMcpServers } from './injection-merger.js';
import { resolvePodSpawnImage, verifySandboxWarmImageAccess } from './provisioning-image-policy.js';
import {
  POD_ARTIFACTS_CONTAINER_DIR,
  SPEC_CONTEXT_CONTAINER_DIR,
  ensureSeriesArtifactsDir,
  materializeSpecContextFiles,
} from './provisioning-materials.js';
import type { ProvisioningCaptured, ProvisioningLiveDependencies } from './provisioning-ports.js';
import type { WorkspacePrepared } from './provisioning-workspace.js';
import { resolveRefRepoPat } from './reference-repos.js';
import { stageReferenceSnapshots } from './reference-snapshots.js';
import { addRuntimeNetworkDefaults } from './runtime-network-defaults.js';

type Captured = Pick<
  ProvisioningCaptured,
  | 'allocateHostPort'
  | 'CONTAINER_APP_PORT'
  | 'execFileAsync'
  | 'podRepo'
  | 'profileStore'
  | 'containerManagerFactory'
  | 'worktreeManager'
  | 'networkManager'
  | 'sidecarManager'
  | 'mcpBaseUrl'
  | 'logger'
  | 'executionCredentialsFor'
  | 'injectionsForPod'
  | 'startHaproxyDenyReceiver'
  | 'hostnameFromUrl'
  | 'portFromUrl'
>;

export function createProvisioningContainer(
  deps: Pick<
    ProvisioningLiveDependencies,
    'launchConfiguration' | 'githubAuth' | 'warmImageExists'
  >,
  captured: Captured,
) {
  const {
    allocateHostPort,
    CONTAINER_APP_PORT,
    execFileAsync,
    podRepo,
    profileStore,
    containerManagerFactory,
    worktreeManager,
    networkManager,
    sidecarManager,
    mcpBaseUrl,
    logger,
    executionCredentialsFor,
    injectionsForPod,
    startHaproxyDenyReceiver,
    hostnameFromUrl,
    portFromUrl,
  } = captured;
  async function prepareContainer(input: WorkspacePrepared) {
    const { pod, launchConfig, profile, providerPreflight, podId, worktreePath, bareRepoPath } =
      input;
    const { emitStatus, stagedReferenceArchivePaths } = input.run;
    // Select container manager based on execution target
    const containerManager = containerManagerFactory.get(pod.executionTarget);

    // Compute initial network config — this creates the per-pod bridge
    // so sidecars can join it. The firewall script built here does NOT
    // yet include sidecar IPs; we rebuild it below once sidecars are up
    // and their bridge IPs are known.
    let networkName: string | undefined;
    let firewallScript: string | undefined;
    let initialMergedMcpServers: import('@autopod/shared').InjectedMcpServer[] | undefined;
    let daemonGatewayIp: string | undefined;
    let sandboxAllowedHosts: string[] | undefined;
    const runtimeNetworkPolicy = addRuntimeNetworkDefaults(
      launchConfig && pod.requireSidecars.length > 0 && !profile.networkPolicy?.enabled
        ? { enabled: true, mode: 'allow-all', allowedHosts: [] }
        : profile.networkPolicy,
      profile,
      pod.runtime,
      providerPreflight.manifestProvider,
      providerPreflight.account,
    );
    const runtimeNetworkPolicyMode = runtimeNetworkPolicy?.enabled
      ? (runtimeNetworkPolicy.mode ?? 'restricted')
      : undefined;
    if (pod.executionTarget === 'sandbox' && runtimeNetworkPolicy?.enabled) {
      initialMergedMcpServers = mergeMcpServers(
        injectionsForPod(pod).mcpServers,
        profile.mcpServers,
      );
      sandboxAllowedHosts = computeNetworkPolicyAllowlist(
        runtimeNetworkPolicy,
        initialMergedMcpServers,
        hostnameFromUrl(mcpBaseUrl),
        profile.privateRegistries,
      );
    }
    if (networkManager && pod.executionTarget === 'local' && runtimeNetworkPolicy?.enabled) {
      initialMergedMcpServers ??= mergeMcpServers(
        injectionsForPod(pod).mcpServers,
        profile.mcpServers,
      );
      daemonGatewayIp = await networkManager.getGatewayIp(podId);
      const netConfig = await networkManager.buildNetworkConfig(
        runtimeNetworkPolicy,
        initialMergedMcpServers,
        daemonGatewayIp,
        profile.privateRegistries,
        podId,
        [],
        [hostnameFromUrl(mcpBaseUrl)],
        portFromUrl(mcpBaseUrl),
      );
      if (netConfig) {
        networkName = netConfig.networkName;
        firewallScript = netConfig.firewallScript;
      }
    }

    // Allocate a host port for the container's app server
    const hostPort = allocateHostPort();

    // For .NET templates, cap MSBuild node count to half the available CPUs
    // (min 2, max 4) to prevent dozens of MSBuild workers from exhausting memory.
    const template = profile.template ?? 'node22';
    const isDotnet = template.startsWith('dotnet');

    // Registry authentication is independent from Azure DevOps Git/REST auth.
    const effectiveRegistryPat = profile.registryPat ?? null;
    const launchCredentials = launchConfig ? executionCredentialsFor(launchConfig) : undefined;
    const launchRegistry: LaunchRegistryMaterial | null =
      launchConfig && launchCredentials ? await launchCredentials.registries(launchConfig) : null;

    // Resolve sidecar specs up front so their env vars (e.g. Dagger's
    // _EXPERIMENTAL_DAGGER_RUNNER_HOST) can be baked into the pod container
    // env before spawn. Sidecar validation already ran at createSession, so
    // a null spec here is a config change between create and spawn; treat
    // as a hard error rather than silently skipping.
    const sidecarSpecs: { name: string; spec: import('@autopod/shared').SidecarSpec }[] = [];
    const sidecarEnv: Record<string, string> = {};
    for (const name of pod.requireSidecars) {
      if (launchConfig) {
        const resolved = launchSidecarSpec(launchConfig, name, randomBytes(32).toString('hex'));
        sidecarSpecs.push({ name, spec: resolved.spec });
        Object.assign(sidecarEnv, resolved.podEnv);
        continue;
      }
      const spec = resolveSidecarSpec(profile, name);
      if (!spec) {
        throw new AutopodError(
          `Sidecar '${name}' is no longer available on profile '${profile.name}'`,
          'INVALID_SIDECAR',
          409,
        );
      }
      sidecarSpecs.push({ name, spec });
    }
    for (const { spec } of sidecarSpecs) {
      Object.assign(sidecarEnv, sidecarPodEnv(spec));
    }
    if (sidecarSpecs.length > 0 && !sidecarManager) {
      throw new AutopodError(
        `Pod ${podId} requires sidecars but no SidecarManager is configured on the daemon`,
        'MISCONFIGURED_DAEMON',
        500,
      );
    }
    if (sidecarSpecs.length > 0 && !networkName) {
      throw new AutopodError(
        `Pod ${podId} requires sidecars; profile must have a networkPolicy enabled so sidecars and the pod share an isolated network`,
        'INVALID_CONFIGURATION',
        400,
      );
    }

    // Spawn sidecars FIRST on the per-pod bridge so the pod container's
    // firewall can be built with the sidecar IPs pre-allowlisted. If we
    // spawned the pod first, its iptables OUTPUT chain would REJECT every
    // packet to the sidecar before the sidecar even had an IP — the bug
    // that produced the "Connection refused" we chased.
    const startedSidecars: Record<string, string> = {};
    const sidecarIps: string[] = [];
    if (sidecarSpecs.length > 0 && sidecarManager && networkName) {
      try {
        for (const { name, spec } of sidecarSpecs) {
          emitStatus(`Spawning sidecar '${name}'…`);
          const handle = await sidecarManager.spawn({ spec, podId, networkName });
          startedSidecars[name] = handle.containerId;
          await sidecarManager.waitHealthy(handle, spec);
          const ip = await sidecarManager.getBridgeIp(handle, networkName);
          if (ip) {
            sidecarIps.push(ip);
          } else {
            logger.warn(
              { podId, sidecarName: name, containerId: handle.containerId },
              'Sidecar has no IP on the pod network — pod firewall may block traffic to it',
            );
          }
        }
        podRepo.update(podId, { sidecarContainerIds: startedSidecars });
      } catch (err) {
        logger.error(
          { err, podId, started: startedSidecars },
          'Sidecar spawn failed — cleaning up',
        );
        for (const id of Object.values(startedSidecars)) {
          await sidecarManager.kill(id).catch((killErr) => {
            logger.warn({ killErr, containerId: id }, 'Failed to kill partial sidecar');
          });
        }
        throw err;
      }
    }

    // Rebuild the firewall script with sidecar IPs AND DNS names allowed
    // through the pod's firewall. The IP list unblocks iptables; the DNS
    // name list unblocks dnsmasq — both are required. Without the DNS
    // piece the pod's CLI resolves the sidecar to NXDOMAIN and never
    // gets as far as iptables to notice the IP is allowed.
    if (
      sidecarSpecs.length > 0 &&
      networkManager &&
      initialMergedMcpServers &&
      daemonGatewayIp &&
      runtimeNetworkPolicy?.enabled
    ) {
      const finalConfig = await networkManager.buildNetworkConfig(
        runtimeNetworkPolicy,
        initialMergedMcpServers,
        daemonGatewayIp,
        profile.privateRegistries,
        podId,
        sidecarIps,
        [hostnameFromUrl(mcpBaseUrl)],
        portFromUrl(mcpBaseUrl),
      );
      if (finalConfig) {
        firewallScript = finalConfig.firewallScript;
      }
    }

    const referencePolicy = deps.launchConfiguration;
    const frozenReferences =
      launchConfig && referencePolicy
        ? await stageReferenceSnapshots(launchConfig, worktreeManager, () =>
            referencePolicy.assertCurrentCapabilities(launchConfig),
          )
        : new Map<string, Buffer>();

    // Clone authenticated profile references before provisioning so auth/clone failures
    // cannot leave a partial pod and daemon credentials never cross into the container.
    const stagedReferenceRepos = new Map<
      string,
      { archivePath: string; containerArchive: string }
    >();
    try {
      for (const repo of launchConfig ? [] : (pod.referenceRepos ?? [])) {
        if (!repo.sourceProfile) continue;
        const credential = await resolveRefRepoPat(repo, profileStore, deps.githubAuth, logger);
        if (!credential) continue;
        const sourceProfile = profileStore.get(repo.sourceProfile);
        if (!sourceProfile) {
          throw new Error(`Reference repo profile ${repo.sourceProfile} was not found`);
        }
        const refId = generateId(8);
        const refWorktree = await worktreeManager.create({
          repoUrl: repo.url,
          branch: `autopod/ref-${podId}-${refId}`,
          baseBranch: sourceProfile.defaultBranch ?? 'main',
          sessionId: `ref-${podId}-${refId}`,
          pat: credential,
        });
        const archivePath = path.join(os.tmpdir(), `autopod-ref-${podId}-${refId}.tgz`);
        stagedReferenceArchivePaths.add(archivePath);
        try {
          await execFileAsync(
            'tar',
            ['--exclude=.git', '-czf', archivePath, '-C', refWorktree.worktreePath, '.'],
            { timeout: 60_000 },
          );
        } finally {
          await worktreeManager.cleanup(refWorktree.worktreePath).catch(() => {});
        }
        stagedReferenceRepos.set(repo.mountPath, {
          archivePath,
          containerArchive: `/tmp/.autopod-ref-${refId}.tgz`,
        });
      }
    } catch (err) {
      await Promise.all(
        [...stagedReferenceRepos.values()].map(({ archivePath }) =>
          rm(archivePath, { force: true }),
        ),
      );
      throw err;
    }

    // Spawn container with port mapping so daemon + user can reach the app
    // Prefer the per-profile warm image when one has been built — that's
    // where customisations like Serena / roslyn-codelens-mcp live. Fall
    // back to the bare base image only when no warm image exists.
    const spawnImage =
      launchConfig && deps.launchConfiguration
        ? await deps.launchConfiguration.prepareEnvironment(launchConfig)
        : resolvePodSpawnImage(profile, template, pod.executionTarget);
    if (pod.executionTarget === 'sandbox') {
      await verifySandboxWarmImageAccess(profile, spawnImage, deps.warmImageExists);
    }
    emitStatus(
      pod.executionTarget === 'sandbox'
        ? `Creating sandbox (${profile.template})…`
        : `Spawning container (${profile.template})…`,
    );
    logger.info(
      { podId, image: spawnImage, warm: Boolean(profile.warmImageTag) },
      'Spawning pod container',
    );

    const hostPreviewUrl = `http://127.0.0.1:${hostPort}`;
    const containerPreviewUrl = `http://127.0.0.1:${CONTAINER_APP_PORT}`;
    const containerEnv: Record<string, string> = {
      POD_ID: podId,
      ...RUNTIME_TELEMETRY_OPT_OUT_ENV,
      ...buildValidationContextEnv({
        podId,
        headBranch: pod.branch,
        baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
        startCommitSha: pod.startCommitSha,
      }),
      PORT: String(CONTAINER_APP_PORT),
      HOST: '0.0.0.0', // bind to all interfaces inside container for Docker port forwarding
      // Docker pods get native port mapping. Sandbox pods get a daemon-owned
      // host-port proxy for humans, while in-container tooling still needs
      // the app's loopback URL.
      PREVIEW_URL: pod.executionTarget === 'local' ? hostPreviewUrl : containerPreviewUrl,
      ...(isDotnet
        ? {
            MSBUILDNODECOUNT: '4',
            // Disable MSBuild's TerminalLogger — it crashes with ArgumentOutOfRangeException
            // when terminal dimensions are unavailable (non-TTY exec contexts).
            MSBUILDTERMINALLOGGER: 'false',
          }
        : {}),
      ...sidecarEnv,
    };

    // Per-pod conversation-history directories. Bind-mounted into the container
    // so session state survives container respawns (sleep/wake, crash recovery).
    // Wired for Claude and Codex; Copilot still respawns fresh.
    let claudeStateDir: string | null = null;
    if (pod.runtime === 'claude') {
      try {
        claudeStateDir = await ensureClaudeStateDir(podId);
      } catch (err) {
        logger.warn(
          { err, podId },
          'Failed to create Claude state dir — resume across container respawns will fail',
        );
      }
    }

    let codexStateDir: string | null = null;
    if (pod.runtime === 'codex') {
      try {
        codexStateDir = await ensureCodexStateDir(podId);
      } catch (err) {
        logger.warn(
          { err, podId },
          'Failed to create Codex state dir — resume across container respawns will fail',
        );
      }
    }

    const specContextHostPath = await materializeSpecContextFiles(
      podId,
      pod.specContextFiles,
      logger,
    );
    const seriesArtifactsHostPath = await ensureSeriesArtifactsDir(pod, logger);

    let containerId: string;
    try {
      containerId = await containerManager.spawn({
        image: spawnImage,
        podId,
        env: containerEnv,
        ports: [{ container: CONTAINER_APP_PORT, host: hostPort }],
        volumes: [
          ...(worktreePath ? [{ host: worktreePath, container: '/mnt/worktree' }] : []),
          ...(bareRepoPath ? [{ host: bareRepoPath, container: bareRepoPath }] : []),
          ...(specContextHostPath
            ? [
                {
                  host: specContextHostPath,
                  container: SPEC_CONTEXT_CONTAINER_DIR,
                  readOnly: true,
                },
              ]
            : []),
          ...(seriesArtifactsHostPath
            ? [{ host: seriesArtifactsHostPath, container: POD_ARTIFACTS_CONTAINER_DIR }]
            : []),
          ...(claudeStateDir
            ? [{ host: claudeStateDir, container: `${CONTAINER_HOME_DIR}/.claude/projects` }]
            : []),
          ...(codexStateDir
            ? [{ host: codexStateDir, container: `${CONTAINER_HOME_DIR}/.codex/sessions` }]
            : []),
        ],
        networkName,
        firewallScript,
        networkPolicyMode: runtimeNetworkPolicyMode,
        allowedHosts: sandboxAllowedHosts,
        memoryBytes:
          (profile.containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB) * 1024 * 1024 * 1024,
        nanoCpus: launchConfig
          ? launchConfig.resolvedExecution.main.cpus === null
            ? undefined
            : Math.floor(launchConfig.resolvedExecution.main.cpus * 1e9)
          : resolveContainerNanoCpus(process.env.CONTAINER_CPUS),
        onProgress: emitStatus,
      });
    } catch (err) {
      // Pod container failed to spawn — tear down sidecars we already
      // brought up so they don't leak on the per-pod bridge.
      if (sidecarManager) {
        for (const id of Object.values(startedSidecars)) {
          await sidecarManager.kill(id).catch(() => {});
        }
      }
      throw err;
    }

    // Restricted-mode pods run HAProxy as their egress allowlist; start
    // the denial receiver so blocked SNIs surface as pod events. Best
    // effort — failure here doesn't gate the pod.
    if (profile.networkPolicy?.enabled && profile.networkPolicy.mode === 'restricted') {
      await startHaproxyDenyReceiver(pod, containerId);
    }
    return {
      ...input,
      kind: 'ready' as const,
      pod,
      launchConfig,
      profile,
      containerManager,
      containerId,
      frozenReferences,
      stagedReferenceRepos,
      hostPreviewUrl,
      launchRegistry,
      effectiveRegistryPat,
    };
  }
  return { prepareContainer };
}

export type ContainerPrepared = Extract<
  Awaited<ReturnType<ReturnType<typeof createProvisioningContainer>['prepareContainer']>>,
  { kind: 'ready' }
>;
