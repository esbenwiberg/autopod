import type { ModelProvider, Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { runCodexReview } from './review-codex-runner.js';

export class ContainerReviewerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContainerReviewerUnavailableError';
  }
}

export interface ContainerReviewerRunnerConfig {
  podId: string;
  containerId: string | null | undefined;
  containerManager: ContainerManager;
  profile: Pick<Profile, 'modelProvider' | 'providerCredentials'>;
  model: string;
  prompt: string;
  env?: Record<string, string>;
  timeout: number;
  logger?: Logger;
}

const SHIM_PATH = '/run/autopod/agent-shim.sh';

export async function runContainerReviewer(
  config: ContainerReviewerRunnerConfig,
): Promise<{ stdout: string }> {
  if (!config.containerId) {
    throw new ContainerReviewerUnavailableError(
      'Container reviewer unavailable: pod has no live container',
    );
  }

  const containerStatus = await config.containerManager.getStatus(config.containerId);
  if (containerStatus !== 'running') {
    throw new ContainerReviewerUnavailableError(
      `Container reviewer unavailable: container is ${containerStatus} (not running)`,
    );
  }

  const runner = resolveContainerReviewer(config.profile);
  config.logger?.info(
    { podId: config.podId, model: config.model, runner },
    'running container reviewer',
  );

  if (runner === 'codex') {
    return runCodexReview({
      podId: config.podId,
      containerId: config.containerId,
      containerManager: config.containerManager,
      model: config.model,
      prompt: config.prompt,
      env: config.env,
      timeout: config.timeout,
    });
  }

  if (runner === 'claude') {
    return runClaudeContainerReview(config);
  }

  throw new ContainerReviewerUnavailableError(
    `Container reviewer unavailable: provider ${runner.provider} is not supported by the live container reviewer path`,
  );
}

export function resolveContainerReviewer(
  profile: Pick<Profile, 'modelProvider' | 'providerCredentials'>,
): 'claude' | 'codex' | { provider: ModelProvider } {
  if (usesOpenAiSurface(profile)) return 'codex';
  if (
    profile.modelProvider === null ||
    profile.modelProvider === 'anthropic' ||
    profile.modelProvider === 'max' ||
    profile.modelProvider === 'foundry'
  ) {
    return 'claude';
  }
  return { provider: profile.modelProvider };
}

async function runClaudeContainerReview(
  config: ContainerReviewerRunnerConfig & { containerId: string },
): Promise<{ stdout: string }> {
  const suffix = `${safePathPart(config.podId)}-${Date.now()}`;
  const promptPath = `/tmp/autopod-claude-review-${suffix}.prompt`;
  const outputPath = `/tmp/autopod-claude-review-${suffix}.out`;
  const logPath = `/tmp/autopod-claude-review-${suffix}.log`;

  await config.containerManager.writeFile(config.containerId, promptPath, config.prompt);

  const modelArgs =
    config.model && config.model !== 'auto' ? ` --model ${shellQuote(config.model)}` : '';
  const claudeCommand = [
    `${shellQuote(SHIM_PATH)} claude -p`,
    modelArgs.trim(),
    '--output-format text',
    `< ${shellQuote(promptPath)}`,
    `> ${shellQuote(outputPath)} 2> ${shellQuote(logPath)}`,
  ]
    .filter(Boolean)
    .join(' ');
  const command = [
    `rm -f ${shellQuote(outputPath)} ${shellQuote(logPath)}`,
    claudeCommand,
    'status=$?',
    'if [ "$status" -ne 0 ]; then',
    '  echo "claude review failed (exit $status)"',
    `  tail -c 4000 ${shellQuote(logPath)} 2>/dev/null || true`,
    '  exit "$status"',
    'fi',
    `cat ${shellQuote(outputPath)}`,
  ].join('\n');

  try {
    const result = await config.containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', command],
      {
        cwd: '/workspace',
        ...(config.env ? { env: config.env } : {}),
        timeout: config.timeout,
      },
    );

    if (result.exitCode !== 0) {
      throw new ContainerReviewerUnavailableError(
        `Container reviewer unavailable: claude CLI failed in pod container (exit=${result.exitCode}): ${result.stdout || result.stderr}`,
      );
    }

    return { stdout: result.stdout };
  } catch (err) {
    if (err instanceof ContainerReviewerUnavailableError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ContainerReviewerUnavailableError(
      `Container reviewer unavailable: claude CLI failed in pod container: ${message}`,
      { cause: err },
    );
  }
}

function usesOpenAiSurface(
  profile: Pick<Profile, 'modelProvider' | 'providerCredentials'>,
): boolean {
  if (profile.modelProvider === 'openai') return true;
  if (profile.modelProvider !== 'foundry') return false;

  const creds = profile.providerCredentials;
  return creds?.provider === 'foundry' && (creds.apiSurface ?? 'anthropic') === 'openai';
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'pod';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
