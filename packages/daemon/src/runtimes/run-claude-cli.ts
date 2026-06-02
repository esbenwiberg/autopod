import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

export type ClaudeCliErrorKind = 'non-zero-exit' | 'timeout' | 'spawn-error' | 'maxbuffer';

export interface ClaudeCliErrorFields {
  kind: ClaudeCliErrorKind;
  model: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdoutPreview: string;
  durationMs: number;
  /** Configured timeout in ms (only set for kind='timeout'). */
  timeoutMs?: number;
  cause?: unknown;
}

export class ClaudeCliError extends Error {
  readonly kind: ClaudeCliErrorKind;
  readonly model: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdoutPreview: string;
  readonly durationMs: number;

  constructor(fields: ClaudeCliErrorFields) {
    super(buildMessage(fields), { cause: fields.cause });
    this.name = 'ClaudeCliError';
    this.kind = fields.kind;
    this.model = fields.model;
    this.exitCode = fields.exitCode;
    this.signal = fields.signal;
    this.stderr = fields.stderr;
    this.stdoutPreview = fields.stdoutPreview;
    this.durationMs = fields.durationMs;
  }
}

function buildMessage(fields: ClaudeCliErrorFields): string {
  const cmd = `claude -p --model ${fields.model}`;
  const stderrPreview = fields.stderr.trim().slice(0, 500);

  switch (fields.kind) {
    case 'timeout':
      return `${cmd} timed out after ${fields.timeoutMs ?? fields.durationMs}ms`;
    case 'maxbuffer':
      return `${cmd} stdout exceeded maxBuffer — output truncated after ${fields.durationMs}ms`;
    case 'spawn-error': {
      const causeMsg = fields.cause instanceof Error ? fields.cause.message : String(fields.cause);
      return `${cmd} failed to spawn: ${causeMsg}`;
    }
    case 'non-zero-exit': {
      if (fields.signal) {
        const tail = stderrPreview ? `: ${stderrPreview}` : ' — no stderr captured';
        return `${cmd} killed by signal ${fields.signal} after ${fields.durationMs}ms${tail}`;
      }
      if (stderrPreview) {
        return `${cmd} failed (exit=${fields.exitCode}): ${stderrPreview}`;
      }
      return `${cmd} failed (exit=${fields.exitCode}, signal=null) — no stderr captured (likely killed externally: OOM, container limit, or silent auth/credits failure)`;
    }
  }
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

export interface ClaudeCliTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

/**
 * Runs the Claude CLI in print mode, piping `input` via stdin.
 *
 * Uses `spawn` instead of `execFile` so that stdin data is written immediately
 * after the process is created. This avoids the Claude CLI's 3-second stdin
 * timeout that `execFile` can miss when its internal setup delays the write.
 *
 * Also: passing huge prompts (e.g. multi-thousand-line diffs) via argv runs
 * into ARG_MAX. Stdin sidesteps that.
 *
 * On failure, rejects with a `ClaudeCliError` carrying structured diagnostic
 * fields (exit code, signal, stderr, duration) so callers and the UI can
 * tell what actually went wrong rather than guessing from substring matches.
 */
export function runClaudeCli(opts: {
  model: string;
  input: string;
  timeout: number;
  maxBuffer?: number;
  /** Test seam — defaults to node's `child_process.spawn`. */
  spawnImpl?: SpawnImpl;
  /** Test seam — defaults to `'claude'`. */
  command?: string;
  /** Output format for the default args. JSON lets callers capture cost/token telemetry. */
  outputFormat?: 'text' | 'json';
  /** Test seam — defaults to `['-p', '--model', model, '--output-format', outputFormat]`. */
  args?: readonly string[];
}): Promise<{ stdout: string; tokenUsage?: ClaudeCliTokenUsage }> {
  const maxBuf = opts.maxBuffer ?? 2 * 1024 * 1024;
  const spawnFn = opts.spawnImpl ?? spawn;
  const command = opts.command ?? 'claude';
  const outputFormat = opts.outputFormat ?? 'text';
  const args = opts.args ?? ['-p', '--model', opts.model, '--output-format', outputFormat];
  const startTs = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const child = spawnFn(command, args);

    if (child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
      child.stdin.on('error', () => {});
    }

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;
    let maxBufferExceeded = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() =>
        reject(
          new ClaudeCliError({
            kind: 'timeout',
            model: opts.model,
            exitCode: null,
            signal: 'SIGTERM',
            stderr,
            stdoutPreview: stdout.slice(0, 500),
            durationMs: Date.now() - startTs,
            timeoutMs: opts.timeout,
          }),
        ),
      );
    }, opts.timeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuf) {
        maxBufferExceeded = true;
        child.kill('SIGTERM');
        settle(() =>
          reject(
            new ClaudeCliError({
              kind: 'maxbuffer',
              model: opts.model,
              exitCode: null,
              signal: 'SIGTERM',
              stderr,
              stdoutPreview: stdout.slice(0, 500),
              durationMs: Date.now() - startTs,
            }),
          ),
        );
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (maxBufferExceeded) return;
      if (code === 0) {
        settle(() => resolve(parseClaudeCliStdout(stdout, outputFormat)));
        return;
      }
      settle(() =>
        reject(
          new ClaudeCliError({
            kind: 'non-zero-exit',
            model: opts.model,
            exitCode: code,
            signal,
            stderr,
            stdoutPreview: stdout.slice(0, 500),
            durationMs: Date.now() - startTs,
          }),
        ),
      );
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() =>
        reject(
          new ClaudeCliError({
            kind: 'spawn-error',
            model: opts.model,
            exitCode: null,
            signal: null,
            stderr,
            stdoutPreview: stdout.slice(0, 500),
            durationMs: Date.now() - startTs,
            cause: err,
          }),
        ),
      );
    });
  });
}

function parseClaudeCliStdout(
  stdout: string,
  outputFormat: 'text' | 'json',
): { stdout: string; tokenUsage?: ClaudeCliTokenUsage } {
  if (outputFormat !== 'json') return { stdout };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { stdout };
  }

  const record = asRecord(parsed);
  if (!record) return { stdout };

  const result = typeof record.result === 'string' ? record.result : stdout;
  const usage = asRecord(record.usage);
  const inputTokens = numberField(usage?.input_tokens) ?? numberField(record.input_tokens);
  const outputTokens = numberField(usage?.output_tokens) ?? numberField(record.output_tokens);
  const cacheReadTokens =
    numberField(usage?.cache_read_input_tokens) ?? numberField(record.cache_read_input_tokens);
  const costUsd = numberField(record.total_cost_usd);

  const tokenUsage =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cacheReadTokens !== undefined ||
    costUsd !== undefined
      ? {
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          ...(cacheReadTokens !== undefined && { cachedInputTokens: cacheReadTokens }),
          ...(costUsd !== undefined && { costUsd }),
        }
      : undefined;

  return { stdout: result, ...(tokenUsage && { tokenUsage }) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
