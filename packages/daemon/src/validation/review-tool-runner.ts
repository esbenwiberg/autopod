import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  Message,
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages.js';

const execFileAsync = promisify(execFile);

const GIT_ENV: Record<string, string> = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
};

const TOOL_TIMEOUT = 5_000;
const DEFAULT_MAX_TOOL_CALLS = 10;
const MAX_FILE_READ_BYTES = 20_000;
const MAX_SEARCH_RESULTS = 50;

/** Safe git log flags — reject anything that could be destructive or interactive */
const ALLOWED_GIT_LOG_FLAGS = new Set([
  '--oneline',
  '--graph',
  '--stat',
  '--name-status',
  '--name-only',
  '--format',
  '--pretty',
  '--reverse',
  '--first-parent',
  '--no-merges',
  '--merges',
]);

export interface ToolUseReviewConfig {
  model: string;
  prompt: string;
  worktreePath: string;
  timeout: number;
  maxToolCalls?: number;
  /** Trusted ownership fence before provider dispatch and each local tool operation. */
  beforeRequest?: () => void;
  onDispatch?: (model: string) => void;
  /** Anthropic API key. If not provided, uses ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Already resolved provider endpoint/auth and exact dispatch model. Never falls back to daemon auth. */
  providerClient?: { client: Pick<Anthropic, 'messages'>; model: string };
}

export type ToolReviewFailureKind =
  | 'invalid-budget'
  | 'budget-exhausted'
  | 'timeout'
  | 'provider-error'
  | 'ownership-lost';

/** Known usage is a measured subtotal; an interrupted request's usage is unknown. */
export class ToolReviewError extends Error {
  constructor(
    readonly kind: ToolReviewFailureKind,
    message: string,
    readonly tokenUsage?: { inputTokens: number; outputTokens: number },
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ToolReviewError';
  }
}

/** Run at most the configured tool operations and one final request without tools. */
export async function runToolUseReview(
  config: ToolUseReviewConfig,
): Promise<{ stdout: string; tokenUsage?: { inputTokens: number; outputTokens: number } }> {
  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  if (
    !Number.isSafeInteger(maxToolCalls) ||
    maxToolCalls < 0 ||
    !Number.isFinite(config.timeout) ||
    config.timeout <= 0
  )
    throw new ToolReviewError('invalid-budget', 'Invalid review tool budget or timeout');
  const deadline = performance.now() + config.timeout;
  const client = config.providerClient?.client ?? new Anthropic({ apiKey: config.apiKey });
  const model = config.providerClient?.model ?? resolveToolReviewModelId(config.model);
  const tools = getToolDefinitions();
  const messages: MessageParam[] = [{ role: 'user', content: config.prompt }];
  let toolCallCount = 0;
  let finalizing = maxToolCalls === 0;
  let measuredResponses = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const usage = () =>
    measuredResponses
      ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }
      : undefined;
  const assertOwnership = () => {
    try {
      config.beforeRequest?.();
    } catch (cause) {
      throw new ToolReviewError(
        'ownership-lost',
        cause instanceof Error ? cause.message : 'Review ownership lost',
        usage(),
        cause,
      );
    }
  };
  const checkActive = () => {
    assertOwnership();
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0)
      throw new ToolReviewError(
        'timeout',
        `Tier 2 review timed out after ${config.timeout}ms`,
        usage(),
      );
    return remainingMs;
  };
  while (true) {
    let remainingMs = checkActive();
    if (config.onDispatch) {
      try {
        config.onDispatch(model);
      } catch (cause) {
        throw new ToolReviewError(
          'ownership-lost',
          cause instanceof Error ? cause.message : 'Dispatch provenance unavailable',
          usage(),
          cause,
        );
      }
      remainingMs = checkActive();
    }
    let response: Message;
    try {
      response = await client.messages.create(
        {
          model,
          max_tokens: 8192,
          messages,
          ...(finalizing ? {} : { tools }),
          system: [
            'You are an expert code reviewer with access to tools for investigating the repository.',
            'Use the tools to verify claims in the diff when the diff alone is insufficient.',
            'When done investigating, respond with ONLY a JSON object (the review verdict).',
            'Do not wrap the JSON in markdown fences.',
            ...(finalizing
              ? [
                  'The tool budget is exhausted. Provide the final verdict from the evidence already collected; no more tool calls are available.',
                ]
              : []),
          ].join(' '),
        },
        { timeout: remainingMs, maxRetries: 0 },
      );
    } catch (cause) {
      throw new ToolReviewError(
        'provider-error',
        'Selected reviewer request failed; its provider outcome is unverified.',
        usage(),
        cause,
      );
    }
    measuredResponses++;
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    checkActive();
    const toolUseBlocks = response.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );
    if (toolUseBlocks.length === 0) {
      const textBlocks = response.content.filter(
        (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
      );
      return { stdout: textBlocks.map((block) => block.text).join('\n'), tokenUsage: usage() };
    }
    if (finalizing)
      throw new ToolReviewError(
        'budget-exhausted',
        'Reviewer requested tools after its tool budget was exhausted',
        usage(),
      );

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      checkActive();
      if (toolCallCount >= maxToolCalls) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: 'Tool budget exhausted. This tool was not executed.',
        });
        continue;
      }
      toolCallCount++;
      const result = await executeToolCall(
        toolUse.name,
        toolUse.input as Record<string, unknown>,
        config.worktreePath,
      );
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }
    finalizing = toolCallCount >= maxToolCalls;
    messages.push({ role: 'user', content: toolResults });
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'read_file',
      description:
        'Read a file from the repository. Path is relative to the repository root. Returns up to 20KB of content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to the repository root',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_directory',
      description:
        'List files and directories at a path. Path is relative to the repository root. Use empty string or "." for root.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Directory path relative to the repository root',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'git_status',
      description:
        'Run git status --porcelain. Note: untracked files (lines starting with `??`) are NOT part of the PR being reviewed — they are leftover worktree state from build artifacts, tooling, or prior pod runs. Only files appearing in the diff are part of the submission. Do not flag or cite untracked files.',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'git_log',
      description:
        'Run git log with specified arguments. Only read-only flags are allowed (--oneline, --stat, --name-status, etc.).',
      input_schema: {
        type: 'object' as const,
        properties: {
          args: {
            type: 'string',
            description:
              'Arguments for git log (e.g., "--oneline -10", "--name-status HEAD~3..HEAD")',
          },
        },
        required: ['args'],
      },
    },
    {
      name: 'search_files',
      description:
        'Search for a pattern in repository files using grep. Returns up to 50 matching lines.',
      input_schema: {
        type: 'object' as const,
        properties: {
          pattern: {
            type: 'string',
            description: 'Search pattern (grep basic regex)',
          },
          glob: {
            type: 'string',
            description: 'Optional file glob to filter (e.g., "*.ts", "src/**/*.json")',
          },
        },
        required: ['pattern'],
      },
    },
  ];
}

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  worktreePath: string,
): Promise<string> {
  try {
    switch (name) {
      case 'read_file':
        return await toolReadFile(worktreePath, input.path as string);
      case 'list_directory':
        return await toolListDirectory(worktreePath, input.path as string);
      case 'git_status':
        return await toolGitStatus(worktreePath);
      case 'git_log':
        return await toolGitLog(worktreePath, input.args as string);
      case 'search_files':
        return await toolSearchFiles(
          worktreePath,
          input.pattern as string,
          input.glob as string | undefined,
        );
      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

function resolveSafePath(worktreePath: string, relPath: string): string {
  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, relPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path traversal detected — access denied');
  }
  return resolved;
}

async function toolReadFile(worktreePath: string, relPath: string): Promise<string> {
  const absPath = resolveSafePath(worktreePath, relPath);
  const handle = await fs.open(absPath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_FILE_READ_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, Math.min(bytesRead, MAX_FILE_READ_BYTES)).toString('utf-8');
    if (bytesRead > MAX_FILE_READ_BYTES) {
      return `${content}\n... (truncated at ${MAX_FILE_READ_BYTES} bytes)`;
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function toolListDirectory(worktreePath: string, relPath: string): Promise<string> {
  const absPath = resolveSafePath(worktreePath, relPath || '.');
  const entries = await fs.readdir(absPath, { withFileTypes: true });
  return entries
    .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
    .sort()
    .join('\n');
}

async function toolGitStatus(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    env: GIT_ENV,
    timeout: TOOL_TIMEOUT,
  });
  return stdout.trim() || '(clean working tree)';
}

async function toolGitLog(worktreePath: string, argsStr: string): Promise<string> {
  // Parse and validate args
  const args = argsStr.split(/\s+/).filter(Boolean);
  const sanitizedArgs: string[] = [];

  for (const arg of args) {
    // Allow flags that start with -- if they're in the allowlist
    if (arg.startsWith('--')) {
      const flagName = arg.includes('=') ? arg.split('=')[0] : arg;
      if (!ALLOWED_GIT_LOG_FLAGS.has(flagName)) {
        return `Error: flag "${flagName}" is not allowed for safety. Allowed: ${[...ALLOWED_GIT_LOG_FLAGS].join(', ')}`;
      }
    }
    // Allow -N (number of commits)
    if (arg.match(/^-\d+$/)) {
      sanitizedArgs.push(arg);
      continue;
    }
    // Allow commit ranges (SHA..SHA, branch names, HEAD~N)
    if (arg.match(/^[a-zA-Z0-9_.~^/.-]+(?:\.\.[a-zA-Z0-9_.~^/.-]+)?$/)) {
      sanitizedArgs.push(arg);
      continue;
    }
    // Allow format strings
    if (arg.startsWith('--format=') || arg.startsWith('--pretty=')) {
      sanitizedArgs.push(arg);
    }
  }

  const { stdout } = await execFileAsync('git', ['log', ...sanitizedArgs], {
    cwd: worktreePath,
    env: GIT_ENV,
    timeout: TOOL_TIMEOUT,
    maxBuffer: 512 * 1024,
  });
  return stdout.trim().slice(0, 20_000) || '(no commits)';
}

async function toolSearchFiles(
  worktreePath: string,
  pattern: string,
  glob?: string,
): Promise<string> {
  const args = ['-rn', '--max-count', String(MAX_SEARCH_RESULTS)];
  if (glob) {
    args.push('--include', glob);
  }
  args.push('--', pattern, '.');

  try {
    const { stdout } = await execFileAsync('grep', args, {
      cwd: worktreePath,
      timeout: TOOL_TIMEOUT,
      maxBuffer: 512 * 1024,
    });
    return stdout.trim().slice(0, 20_000) || '(no matches)';
  } catch (err) {
    // grep exits 1 when no matches found
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
      return '(no matches)';
    }
    throw err;
  }
}

// ── Model ID resolution ───────────────────────────────────────────────────────

/** Maps short model names (used in profiles) to full Anthropic model IDs */
export function resolveToolReviewModelId(model: string): string {
  const aliases: Record<string, string> = {
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-7',
    haiku: 'claude-haiku-4-5',
  };
  return aliases[model] ?? model;
}
