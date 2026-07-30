import type {
  ExecutionTarget,
  PodsitterDecision,
  PodsitterRuntime,
  ProviderFailureClassification,
  ReasoningEffort,
} from '@autopod/shared';
import { AutopodError, PROVIDER_CATALOG } from '@autopod/shared';
import type { Logger } from 'pino';
import type { DockerNetworkManager } from '../containers/docker-network-manager.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodsitterRepository } from '../podsitter/podsitter-repository.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { persistProviderAccountCredentials } from '../providers/credential-persistence.js';
import { buildProviderAccountEnv } from '../providers/env-builder.js';
import type { ProviderEnvResult } from '../providers/types.js';
import {
  classifyProviderError,
  sanitizeProviderMessage,
} from '../runtimes/provider-error-classifier.js';
import { DecisionOutputError, parseSystemDecisionOutput } from './decision-output.js';
import {
  SYSTEM_CREDENTIAL_SHIM,
  SYSTEM_CREDENTIAL_SHIM_PATH,
  buildSystemRuntimeInvocation,
} from './runtime-adapters.js';

const MAX_PROMPT_BYTES = 256_000;
const MAX_DIAGNOSTIC_BYTES = 4_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const LOCAL_IMAGE_DEFAULT = 'autopod-system-decision:local';

export interface SystemDecisionRunInput {
  decisionId: string;
  providerAccountId: string;
  runtime: PodsitterRuntime;
  model: string;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  contractVersion: 1;
  executionTarget: ExecutionTarget;
  timeoutMs: number;
}

export type SystemDecisionRunResult =
  | {
      ok: true;
      decision: PodsitterDecision;
      telemetry: { inputTokens?: number; outputTokens?: number; costUsd?: number };
      cleanup: 'clean';
    }
  | {
      ok: false;
      kind: 'configuration' | 'provider' | 'model_output' | 'infrastructure' | 'timeout';
      failure: ProviderFailureClassification & { code?: string };
      cleanup: 'clean' | 'leaked';
    };

export interface SystemDecisionRunnerOptions {
  localContainerManager: ContainerManager;
  sandboxContainerManager?: ContainerManager;
  providerAccountStore: ProviderAccountStore;
  repository: PodsitterRepository;
  logger: Logger;
  dockerNetworkManager?: Pick<DockerNetworkManager, 'buildNetworkConfig' | 'removeNetworkForPod'>;
  localImage?: string;
  hostedImage?: string;
}

export class SystemDecisionRunner {
  constructor(private readonly options: SystemDecisionRunnerOptions) {}

  async run(input: SystemDecisionRunInput): Promise<SystemDecisionRunResult> {
    const deadline = Date.now() + input.timeoutMs;
    const runId = `system-${input.decisionId}`;
    const backend = input.executionTarget === 'sandbox' ? 'azure-sandbox' : 'docker';
    this.options.repository.createSandboxRun({ id: runId, decisionId: input.decisionId, backend });
    let containerId: string | null = null;
    let result: SystemDecisionRunResult | null = null;
    let failureCode: string | null = null;
    let manager: ContainerManager | null = null;
    let providerEnv: ProviderEnvResult | null = null;

    try {
      manager = this.resolveManager(input.executionTarget);
      assertInput(input);
      const image = this.resolveImage(input.executionTarget);
      const account = this.options.providerAccountStore.get(input.providerAccountId);
      const catalogProvider = PROVIDER_CATALOG.providers.find(
        (provider) => provider.id === account.provider,
      );
      if (!catalogProvider) {
        throw new SystemDecisionConfigurationError(
          'Dedicated provider is absent from the provider catalog',
          'PROVIDER_ACCOUNT_CATALOG_MISSING',
        );
      }
      providerEnv = await buildProviderAccountEnv(input.providerAccountId, this.options.logger, {
        providerAccountStore: this.options.providerAccountStore,
        runtime: input.runtime,
      });
      const invocation = buildSystemRuntimeInvocation(input);
      const networkConfig =
        input.executionTarget === 'local'
          ? await this.buildLocalNetworkConfig(runId, catalogProvider.requiredHosts, account)
          : null;
      containerId = await manager.spawn({
        image,
        podId: runId,
        env: {},
        volumes: [],
        ports: [],
        networkPolicyMode: 'restricted',
        allowedHosts: providerRequiredHosts(account, catalogProvider.requiredHosts),
        networkName: networkConfig?.networkName,
        firewallScript: networkConfig?.firewallScript,
        onCreated: (createdContainerId) => {
          containerId = createdContainerId;
          if (!this.options.repository.setSandboxContainer(runId, createdContainerId)) {
            throw new Error('Failed to durably record system sandbox identity');
          }
        },
      });
      await this.writeRunFiles(manager, containerId, input.prompt, invocation, providerEnv);

      let execResult = await manager.execInContainer(containerId, invocation.command, {
        cwd: '/tmp',
        timeout: remainingTimeout(deadline),
        env: providerEnv.env,
      });
      if (execResult.exitCode !== 0) {
        result = this.providerFailure(input.runtime, execResult.stderr || execResult.stdout);
        failureCode = result.failure.category;
      } else {
        try {
          const decision = parseSystemDecisionOutput(input.runtime, execResult.stdout);
          result = {
            ok: true,
            decision,
            telemetry: parseTelemetry(execResult.stdout),
            cleanup: 'clean',
          };
        } catch (error) {
          if (!(error instanceof DecisionOutputError)) throw error;
          const repairPrompt = `${input.prompt}\n\nYour previous response failed strict schema validation: ${error.message}. Return only one corrected JSON decision.`;
          await manager.writeFile(containerId, invocation.promptPath, repairPrompt);
          execResult = await manager.execInContainer(containerId, invocation.command, {
            cwd: '/tmp',
            timeout: remainingTimeout(deadline),
            env: providerEnv.env,
          });
          if (execResult.exitCode !== 0) {
            result = this.providerFailure(input.runtime, execResult.stderr || execResult.stdout);
            failureCode = result.failure.category;
          } else {
            try {
              const decision = parseSystemDecisionOutput(input.runtime, execResult.stdout);
              result = {
                ok: true,
                decision,
                telemetry: parseTelemetry(execResult.stdout),
                cleanup: 'clean',
              };
            } catch (repairError) {
              const message =
                repairError instanceof Error ? repairError.message : 'Invalid repaired decision';
              result = failureResult('model_output', message);
              failureCode = 'MODEL_OUTPUT_INVALID';
            }
          }
        }
      }
    } catch (error) {
      const configurationCode = configurationFailureCode(error);
      const timedOut = isTimeout(error);
      const message = error instanceof Error ? error.message : 'System decision run failed';
      result = configurationCode
        ? failureResult(
            'configuration',
            configurationMessage(configurationCode),
            'clean',
            configurationCode,
          )
        : failureResult(timedOut ? 'timeout' : 'infrastructure', message);
      failureCode = configurationCode
        ? configurationCode
        : timedOut
          ? 'TIMEOUT'
          : 'SYSTEM_SANDBOX_FAILED';
    } finally {
      let cleanup: 'clean' | 'leaked' = 'clean';
      if (containerId && manager) {
        if (providerEnv) {
          await persistProviderAccountCredentials(
            containerId,
            manager,
            this.options.providerAccountStore,
            input.providerAccountId,
            this.options.logger,
            {
              maxLineage: providerEnv.maxCredentialLineage,
              openAiLineage: providerEnv.requiresOpenAiAuthJsonPersistence
                ? providerEnv.openAiAuthJsonLineage
                : undefined,
              piLineage: providerEnv.requiresPiAuthJsonPersistence
                ? providerEnv.piAuthJsonLineage
                : undefined,
            },
          ).catch((error) => {
            const message = sanitizeProviderMessage(String(error));
            this.options.logger.error(
              { runId, err: message },
              'System sandbox credential readback failed',
            );
            result = failureResult(
              'infrastructure',
              'Dedicated provider credential persistence failed',
              'clean',
              'CREDENTIAL_PERSISTENCE_FAILED',
            );
            failureCode = 'CREDENTIAL_PERSISTENCE_FAILED';
          });
        }
        try {
          await manager.kill(containerId);
        } catch (error) {
          cleanup = 'leaked';
          this.options.logger.error(
            { runId, containerId, err: sanitizeProviderMessage(String(error)) },
            'System decision sandbox cleanup failed',
          );
        }
      }
      if (input.executionTarget === 'local' && this.options.dockerNetworkManager) {
        await this.options.dockerNetworkManager.removeNetworkForPod(runId).catch((error) => {
          cleanup = 'leaked';
          this.options.logger.error(
            { runId, err: sanitizeProviderMessage(String(error)) },
            'System decision sandbox network cleanup failed',
          );
        });
      }
      if (!result) result = failureResult('infrastructure', 'System decision run did not complete');
      if (!result.ok && cleanup === 'leaked') result = { ...result, cleanup };
      if (result.ok && cleanup === 'leaked') {
        result = failureResult(
          'infrastructure',
          'Inference completed but system sandbox cleanup failed',
          'leaked',
        );
        failureCode = 'CLEANUP_FAILED';
      }
      this.options.repository.closeSandboxRun(runId, {
        outcome: cleanup === 'leaked' ? 'leaked' : result.ok ? 'completed' : 'failed',
        cleanupState: cleanup === 'leaked' ? 'retryable' : 'clean',
        failureCode,
      });
    }
    return result;
  }

  async reapLeakedRuns(staleBefore?: string): Promise<number> {
    let reaped = 0;
    for (const run of this.options.repository.listActiveSandboxRuns(staleBefore)) {
      const manager =
        run.backend === 'azure-sandbox'
          ? this.options.sandboxContainerManager
          : this.options.localContainerManager;
      if (!manager || !run.containerId) {
        this.options.repository.closeSandboxRun(run.id, {
          outcome: 'leaked',
          cleanupState: 'retryable',
          failureCode: 'CLEANUP_MANAGER_UNAVAILABLE',
        });
        continue;
      }
      try {
        await manager.kill(run.containerId);
        if (run.backend === 'docker' && this.options.dockerNetworkManager) {
          await this.options.dockerNetworkManager.removeNetworkForPod(run.id);
        }
        this.options.repository.closeSandboxRun(run.id, {
          outcome: 'cancelled',
          cleanupState: 'clean',
          failureCode: 'REAPED_AFTER_RESTART',
        });
        reaped += 1;
      } catch {
        this.options.repository.closeSandboxRun(run.id, {
          outcome: 'leaked',
          cleanupState: 'retryable',
          failureCode: 'CLEANUP_FAILED',
        });
      }
    }
    return reaped;
  }

  private resolveManager(target: ExecutionTarget): ContainerManager {
    if (target === 'sandbox') {
      if (!this.options.sandboxContainerManager) {
        throw new SystemDecisionConfigurationError(
          'Hosted system sandbox execution is not configured',
          'SYSTEM_SANDBOX_BACKEND_MISSING',
        );
      }
      return this.options.sandboxContainerManager;
    }
    return this.options.localContainerManager;
  }

  private resolveImage(target: ExecutionTarget): string {
    if (target !== 'sandbox') return this.options.localImage ?? LOCAL_IMAGE_DEFAULT;
    const image = this.options.hostedImage;
    if (!image || !/^[a-z0-9.-]+\/.+(?::[^/]+|@sha256:[a-f0-9]{64})$/i.test(image)) {
      throw new SystemDecisionConfigurationError(
        'Hosted system decision image must be an ACR-qualified pinned tag or digest',
        'SYSTEM_DECISION_IMAGE_MISSING',
      );
    }
    if (image.endsWith(':latest')) {
      throw new SystemDecisionConfigurationError(
        'Hosted system decision image cannot use latest',
        'SYSTEM_DECISION_IMAGE_UNPINNED',
      );
    }
    return image;
  }

  private async writeRunFiles(
    manager: ContainerManager,
    containerId: string,
    prompt: string,
    invocation: ReturnType<typeof buildSystemRuntimeInvocation>,
    providerEnv: Awaited<ReturnType<typeof buildProviderAccountEnv>>,
  ): Promise<void> {
    for (const file of [
      ...invocation.controlFiles,
      { path: SYSTEM_CREDENTIAL_SHIM_PATH, content: SYSTEM_CREDENTIAL_SHIM },
      { path: invocation.promptPath, content: prompt },
      ...providerEnv.containerFiles,
      ...providerEnv.secretFiles,
    ]) {
      await manager.writeFile(containerId, file.path, file.content);
    }
    const secretPaths = new Set([
      ...providerEnv.secretFiles.map((file) => file.path),
      ...providerEnv.containerFiles
        .filter((file) => isCredentialFile(file.path))
        .map((file) => file.path),
    ]);
    await manager.execInContainer(containerId, ['chmod', '0500', SYSTEM_CREDENTIAL_SHIM_PATH], {
      user: 'root',
      timeout: 5_000,
    });
    for (const path of secretPaths) {
      await manager.execInContainer(containerId, ['chmod', '0400', path], {
        user: 'root',
        timeout: 5_000,
      });
    }
  }

  private async buildLocalNetworkConfig(
    runId: string,
    catalogHosts: string[],
    account: ReturnType<ProviderAccountStore['get']>,
  ): Promise<{ networkName: string; firewallScript: string }> {
    if (!this.options.dockerNetworkManager) {
      throw new Error('Local system decisions require Docker network isolation');
    }
    const allowedHosts = providerRequiredHosts(account, catalogHosts);
    const config = await this.options.dockerNetworkManager.buildNetworkConfig(
      {
        enabled: true,
        mode: 'restricted',
        allowedHosts,
        replaceDefaults: true,
        allowPackageManagers: false,
      },
      [],
      '127.0.0.1',
      [],
      runId,
      [],
      [],
      0,
    );
    if (!config) throw new Error('Docker network isolation did not produce a firewall');
    return config;
  }

  private providerFailure(
    runtime: PodsitterRuntime,
    diagnostic: string,
  ): Extract<SystemDecisionRunResult, { ok: false }> {
    const bounded = diagnostic.slice(0, MAX_DIAGNOSTIC_BYTES);
    const evidence = parseProviderEvidence(bounded);
    return {
      ok: false,
      kind: 'provider',
      failure: classifyProviderError(runtime, evidence),
      cleanup: 'clean',
    };
  }
}

function isCredentialFile(path: string): boolean {
  return (
    path.endsWith('/auth.json') ||
    path.endsWith('/.credentials.json') ||
    path.includes('/run/autopod/')
  );
}

function assertInput(input: SystemDecisionRunInput): void {
  if (input.contractVersion !== 1)
    throw new SystemDecisionConfigurationError(
      'Unsupported decision contract version',
      'DECISION_CONTRACT_UNSUPPORTED',
    );
  if (Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES)
    throw new SystemDecisionConfigurationError(
      'Decision prompt too large',
      'DECISION_PROMPT_TOO_LARGE',
    );
  if (
    !Number.isFinite(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new SystemDecisionConfigurationError(
      'System decision timeout must be between 1 ms and 60 minutes',
      'DECISION_TIMEOUT_INVALID',
    );
  }
}

function failureResult(
  kind: Extract<SystemDecisionRunResult, { ok: false }>['kind'],
  message: string,
  cleanup: 'clean' | 'leaked' = 'clean',
  code?: string,
): Extract<SystemDecisionRunResult, { ok: false }> {
  return {
    ok: false,
    kind,
    failure: {
      category: 'unknown',
      definitive: false,
      sanitizedMessage: sanitizeProviderMessage(message),
      retryAfter: null,
      ...(code ? { code } : {}),
    },
    cleanup,
  };
}

class SystemDecisionConfigurationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SystemDecisionConfigurationError';
  }
}

function configurationFailureCode(error: unknown): string | null {
  if (error instanceof SystemDecisionConfigurationError) return error.code;
  if (
    error instanceof AutopodError &&
    [
      'PROVIDER_ACCOUNT_NOT_FOUND',
      'PROVIDER_ACCOUNT_NOT_RUNNABLE',
      'PROVIDER_ACCOUNT_RUNTIME_MISMATCH',
      'PROVIDER_ACCOUNT_CREDENTIALS_MISSING',
    ].includes(error.code)
  ) {
    return error.code;
  }
  return null;
}

function configurationMessage(code: string): string {
  return `System decision configuration rejected (${code})`;
}

function parseProviderEvidence(value: string): {
  message: string;
  code?: unknown;
  status?: unknown;
  retryAfter?: unknown;
} {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      message: typeof parsed.message === 'string' ? parsed.message : value,
      code: parsed.code,
      status: parsed.status,
      retryAfter: parsed.retryAfter ?? parsed.retry_after ?? parsed.reset_at,
    };
  } catch {
    return { message: value };
  }
}

function parseTelemetry(stdout: string): {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
} {
  const match = stdout.match(/"input_tokens"\s*:\s*(\d+).*?"output_tokens"\s*:\s*(\d+)/s);
  return match ? { inputTokens: Number(match[1]), outputTokens: Number(match[2]) } : {};
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed?\s*out|timeout/i.test(error.message);
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('System decision run timed out');
  return remaining;
}

function providerRequiredHosts(
  account: ReturnType<ProviderAccountStore['get']>,
  catalogHosts: string[],
): string[] {
  const legacyHosts: Record<string, string[]> = {
    anthropic: ['api.anthropic.com'],
    max: ['api.anthropic.com', 'platform.claude.com', 'claude.ai'],
    openai: ['api.openai.com', 'chatgpt.com', '*.chatgpt.com', 'files.openai.com'],
    copilot: [
      'api.githubcopilot.com',
      'api.enterprise.githubcopilot.com',
      'copilot-proxy.githubusercontent.com',
      'githubcopilot.com',
    ],
    openrouter: ['openrouter.ai'],
    pi: [],
  };
  const hosts = new Set([...catalogHosts, ...(legacyHosts[account.provider] ?? [])]);
  const credentials = account.credentials;
  if (credentials?.provider === 'pi') {
    const piHosts: Record<string, string[]> = {
      anthropic: ['api.anthropic.com'],
      'openai-codex': ['api.openai.com', 'chatgpt.com', '*.chatgpt.com', 'files.openai.com'],
      'github-copilot': [
        'api.githubcopilot.com',
        'api.enterprise.githubcopilot.com',
        'copilot-proxy.githubusercontent.com',
        'githubcopilot.com',
      ],
    };
    for (const host of piHosts[credentials.providerId] ?? []) hosts.add(host);
  }
  if (credentials?.provider === 'foundry') {
    try {
      hosts.add(new URL(credentials.endpoint).hostname);
    } catch {
      throw new Error('Foundry provider account has an invalid endpoint');
    }
  }
  return [...hosts];
}
