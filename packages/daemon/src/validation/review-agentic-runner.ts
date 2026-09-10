import { runClaudeCli } from '../runtimes/run-claude-cli.js';

export interface AgenticReviewConfig {
  model: string;
  prompt: string;
  worktreePath: string;
  timeout: number;
  beforeSpawn?: () => void;
  recordHostDispatch?: (
    evidence: import('../runtimes/host-cli-provenance.js').HostCliDispatchEvidence,
  ) => void;
}

export interface AgenticReviewTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUsd?: number;
}

/**
 * Tier 3: Runs a review using the `claude` CLI in agentic mode with
 * read-only tool access scoped to the worktree directory.
 *
 * The reviewer gets access to Bash (read-only git commands), Read, and Grep
 * tools, but cannot edit files or run arbitrary commands.
 */
export async function runAgenticReview(
  config: AgenticReviewConfig,
): Promise<{ stdout: string; tokenUsage?: AgenticReviewTokenUsage }> {
  const result = await runClaudeCli({
    model: config.model,
    beforeSpawn: config.beforeSpawn,
    recordHostDispatch: config.recordHostDispatch,
    input: config.prompt,
    timeout: config.timeout,
    outputFormat: 'text',
    args: [
      '-p',
      '--model',
      config.model,
      '--output-format',
      'json',
      '--allowedTools',
      'Read',
      'Bash(git log:*)',
      'Bash(git status:*)',
      'Bash(git show:*)',
      'Bash(git ls-files:*)',
      'Bash(git check-ignore:*)',
      'Bash(git diff:*)',
      '--add-dir',
      config.worktreePath,
      '--system-prompt',
      'You are an expert code reviewer with read-only access to the repository for VERIFYING claims in the diff. ' +
        'Use the tools to confirm or refute specific things the diff is doing — not to discover unrelated issues. ' +
        'HARD RULE — every issue you raise MUST cite a file path that appears as a header in the DIFF section ' +
        '(`+++ b/<path>` or `--- a/<path>`). If a file is not in the DIFF, Read it ONLY for context — never to flag ' +
        'a new issue in it. Findings citing only paths outside the diff are automatically discarded by the harness. ' +
        'CRITICAL: Untracked files (lines starting with `??` in git status) are NOT part of this PR — ' +
        'they are leftover worktree state from build artifacts, tooling, or prior pod runs. ' +
        "Do not flag, cite, or read untracked files unless investigating a `.gitignore` violation explicitly listed under the prompt's Warnings section. " +
        'When done investigating, output ONLY a JSON object with your review verdict. ' +
        'Do not wrap the JSON in markdown fences. ' +
        'The JSON must have: "status" ("pass"|"fail"|"uncertain"), "reasoning" (string), "issues" (string[]).',
    ],
    spawnOptions: {
      cwd: config.worktreePath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    },
  });
  return parseAgenticReviewOutput(result.stdout);
}

export function parseAgenticReviewOutput(stdout: string): {
  stdout: string;
  tokenUsage?: AgenticReviewTokenUsage;
} {
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
  const directInputTokens = numberField(usage?.input_tokens) ?? numberField(record.input_tokens);
  const outputTokens = numberField(usage?.output_tokens) ?? numberField(record.output_tokens);
  const cachedInputTokens =
    numberField(usage?.cache_read_input_tokens) ?? numberField(record.cache_read_input_tokens);
  const cacheCreationInputTokens =
    numberField(usage?.cache_creation_input_tokens) ??
    numberField(record.cache_creation_input_tokens);
  const hasInputTelemetry =
    directInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationInputTokens !== undefined;
  const inputTokens = hasInputTelemetry
    ? (directInputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0)
    : undefined;
  const costUsd = numberField(record.total_cost_usd);
  const tokenUsage =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationInputTokens !== undefined ||
    costUsd !== undefined
      ? {
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          ...(cachedInputTokens !== undefined && { cachedInputTokens }),
          ...(cacheCreationInputTokens !== undefined && { cacheCreationInputTokens }),
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
