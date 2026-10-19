import type { McpServerConfig, StdioInjectedMcpServer } from '@autopod/shared';
import { AUTOPOD_INSTRUCTIONS_PATH } from '@autopod/shared';
import { resolveEffectiveActionPolicy } from '../actions/policy-resolver.js';
import { buildProviderEnv } from '../providers/index.js';
import { createProfileMemoryReviewer } from '../providers/memory-reviewer.js';
import { buildValidationContextEnv } from '../validation/validation-context-env.js';
import { mergeClaudeMdSections, mergeMcpServers } from './injection-merger.js';
import { selectRelevantMemories } from './memory-selector.js';
import { projectMemoryScope } from './project-memory-scope.js';
import type {
  PreparedExecution,
  ProvisioningCaptured,
  ProvisioningLiveDependencies,
} from './provisioning-ports.js';
import {
  AGENT_ENV_PATH,
  AGENT_SHIM_PATH,
  AGENT_SHIM_SCRIPT,
  MCP_INIT_PROBE_SCRIPT,
  buildAgentEnvFile,
  buildCodeIntelligenceServers,
  repairSandboxAgentHomeOwnership,
} from './provisioning-runtime-files.js';
import type { SessionMaterials } from './provisioning-session-materials.js';
import {
  buildNuGetCredentialEnv,
  buildNuGetSecretFile,
  ensureNuGetCredentialProvider,
  validateRegistryFiles,
} from './registry-injector.js';
import { prepareLaunchRepository } from './repository-preparation.js';
import { resolveSections } from './section-resolver.js';
import { generateSystemInstructions } from './system-instructions-generator.js';

type Captured = Pick<
  ProvisioningCaptured,
  | 'profileStore'
  | 'providerAccountStore'
  | 'providerCatalog'
  | 'mcpBaseUrl'
  | 'logger'
  | 'safetyEventsRepo'
  | 'injectionsForPod'
  | 'rememberMaxCredentialLineage'
  | 'emitActivityStatus'
>;

export function createProvisioningAgentMaterials(
  deps: Pick<
    ProvisioningLiveDependencies,
    | 'actionEngine'
    | 'memoryRepo'
    | 'memoryUsageRepo'
    | 'providerAttemptRepo'
    | 'launchConfiguration'
    | 'sessionTokenIssuer'
  >,
  captured: Captured,
) {
  const {
    profileStore,
    providerAccountStore,
    providerCatalog,
    mcpBaseUrl,
    logger,
    safetyEventsRepo,
    injectionsForPod,
    rememberMaxCredentialLineage,
    emitActivityStatus,
  } = captured;
  async function prepareAgentMaterials(input: SessionMaterials): Promise<PreparedExecution> {
    const {
      pod,
      profile,
      containerManager,
      containerId,
      podId,
      queuedProviderAttempt,
      launchConfig,
      launchRegistry,
      effectiveRegistryPat,
      resolvedSkillInjections,
      registryFiles,
      isFreshContainerValidationOnly,
      isRecovery,
      isInfrastructureRecovery,
      isRework,
      worktreePath,
      reasoningEffort,
    } = input;
    const { emitStatus } = input.run;
    // Merge daemon + profile injections
    const mergedMcpServers = mergeMcpServers(injectionsForPod(pod).mcpServers, profile.mcpServers);
    const mergedSections = mergeClaudeMdSections(
      injectionsForPod(pod).claudeMdSections,
      profile.claudeMdSections,
    );

    // Build stdio MCP servers from codeIntelligence profile flags.
    // These run as local subprocesses inside the container, started by the
    // agent CLI itself. They flow into SpawnConfig.mcpServers (alongside
    // HTTP entries) so the runtime writes them into its out-of-tree config
    // file (e.g. /home/autopod/.autopod/mcp-config.json for Claude). We
    // intentionally do NOT touch /workspace/.mcp.json here — that file
    // belongs to the user's repo, and any daemon-injected entry would
    // get swept up by `git add` and committed.
    const stdioMcpServers = buildCodeIntelligenceServers(profile);

    // Preflight: confirm each code-intel binary exists before injecting it.
    // Without this filter, a missing binary causes Claude CLI to silently
    // fail the stdio MCP spawn, the tools are never registered, and the
    // agent falls back to grep with no indication anything is wrong.
    // Servers that fail the check are dropped here so they never appear in
    // mcp-config.json or the CLAUDE.md — clean absence is less confusing
    // than a registered-but-broken tool.
    // Write the MCP init probe script once; each server test runs it with its
    // own command + args. Cleaned up after the loop.
    const MCP_PROBE_PATH = '/tmp/.autopod-mcp-probe.py';
    await containerManager.writeFile(containerId, MCP_PROBE_PATH, MCP_INIT_PROBE_SCRIPT);

    // Binary-check all servers first (fast) then probe survivors in parallel.
    // Language servers (Roslyn, C# LS) can take 60-90s to initialize on a
    // real project — sequential probing would add minutes to startup.
    const binaryOkServers: StdioInjectedMcpServer[] = [];
    await Promise.all(
      stdioMcpServers.map(async (server) => {
        const binaryCheck = await containerManager.execInContainer(
          containerId,
          ['sh', '-c', `command -v ${server.command} >/dev/null 2>&1`],
          { timeout: 5_000 },
        );
        if (binaryCheck.exitCode !== 0) {
          const msg = `Code-intel MCP "${server.name}" requested by profile but binary "${server.command}" not found in container — agent will fall back to grep/find. Rebuild the warm image: \`ap profile warm ${profile.name} --rebuild\`.`;
          logger.error({ podId, server: server.name, command: server.command }, msg);
          emitStatus(`⚠️ ${msg}`);
        } else {
          binaryOkServers.push(server);
        }
      }),
    );

    // MCP init probe — actually start each server and complete the JSON-RPC
    // initialize handshake. Catches language-server issues (missing NuGet/npm
    // cache, permission errors) that the binary check alone cannot detect.
    // Timeout = slow start (Roslyn on a large solution can take 90s+) — server
    // is still included in config and will initialize lazily inside the container.
    // Only a clean non-zero exit (server crashed or returned an error response)
    // triggers a rebuild suggestion.
    const workingStdioServers: StdioInjectedMcpServer[] = [...binaryOkServers];
    await Promise.all(
      binaryOkServers.map(async (server) => {
        const probeCmd = ['python3', MCP_PROBE_PATH, server.command, ...(server.args ?? [])];
        const mcpProbe = await containerManager.execInContainer(containerId, probeCmd, {
          timeout: 100_000,
          cwd: '/workspace',
        });

        if (mcpProbe.exitCode === 0) {
          logger.info({ podId, server: server.name }, `Code-intel MCP "${server.name}" probe OK`);
          emitStatus(`✅ Code-intel MCP "${server.name}" initialized and ready`);
        } else {
          const stderr = (mcpProbe.stderr || '').trim();
          const isTimeout = stderr.startsWith('timeout:');
          if (isTimeout) {
            logger.info(
              { podId, server: server.name },
              `Code-intel MCP "${server.name}" slow to start — will initialize inside container`,
            );
            emitStatus(
              `🔄 Code-intel MCP "${server.name}" is starting (language server initializing in background)`,
            );
          } else {
            const detail = (mcpProbe.stdout || stderr || 'no output').slice(0, 200);
            logger.warn(
              { podId, server: server.name, detail },
              `Code-intel MCP "${server.name}" probe failed`,
            );
            emitStatus(
              `⚠️ Code-intel MCP "${server.name}" binary found but failed to respond (${detail}). If this persists, rebuild: \`ap profile warm ${profile.name} --rebuild\``,
            );
          }
        }
      }),
    );

    await containerManager.execInContainer(containerId, ['rm', '-f', MCP_PROBE_PATH], {
      timeout: 3_000,
    });

    // Detect and auto-heal 0-byte .bin/ stubs before the agent starts. These are a
    // symptom of `npm install --ignore-scripts` overwriting valid stubs without running
    // postinstall hooks, leaving empty files that can't be executed.
    const stubScan = await containerManager
      .execInContainer(
        containerId,
        [
          'sh',
          '-c',
          'find /workspace -path "*/node_modules/.bin/*" -empty -print 2>/dev/null | head -10',
        ],
        { timeout: 5_000 },
      )
      .catch(() => null);
    const brokenStubs = stubScan?.stdout?.trim();
    if (brokenStubs) {
      const first5 = brokenStubs.split('\n').slice(0, 5).join(', ');
      logger.warn({ podId }, `0-byte .bin stubs detected before agent start: ${first5}`);
      emitStatus('⚠️ 0-byte .bin stubs detected — running npm rebuild to restore them…');
      const rebuildResult = await containerManager
        .execInContainer(
          containerId,
          [
            'sh',
            '-c',
            "find /workspace -path '*/node_modules/.bin/*' -empty -print 2>/dev/null | awk -F'/node_modules/' '{print $1}' | sort -u | while read -r dir; do [ -f \"$dir/package.json\" ] && (cd \"$dir\" && npm rebuild 2>&1); done",
          ],
          { timeout: 120_000 },
        )
        .catch((err: unknown) => ({
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        }));
      if (rebuildResult.exitCode === 0) {
        logger.info({ podId }, 'npm rebuild completed — bin stubs restored');
        emitStatus('✅ npm rebuild completed — bin stubs restored');
      } else {
        logger.warn({ podId }, `npm rebuild failed: ${rebuildResult.stdout?.slice(0, 300)}`);
        emitStatus(
          `⚠️ npm rebuild failed. Agent may encounter "Permission denied" errors for node_modules/.bin tools.`,
        );
      }
    }

    // Rewrite injected MCP server URLs to route through daemon proxy.
    // Only HTTP servers go through the proxy — stdio servers run as local
    // subprocesses in the container and are appended to mcpServers below.
    // Agent sees proxy URLs, daemon handles auth injection + PII stripping.
    const httpMcpServers = mergedMcpServers.filter((s) => s.type !== 'stdio');
    const proxiedMcpServers = httpMcpServers.map((s) => ({
      ...s,
      url: `${mcpBaseUrl}/mcp-proxy/${encodeURIComponent(s.name)}/${podId}`,
      // Don't expose auth headers to agent — proxy injects them
      headers: undefined,
    }));

    // Resolve available actions from profile's action policy.
    // resolveEffectiveActionPolicy auto-injects the 'deploy' group when
    // profile.deployment.enabled is true so users only have to flip one switch.
    const effectivePolicy = resolveEffectiveActionPolicy(profile);
    const availableActions = effectivePolicy
      ? (deps.actionEngine?.getAvailableActions(effectivePolicy) ?? [])
      : [];

    // Resolve runtime-fetched sections (fetches URLs, respects token budgets)
    if (mergedSections.some((s) => s.fetch)) {
      emitStatus('Fetching runtime CLAUDE.md sections…');
    }
    const resolvedSections = await resolveSections(mergedSections, logger, {
      podId,
      safetyEventsRepo,
    });

    // Generate system instructions and deliver based on runtime
    const mcpUrl = `${mcpBaseUrl}/mcp/${podId}`;

    // Build provider-aware env (API keys, OAuth creds, Foundry config) before memory
    // ranking so automatic review can use the same prepared pod/container auth path
    // as the agent runtime.
    emitStatus('Building provider credentials…');
    const providerResult = await buildProviderEnv(profile, podId, logger, {
      profileStore,
      providerAccountStore,
      providerCatalog,
      runtime: pod.runtime,
      ...(queuedProviderAttempt?.providerAccountId || pod.providerIdSnapshot
        ? {
            providerBinding: {
              accountId: queuedProviderAttempt?.providerAccountId ?? pod.providerAccountIdSnapshot,
              providerId: queuedProviderAttempt?.providerAccountId
                ? (providerAccountStore?.get(queuedProviderAttempt.providerAccountId).provider ??
                  pod.providerIdSnapshot)
                : pod.providerIdSnapshot,
            },
          }
        : {}),
    });
    rememberMaxCredentialLineage(podId, providerResult);
    const secretEnv: Record<string, string> = {
      POD_ID: podId,
      ...providerResult.env,
      ...buildValidationContextEnv({
        podId,
        headBranch: pod.branch,
        baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
        startCommitSha: pod.startCommitSha,
      }),
    };

    // Codex runtime: write OPENAI_API_KEY to a secret file, pass file path in env.
    if (!launchConfig && pod.runtime === 'codex' && process.env.OPENAI_API_KEY) {
      const oaiFilePath = '/run/autopod/openai-api-key';
      providerResult.secretFiles.push({
        path: oaiFilePath,
        content: process.env.OPENAI_API_KEY,
      });
      secretEnv.OPENAI_API_KEY_FILE = oaiFilePath;
    }

    // NuGet PAT: write to a 0400 secret file instead of passing in exec env.
    const nugetSecret =
      launchRegistry?.nugetSecret ??
      buildNuGetSecretFile(profile.privateRegistries, effectiveRegistryPat);
    if (nugetSecret) {
      providerResult.secretFiles.push({ path: nugetSecret.path, content: nugetSecret.content });
      secretEnv[nugetSecret.envFileKey] = nugetSecret.path;
    }

    // Write provider credential files to container (e.g., OAuth .credentials.json for MAX)
    for (const file of providerResult.containerFiles) {
      await containerManager.writeFile(containerId, file.path, file.content);
      logger.info(
        { podId, path: file.path, bytes: file.content.length },
        'Wrote provider credential file to container',
      );
    }
    await repairSandboxAgentHomeOwnership(containerManager, containerId, pod.executionTarget);

    // Write secret files (API keys, tokens) to /run/autopod/ with restrictive modes.
    // The sandbox file API currently materializes uploads as root-owned files even
    // when the warm image runs as the non-root autopod user, so sandbox shims need
    // owner-neutral read/execute bits.
    const secretFileMode = pod.executionTarget === 'sandbox' ? '0444' : '0400';
    const shimMode = pod.executionTarget === 'sandbox' ? '0555' : '0500';
    // These are referenced by *_FILE env vars in secretEnv — the exec shim reads
    // them and sets the real env var before starting the agent process.
    if (pod.executionTarget === 'sandbox') {
      const pidFile = await containerManager.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          [
            'install -d -o root -g root -m 0755 /run/autopod',
            'install -o autopod -g autopod -m 0600 /dev/null /run/autopod/agent.pid',
          ].join(' && '),
        ],
        { timeout: 5_000, user: 'root' },
      );
      if (pidFile.exitCode !== 0) {
        throw new Error(
          `Failed to arm sandbox agent PID recovery: ${pidFile.stderr || pidFile.stdout}`,
        );
      }
    } else {
      await containerManager.execInContainer(containerId, ['mkdir', '-p', '/run/autopod'], {
        timeout: 5_000,
      });
    }
    for (const sf of providerResult.secretFiles) {
      await containerManager.writeFile(containerId, sf.path, sf.content);
      await containerManager.execInContainer(containerId, ['chmod', secretFileMode, sf.path], {
        timeout: 5_000,
      });
      logger.info({ podId, path: sf.path, mode: secretFileMode }, 'Wrote secret file to container');
    }
    // Write the agent shim that reads *_FILE env vars and sets the real env var
    // before exec-ing the runtime. SDKs that don't support the _FILE convention
    // get the value via this shim so the raw secret is never in the exec's initial env.
    await containerManager.writeFile(containerId, AGENT_ENV_PATH, buildAgentEnvFile(secretEnv));
    await containerManager.execInContainer(containerId, ['chmod', secretFileMode, AGENT_ENV_PATH], {
      timeout: 5_000,
    });
    await containerManager.writeFile(containerId, AGENT_SHIM_PATH, AGENT_SHIM_SCRIPT);
    await containerManager.execInContainer(containerId, ['chmod', shimMode, AGENT_SHIM_PATH], {
      timeout: 5_000,
    });

    // Select approved memories before agent start. Reviewer ranking is best-effort:
    // if it is unavailable, the pod still starts with deterministic fallback context.
    let memorySelection: Awaited<ReturnType<typeof selectRelevantMemories>> | undefined;
    if (deps.memoryRepo && pod.options.agentMode === 'auto') {
      const reviewerModelId =
        profile.reviewerModel || profile.defaultModel || pod.model || 'claude-haiku-4-5';
      const reviewerResult = launchConfig
        ? {
            ok: false as const,
            reason: 'Repository memory uses deterministic selection during provisioning',
          }
        : await createProfileMemoryReviewer(profile, reviewerModelId, logger, {
            container: {
              podId,
              containerId,
              containerManager,
              env: secretEnv,
              timeoutMs: 20_000,
            },
          });
      memorySelection = await selectRelevantMemories({
        pod,
        profile,
        deps: {
          memoryRepo: deps.memoryRepo,
          projectScope: projectMemoryScope(pod, launchConfig),
          usageRepo: deps.memoryUsageRepo,
          reviewer: reviewerResult.ok ? reviewerResult.reviewer : undefined,
          reviewerModel: reviewerResult.ok ? reviewerResult.model : undefined,
          reviewerUnavailableReason: reviewerResult.ok ? undefined : reviewerResult.reason,
          logger,
        },
      });
      if (memorySelection.unavailableReason && memorySelection.selected.length > 0) {
        emitActivityStatus(
          podId,
          `Memory reviewer unavailable (${memorySelection.unavailableReason}); using deterministic keyword fallback.`,
        );
      }
    }

    const instructionPod = deps.providerAttemptRepo
      ? { ...pod, providerAttempts: deps.providerAttemptRepo.list(podId) }
      : pod;
    const systemInstructions = generateSystemInstructions(profile, instructionPod, mcpUrl, {
      referenceRevisions: Object.fromEntries(
        (deps.launchConfiguration?.read(podId)?.references ?? []).map((reference, index) => [
          `${index + 1}-${reference.id}`,
          reference.revision,
        ]),
      ),
      injectedSections: resolvedSections,
      injectedMcpServers: [...proxiedMcpServers, ...workingStdioServers],
      availableActions,
      injectedSkills: resolvedSkillInjections,
      relevantMemories: memorySelection?.selected,
      memoryUnavailableReason: memorySelection?.unavailableReason,
    });

    // Write system instructions to a path outside /workspace so the repo's own
    // CLAUDE.md / copilot-instructions.md is never overwritten.
    // Claude CLI reads this via --append-system-prompt-file; Copilot via customInstructions.
    emitStatus('Writing system instructions to container…');
    await containerManager.writeFile(containerId, AUTOPOD_INSTRUCTIONS_PATH, systemInstructions);

    // Generate a pod-scoped token so the container can authenticate its MCP calls.
    // The token is passed as Authorization: Bearer on the escalation MCP server config
    // and verified by the /mcp/:podId route handler.
    const mcpSessionToken = deps.sessionTokenIssuer?.generate(podId);
    const escalationHeaders = mcpSessionToken
      ? { Authorization: `Bearer ${mcpSessionToken}` }
      : undefined;

    // Build MCP server list for runtime.
    // The pod token authenticates BOTH the escalation endpoint and the
    // proxied-MCP endpoints — without it a pod on another pod could
    // impersonate this pod and abuse its injected MCP credentials.
    // Stdio servers (serena, roslyn-codelens) are included here so the
    // runtime emits them into its out-of-tree config file. They never
    // touch the user's working tree.
    const mcpServers: McpServerConfig[] = [
      { type: 'http', name: 'escalation', url: mcpUrl, headers: escalationHeaders },
      ...proxiedMcpServers.map(
        (s) =>
          ({
            type: 'http',
            name: s.name,
            url: s.url,
            headers: escalationHeaders,
          }) satisfies McpServerConfig,
      ),
      ...workingStdioServers.map(
        (s) =>
          ({
            type: 'stdio',
            name: s.name,
            command: s.command,
            ...(s.args && { args: s.args }),
            ...(s.env && { env: s.env }),
          }) satisfies McpServerConfig,
      ),
    ];

    // Verify credential files are readable by the container user
    if (providerResult.containerFiles.length > 0) {
      const verifyResult = await containerManager.execInContainer(containerId, [
        'sh',
        '-c',
        providerResult.containerFiles.map((f) => `ls -la ${f.path}`).join(' && '),
      ]);
      logger.info(
        { podId, stdout: verifyResult.stdout.trim(), stderr: verifyResult.stderr.trim() },
        'Credential file verification',
      );
    }

    // Ensure NuGet credential provider is installed (base image install can fail silently)
    const hasNugetRegistries = registryFiles.some((f) =>
      f.path.toLowerCase().endsWith('nuget.config'),
    );
    if (hasNugetRegistries) {
      try {
        await ensureNuGetCredentialProvider(containerManager, containerId);
        logger.info({ podId }, 'NuGet credential provider verified');
      } catch (cpErr) {
        logger.error({ podId, err: cpErr }, 'Failed to ensure NuGet credential provider');
        emitActivityStatus(
          podId,
          `⚠ Credential provider install failed: ${(cpErr as Error).message}`,
        );
      }
    }

    // Early validation: verify registry configs are parseable before agent starts.
    // Pass the NuGet credential env so the auth probe (`dotnet nuget search`) can
    // actually authenticate against the private feed — execInContainer otherwise
    // inherits an empty VSS_NUGET_EXTERNAL_FEED_ENDPOINTS from the image and
    // silently 401s.
    if (registryFiles.length > 0) {
      const probeEnv = launchRegistry?.nugetSecret
        ? { [launchRegistry.nugetSecret.envKey]: launchRegistry.nugetSecret.content }
        : buildNuGetCredentialEnv(profile.privateRegistries, effectiveRegistryPat);
      try {
        await validateRegistryFiles(
          containerManager,
          containerId,
          registryFiles,
          Object.keys(probeEnv).length > 0 ? probeEnv : undefined,
        );
        logger.info({ podId }, 'Registry config validation passed');
      } catch (regErr) {
        logger.error(
          { podId, err: regErr },
          'Registry config validation failed — pod will likely fail at build time',
        );
        emitActivityStatus(podId, `⚠ Registry config check failed: ${(regErr as Error).message}`);
      }
    }

    if (launchConfig?.repository?.setup.prepareCommand) {
      emitStatus('Preparing repository dependencies…');
      await prepareLaunchRepository(launchConfig, containerManager, containerId, {
        ...profile.buildEnv,
        ...(launchRegistry?.nugetSecret
          ? { [launchRegistry.nugetSecret.envKey]: launchRegistry.nugetSecret.content }
          : buildNuGetCredentialEnv(profile.privateRegistries, effectiveRegistryPat)),
      });
    }
    return {
      pod,
      launchConfig,
      containerManager,
      containerId,
      profile,
      isFreshContainerValidationOnly,
      isRecovery,
      isInfrastructureRecovery,
      isRework,
      systemInstructions,
      secretEnv,
      worktreePath,
      mcpServers,
      reasoningEffort,
      providerResult,
    };
  }
  return { prepareAgentMaterials };
}
