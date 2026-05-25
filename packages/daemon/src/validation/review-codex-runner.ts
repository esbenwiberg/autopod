import type { ContainerManager } from '../interfaces/container-manager.js';

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
  timeout: number;
}

const SHIM_PATH = '/run/autopod/agent-shim.sh';

/**
 * Runs the Codex CLI inside the pod container, so review auth follows the same
 * profile-provisioned credentials as the agent runtime (ChatGPT auth.json,
 * OPENAI_API_KEY_FILE, Foundry OpenAI env, etc.).
 */
export async function runCodexReview(config: CodexReviewConfig): Promise<{ stdout: string }> {
  const suffix = `${safePathPart(config.podId)}-${config.attempt ?? 0}-${Date.now()}`;
  const promptPath = `/tmp/autopod-codex-review-${suffix}.prompt`;
  const outputPath = `/tmp/autopod-codex-review-${suffix}.out`;
  const logPath = `/tmp/autopod-codex-review-${suffix}.log`;

  await config.containerManager.writeFile(config.containerId, promptPath, config.prompt);

  const modelArgs =
    config.model && config.model !== 'auto' ? ` --model ${shellQuote(config.model)}` : '';
  const codexCommand = [
    `${shellQuote(SHIM_PATH)} codex exec`,
    '--cd /workspace',
    '--sandbox read-only',
    '--skip-git-repo-check',
    '--output-last-message',
    shellQuote(outputPath),
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

  try {
    const result = await config.containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', command],
      {
        cwd: '/workspace',
        timeout: config.timeout,
      },
    );

    if (result.exitCode !== 0) {
      throw new CodexReviewError({
        kind: 'non-zero-exit',
        message: `codex review failed (exit=${result.exitCode}): ${result.stdout || result.stderr}`,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    }

    return { stdout: result.stdout };
  } catch (err) {
    if (err instanceof CodexReviewError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const kind = /timed? out|timeout/i.test(message) ? 'timeout' : 'exec-error';
    throw new CodexReviewError({
      kind,
      message: `codex review ${kind === 'timeout' ? 'timed out' : 'failed'}: ${message}`,
      cause: err,
    });
  }
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'pod';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
