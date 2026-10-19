import {
  AutopodError,
  type EffectiveLaunchConfig,
  type InjectedMcpServer,
  type McpServerConfig,
  type Pod,
  type ReasoningEffort,
  type Runtime,
  type StdioInjectedMcpServer,
} from '@autopod/shared';
import type { LaunchExecutionCredentials } from '../configuration/execution-credentials.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ClaudeRuntime } from '../runtimes/claude-runtime.js';
import type { CodexRuntime } from '../runtimes/codex-runtime.js';
import type { PiRuntime } from '../runtimes/pi-runtime.js';
import { mergeMcpServers } from './injection-merger.js';

interface RuntimeResumeContextDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
  };
  sessionTokenIssuer?: { generate(podId: string): string };
}

interface RuntimeResumeContextCaptured {
  executionForPod(pod: Pod): PodExecutionSettings;
  executionCredentialsFor(config: EffectiveLaunchConfig): LaunchExecutionCredentials | undefined;
  injectionsForPod(pod: Pod): { mcpServers: InjectedMcpServer[] };
  mcpBaseUrl: string;
  buildCodeIntelligenceServers(profile: PodExecutionSettings): StdioInjectedMcpServer[];
  resolvedReasoningEffort(
    profile: PodExecutionSettings,
    snapshot?: Record<string, unknown> | null,
  ): ReasoningEffort;
}

export function createRuntimeResumeContext(
  deps: RuntimeResumeContextDependencies,
  captured: RuntimeResumeContextCaptured,
): {
  primeRuntimeForResume(
    pod: Pod,
    runtime: Runtime,
    containerId: string,
    env: Record<string, string> | undefined,
  ): Promise<McpServerConfig[]>;
} {
  const {
    executionForPod,
    executionCredentialsFor,
    injectionsForPod,
    mcpBaseUrl,
    buildCodeIntelligenceServers,
    resolvedReasoningEffort,
  } = captured;

  async function primeRuntimeForResume(
    pod: Pod,
    runtime: Runtime,
    containerId: string,
    env: Record<string, string> | undefined,
  ): Promise<McpServerConfig[]> {
    const frozenProfile = executionForPod(pod);
    const launch = deps.launchConfiguration?.read(pod.id);
    if (launch?.intent === 'goal')
      throw new AutopodError(
        'Resume this Goal through its native controls',
        'GOAL_NATIVE_RESUME_REQUIRED',
        409,
      );
    if (launch) await deps.launchConfiguration?.assertCurrentCapabilities(launch);
    const material = launch ? await executionCredentialsFor(launch)?.agent(launch) : undefined;
    const profile = material ? { ...frozenProfile, ...material } : frozenProfile;
    const mcpUrl = `${mcpBaseUrl}/mcp/${pod.id}`;
    const mcpSessionToken = deps.sessionTokenIssuer?.generate(pod.id);
    const escalationHeaders = mcpSessionToken
      ? { Authorization: `Bearer ${mcpSessionToken}` }
      : undefined;
    const httpMcpServers = mergeMcpServers(
      injectionsForPod(pod).mcpServers,
      profile.mcpServers,
    ).filter((server) => server.type !== 'stdio');
    const mcpServers: McpServerConfig[] = [
      { type: 'http', name: 'escalation', url: mcpUrl, headers: escalationHeaders },
      ...httpMcpServers.map(
        (server) =>
          ({
            type: 'http',
            name: server.name,
            url: `${mcpBaseUrl}/mcp-proxy/${encodeURIComponent(server.name)}/${pod.id}`,
            headers: escalationHeaders,
          }) satisfies McpServerConfig,
      ),
      ...buildCodeIntelligenceServers(profile).map(
        (server) =>
          ({
            type: 'stdio',
            name: server.name,
            command: server.command,
            ...(server.args && { args: server.args }),
            ...(server.env && { env: server.env }),
          }) satisfies McpServerConfig,
      ),
      ...(launch
        ? profile.mcpServers
            .filter((server) => server.type === 'stdio')
            .map((server) => ({
              type: 'stdio' as const,
              name: server.name,
              command: server.command,
              args: server.args,
              env: server.env,
            }))
        : []),
    ];
    if (launch) await deps.launchConfiguration?.assertCurrentCapabilities(launch);

    const reasoningEffort = resolvedReasoningEffort(
      profile,
      pod.profileSnapshot as unknown as Record<string, unknown> | null,
    );
    if (pod.runtime === 'pi') {
      const piRuntime = runtime as PiRuntime;
      if (pod.piSessionId) piRuntime.setPiSessionId(pod.id, pod.piSessionId);
      piRuntime.setPiResumeConfig({
        podId: pod.id,
        task: '',
        model: pod.model,
        reasoningEffort,
        workDir: '/workspace',
        containerId,
        customInstructions: 'resume',
        env: env ?? {},
        mcpServers,
      });
    } else if (pod.runtime === 'claude' && 'setClaudeResumeConfig' in runtime) {
      if (pod.claudeSessionId) {
        (runtime as ClaudeRuntime).setClaudeSessionId(pod.id, pod.claudeSessionId);
      }
      (runtime as ClaudeRuntime).setClaudeResumeConfig(pod.id, mcpServers, reasoningEffort);
    } else if (pod.runtime === 'codex' && 'setCodexResumeConfig' in runtime) {
      (runtime as CodexRuntime).setCodexResumeConfig(pod.id, mcpServers, reasoningEffort);
    }
    return mcpServers;
  }

  return { primeRuntimeForResume };
}
