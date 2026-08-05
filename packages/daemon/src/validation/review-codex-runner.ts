import { randomUUID } from 'node:crypto';
import { computeCostWithCache } from '@autopod/shared';
import type {
  ContainerManager,
  ExecOptions,
  ExecResult,
  StreamingExecResult,
} from '../interfaces/container-manager.js';
import type { ReviewerOutputContract } from './review-structured-output.js';

export type CodexReviewErrorKind = 'non-zero-exit' | 'timeout' | 'exec-error';

export class CodexReviewError extends Error {
  readonly kind: CodexReviewErrorKind;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(fields: {
    kind: CodexReviewErrorKind;
    message: string;
    exitCode?: number | null;
    stderr?: string;
    cause?: unknown;
  }) {
    super(fields.message, { cause: fields.cause });
    this.name = 'CodexReviewError';
    this.kind = fields.kind;
    this.exitCode = fields.exitCode ?? null;
    this.stderr = fields.stderr ?? '';
  }
}

export interface CodexReviewConfig {
  podId: string;
  attempt?: number;
  containerId: string;
  containerManager: ContainerManager;
  model: string;
  prompt: string;
  env?: Record<string, string>;
  timeout: number;
  outputContract?: ReviewerOutputContract;
}

export interface CodexReviewTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

const SHIM_PATH = '/run/autopod/agent-shim.sh';

/**
 * Runs the Codex CLI inside the pod container, so review auth follows the same
 * profile-provisioned credentials as the agent runtime (ChatGPT auth.json,
 * OPENAI_API_KEY_FILE, Foundry OpenAI env, etc.).
 */
export async function runCodexReview(
  config: CodexReviewConfig,
): Promise<{ stdout: string; tokenUsage?: CodexReviewTokenUsage }> {
  const suffix = `${safePathPart(config.podId)}-${config.attempt ?? 0}-${Date.now()}-${randomUUID()}`;
  const promptPath = `/tmp/autopod-codex-review-${suffix}.prompt`;
  const outputPath = `/tmp/autopod-codex-review-${suffix}.out`;
  const logPath = `/tmp/autopod-codex-review-${suffix}.log`;
  const schemaPath = `/tmp/autopod-codex-review-${suffix}.schema.json`;

  try {
    await config.containerManager.writeFile(config.containerId, promptPath, config.prompt);
    if (config.outputContract)
      await config.containerManager.writeFile(
        config.containerId,
        schemaPath,
        config.outputContract.jsonSchema,
      );

    const modelArgs =
      config.model && config.model !== 'auto' ? ` --model ${shellQuote(config.model)}` : '';
    const codexCommand = [
      `sh ${shellQuote(SHIM_PATH)} codex exec`,
      '--cd /workspace',
      '--sandbox read-only',
      '--skip-git-repo-check',
      '--json',
      '--output-last-message',
      shellQuote(outputPath),
      ...(config.outputContract ? [`--output-schema ${shellQuote(schemaPath)}`] : []),
      modelArgs.trim(),
      '-',
      `< ${shellQuote(promptPath)}`,
      `> ${shellQuote(logPath)} 2>&1`,
    ]
      .filter(Boolean)
      .join(' ');
    const command = [
      `rm -f ${shellQuote(outputPath)} ${shellQuote(logPath)}`,
      codexCommand,
      'status=$?',
      'if [ "$status" -ne 0 ]; then',
      '  echo "codex review failed (exit $status)"',
      `  tail -c 4000 ${shellQuote(logPath)} 2>/dev/null || true`,
      '  exit "$status"',
      'fi',
      `cat ${shellQuote(outputPath)}`,
    ].join('\n');

    const options: ExecOptions = {
      cwd: '/workspace',
      ...(config.env ? { env: config.env } : {}),
      timeout: config.timeout,
    };
    const result = await execReviewCommand(
      config.containerManager,
      config.containerId,
      ['sh', '-c', command],
      options,
    );

    if (result.exitCode !== 0) {
      const output = result.stdout || result.stderr;
      const timedOut = /timed? out|timeout/i.test(output);
      throw new CodexReviewError({
        kind: timedOut ? 'timeout' : 'non-zero-exit',
        message: timedOut
          ? `codex review timed out: ${output}`
          : `codex review failed (exit=${result.exitCode}): ${output}`,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }

    const tokenUsage = await readCodexReviewTokenUsage(
      config.containerManager,
      config.containerId,
      logPath,
    );

    const costUsd = tokenUsage
      ? computeCostWithCache(
          config.model,
          tokenUsage.inputTokens,
          tokenUsage.outputTokens,
          tokenUsage.cachedInputTokens ?? 0,
        )
      : 0;

    return {
      stdout: result.stdout,
      ...(tokenUsage && {
        tokenUsage: {
          ...tokenUsage,
          ...(costUsd > 0 && { costUsd }),
        },
      }),
    };
  } catch (err) {
    if (err instanceof CodexReviewError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const kind = /timed? out|timeout/i.test(message) ? 'timeout' : 'exec-error';
    throw new CodexReviewError({
      kind,
      message: `codex review ${kind === 'timeout' ? 'timed out' : 'failed'}: ${message}`,
      cause: err,
    });
  } finally {
    try {
      await config.containerManager.execInContainer(
        config.containerId,
        ['rm', '-f', promptPath, outputPath, logPath, schemaPath],
        { timeout: 5_000 },
      );
    } catch {
      // Best-effort cleanup after review completion or cancellation.
    }
  }
}

async function execReviewCommand(
  containerManager: ContainerManager,
  containerId: string,
  command: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  if (
    containerManager.supportsStreamingExec === false ||
    typeof containerManager.execStreaming !== 'function'
  ) {
    return containerManager.execInContainer(containerId, command, options);
  }

  let handle: StreamingExecResult;
  try {
    handle = await containerManager.execStreaming(containerId, command, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/streaming exec is not supported/i.test(message)) {
      return containerManager.execInContainer(containerId, command, options);
    }
    throw err;
  }

  return collectStreamingExec(handle, options.timeout);
}

async function collectStreamingExec(
  handle: StreamingExecResult,
  timeout: number | undefined,
): Promise<ExecResult> {
  const completed = Promise.all([
    readStream(handle.stdout),
    readStream(handle.stderr),
    handle.exitCode,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));

  if (!timeout) return completed;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeout);
  });

  try {
    const outcome = await Promise.race([completed, timedOut]);
    if (outcome === 'timeout') {
      // Do not start a retry until the remote exec has received termination.
      await handle.kill();
      throw new Error(`container review timed out after ${timeout}ms`);
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readStream(stream: StreamingExecResult['stdout']): Promise<string> {
  let output = '';
  for await (const chunk of stream) {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
  }
  return output;
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'pod';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function readCodexReviewTokenUsage(
  containerManager: ContainerManager,
  containerId: string,
  logPath: string,
): Promise<CodexReviewTokenUsage | undefined> {
  try {
    return parseCodexReviewTokenUsage(await containerManager.readFile(containerId, logPath));
  } catch {
    return undefined;
  }
}

function parseCodexReviewTokenUsage(log: string): CodexReviewTokenUsage | undefined {
  let latestUsage: Record<string, unknown> | null = null;

  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let envelope: unknown;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const message = unwrapCodexReviewEvent(envelope);
    if (!message) continue;

    let usage: Record<string, unknown> | null = null;
    if (message.type === 'token_count') {
      const info = asRecord(message.info);
      usage = asRecord(info?.total_token_usage) ?? asRecord(info?.last_token_usage);
    } else if (message.type === 'turn.completed') {
      usage = asRecord(message.usage);
    }
    if (usage) latestUsage = usage;
  }

  if (!latestUsage) return undefined;

  const inputTokens = numberField(latestUsage.input_tokens) ?? 0;
  const outputTokens = numberField(latestUsage.output_tokens) ?? 0;
  const cachedInputTokens = numberField(latestUsage.cached_input_tokens);

  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined && { cachedInputTokens }),
  };
}

function unwrapCodexReviewEvent(envelope: unknown): Record<string, unknown> | null {
  const event = asRecord(envelope);
  if (!event) return null;

  const msg = asRecord(event.msg);
  if (msg && typeof msg.type === 'string') return msg;

  const payload = asRecord(event.payload);
  if (payload && typeof payload.type === 'string') return payload;

  if (typeof event.type === 'string') return event;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
