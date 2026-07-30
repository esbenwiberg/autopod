import type {
  ExecutionTarget,
  PodsitterDecision,
  PodsitterRuntime,
  ProviderFailureClassification,
  ReasoningEffort,
} from '@autopod/shared';
import { PROVIDER_CATALOG } from '@autopod/shared';
import type { Logger } from 'pino';
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
import { buildSystemRuntimeInvocation } from './runtime-adapters.js';

const MAX_PROMPT_BYTES = 256_000;
const MAX_DIAGNOSTIC_BYTES = 4_000;
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
      failure: ProviderFailureClassification;
      cleanup: 'clean' | 'leaked';
    };

export interface SystemDecisionRunnerOptions {
  localContainerManager: ContainerManager;
  sandboxContainerManager?: ContainerManager;
  providerAccountStore: ProviderAccountStore;
  repository: PodsitterRepository;
  logger: Logger;
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
      if (!catalogProvider)
        throw new Error('Dedicated provider is absent from the provider catalog');
      providerEnv = await buildProviderAccountEnv(input.providerAccountId, this.options.logger, {
        providerAccountStore: this.options.providerAccountStore,
        runtime: input.runtime,
      });
      const invocation = buildSystemRuntimeInvocation(input);
      containerId = await manager.spawn({
        image,
        podId: runId,
        env: {},
        volumes: [],
        ports: [],
        networkPolicyMode: 'restricted',
        allowedHosts: providerRequiredHosts(account, catalogProvider.requiredHosts),
      });
      this.options.repository.setSandboxContainer(runId, containerId);
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
      const timedOut = isTimeout(error);
      const message = error instanceof Error ? error.message : 'System decision run failed';
      result = failureResult(timedOut ? 'timeout' : 'infrastructure', message);
      failureCode = timedOut ? 'TIMEOUT' : 'SYSTEM_SANDBOX_FAILED';
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
              openAi: providerEnv.requiresOpenAiAuthJsonPersistence,
              pi: providerEnv.requiresPiAuthJsonPersistence,
            },
          ).catch((error) => {
            this.options.logger.warn(
              { runId, err: sanitizeProviderMessage(String(error)) },
              'System sandbox credential readback failed',
            );
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
        cleanupState: cleanup,
        failureCode,
      });
    }
    return result;
  }

  async reapLeakedRuns(): Promise<number> {
    let reaped = 0;
    for (const run of this.options.repository.listActiveSandboxRuns()) {
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
        throw new Error('Hosted system sandbox execution is not configured');
      }
      return this.options.sandboxContainerManager;
    }
    return this.options.localContainerManager;
  }

  private resolveImage(target: ExecutionTarget): string {
    if (target !== 'sandbox') return this.options.localImage ?? LOCAL_IMAGE_DEFAULT;
    const image = this.options.hostedImage;
    if (!image || !/^[a-z0-9.-]+\/.+(?::[^/]+|@sha256:[a-f0-9]{64})$/i.test(image)) {
      throw new Error('Hosted system decision image must be an ACR-qualified pinned tag or digest');
    }
    if (image.endsWith(':latest'))
      throw new Error('Hosted system decision image cannot use latest');
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
    for (const path of secretPaths) {
      await manager.execInContainer(containerId, ['chmod', '0400', path], {
        user: 'root',
        timeout: 5_000,
      });
    }
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
  if (input.contractVersion !== 1) throw new Error('Unsupported decision contract version');
  if (Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES)
    throw new Error('Decision prompt too large');
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('System decision timeout must be positive');
  }
}

function failureResult(
  kind: Extract<SystemDecisionRunResult, { ok: false }>['kind'],
  message: string,
  cleanup: 'clean' | 'leaked' = 'clean',
): Extract<SystemDecisionRunResult, { ok: false }> {
  return {
    ok: false,
    kind,
    failure: {
      category: 'unknown',
      definitive: false,
      sanitizedMessage: sanitizeProviderMessage(message),
      retryAfter: null,
    },
    cleanup,
  };
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
    max: ['api.anthropic.com', 'claude.ai'],
    openai: ['api.openai.com', 'chatgpt.com'],
    copilot: ['api.githubcopilot.com', 'github.com'],
    openrouter: ['openrouter.ai'],
    pi: ['api.anthropic.com', 'api.openai.com'],
  };
  const hosts = new Set([...catalogHosts, ...(legacyHosts[account.provider] ?? [])]);
  const credentials = account.credentials;
  if (credentials?.provider === 'foundry') {
    try {
      hosts.add(new URL(credentials.endpoint).hostname);
    } catch {
      throw new Error('Foundry provider account has an invalid endpoint');
    }
  }
  return [...hosts];
}
