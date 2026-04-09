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
  /** Anthropic API key. If not provided, uses ANTHROPIC_API_KEY env var. */
  apiKey?: string;
}

/**
 * Runs a review using the Anthropic Messages API with tool use,
 * allowing the reviewer to read files and inspect git state on demand.
 */
export async function runToolUseReview(config: ToolUseReviewConfig): Promise<{ stdout: string }> {
  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const deadline = Date.now() + config.timeout;

  const client = new Anthropic({
    apiKey: config.apiKey,
  });

  const tools = getToolDefinitions();
  const messages: MessageParam[] = [{ role: 'user', content: config.prompt }];

  let toolCallCount = 0;

  // Tool-use loop: keep sending messages until the model returns text-only or we hit limits
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(`Tier 2 review timed out after ${config.timeout}ms`);
    }

    const remainingMs = deadline - Date.now();

    const response: Message = await client.messages.create({
      model: resolveModelId(config.model),
      max_tokens: 8192,
      messages,
      tools,
      system:
        'You are an expert code reviewer with access to tools for investigating the repository. ' +
        'Use the tools to verify claims in the diff when the diff alone is insufficient. ' +
        'When done investigating, respond with ONLY a JSON object (the review verdict). ' +
        'Do not wrap the JSON in markdown fences.',
      timeout: remainingMs,
    });

    // Check if the model returned any tool-use blocks
    const toolUseBlocks = response.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // Model is done — extract the text response
      const textBlocks = response.content.filter(
        (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
      );
      const stdout = textBlocks.map((b) => b.text).join('\n');
      return { stdout };
    }

    // Execute tool calls
    toolCallCount += toolUseBlocks.length;
    if (toolCallCount > maxToolCalls) {
      // Budget exhausted — ask model for final answer without tools
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: `Tool call budget exhausted (${maxToolCalls} calls used). Please provide your final review verdict now as a JSON object based on what you have gathered so far.`,
      });
      continue;
    }

    // Add assistant message with tool use
    messages.push({ role: 'assistant', content: response.content });

    // Execute each tool and gather results
    const toolResults: ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      const result = await executeToolCall(
        toolUse.name,
        toolUse.input as Record<string, unknown>,
        config.worktreePath,
      );
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      });
    }

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
        'Run git status --porcelain to see uncommitted changes, untracked files, and staging state.',
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
  const resolved = path.resolve(worktreePath, relPath);
  if (!resolved.startsWith(path.resolve(worktreePath))) {
    throw new Error('Path traversal detected — access denied');
  }
  return resolved;
}

async function toolReadFile(worktreePath: string, relPath: string): Promise<string> {
  const absPath = resolveSafePath(worktreePath, relPath);
  const content = await fs.readFile(absPath, 'utf-8');
  if (content.length > MAX_FILE_READ_BYTES) {
    return `${content.slice(0, MAX_FILE_READ_BYTES)}\n... (truncated at ${MAX_FILE_READ_BYTES} bytes)`;
  }
  return content;
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
function resolveModelId(model: string): string {
  const aliases: Record<string, string> = {
    sonnet: 'claude-sonnet-4-20250514',
    opus: 'claude-opus-4-20250514',
    haiku: 'claude-haiku-4-5-20251001',
  };
  return aliases[model] ?? model;
}
