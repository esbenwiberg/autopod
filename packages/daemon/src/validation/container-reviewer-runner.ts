import type { Readable } from 'node:stream';
import type { ModelProvider, Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { parseClaudeCliStdout } from '../runtimes/run-claude-cli.js';
import { type CodexReviewTokenUsage, runCodexReview } from './review-codex-runner.js';

export class ContainerReviewerUnavailableError extends Error {
  readonly kind: 'timeout' | 'non-zero-exit' | 'exec-error';
  readonly stderr: string;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      kind?: 'timeout' | 'non-zero-exit' | 'exec-error';
      stderr?: string;
    },
  ) {
    super(message, options);
    this.name = 'ContainerReviewerUnavailableError';
    this.kind = options?.kind ?? 'exec-error';
    this.stderr = options?.stderr ?? '';
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
const MAX_DIAGNOSTIC_BYTES = 4_000;

export async function runContainerReviewer(
  config: ContainerReviewerRunnerConfig,
): Promise<{ stdout: string; tokenUsage?: CodexReviewTokenUsage }> {
  if (!config.containerId) {
    throw new ContainerReviewerUnavailableError(
      'Container reviewer unavailable: pod has no live container',
    );
  }
  const containerId = config.containerId;

  const containerStatus = await config.containerManager.getStatus(containerId);
  if (containerStatus === 'stopped') {
    throw new ContainerReviewerUnavailableError(
      'Container reviewer unavailable: container is stopped (not running)',
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
    return runClaudeContainerReview({ ...config, containerId });
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
    `sh ${shellQuote(SHIM_PATH)} claude -p`,
    modelArgs.trim(),
    '--output-format json',
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
    if (
      config.containerManager.supportsStreamingExec === false ||
      typeof config.containerManager.execStreaming !== 'function'
    ) {
      throw new ContainerReviewerUnavailableError(
        'Container reviewer unavailable: Claude review requires cancellable streaming execution',
      );
    }
    const handle = await config.containerManager.execStreaming(
      config.containerId,
      ['sh', '-c', command],
      {
        cwd: '/workspace',
        ...(config.env ? { env: config.env } : {}),
        timeout: config.timeout,
      },
    );
    const result = await collectCancellableReview(handle, config.timeout);

    if (result.exitCode !== 0) {
      throw new ContainerReviewerUnavailableError(
        `Container reviewer unavailable: claude CLI failed in pod container (exit=${result.exitCode}): ${result.stdout || result.stderr}`,
        {
          kind: 'non-zero-exit',
          stderr: result.stderr,
        },
      );
    }

    return parseClaudeCliStdout(result.stdout, 'json');
  } catch (err) {
    if (err instanceof ContainerReviewerUnavailableError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ContainerReviewerUnavailableError(
      `Container reviewer unavailable: claude CLI failed in pod container: ${message}`,
      { cause: err },
    );
  }
}

async function collectCancellableReview(
  handle: Awaited<ReturnType<ContainerManager['execStreaming']>>,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout = collectBoundedStream(handle.stdout);
  const stderr = collectBoundedStream(handle.stderr);
  const completed = Promise.all([stdout.done, stderr.done, handle.exitCode]).then(
    ([, , exitCode]) => ({
      stdout: stdout.value(),
      stderr: stderr.value(),
      exitCode,
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        try {
          await handle.kill();
        } finally {
          const diagnostics = [stdout.value(), stderr.value()].filter(Boolean).join('\n');
          reject(
            new ContainerReviewerUnavailableError(
              `Container reviewer timed out after ${timeout}ms${diagnostics ? `: ${diagnostics}` : ''}`,
              {
                kind: 'timeout',
                stderr: stderr.value(),
              },
            ),
          );
        }
      })();
    }, timeout);
  });

  try {
    return await Promise.race([completed, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function collectBoundedStream(stream: Readable): { done: Promise<void>; value: () => string } {
  let output = '';
  const done = (async () => {
    for await (const chunk of stream) {
      output = appendBounded(
        output,
        Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
      );
    }
  })();
  return { done, value: () => output };
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_DIAGNOSTIC_BYTES
    ? combined
    : combined.slice(combined.length - MAX_DIAGNOSTIC_BYTES);
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
