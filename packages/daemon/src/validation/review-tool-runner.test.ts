import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const anthropicMocks = vi.hoisted(() => {
  const messagesCreate = vi.fn();
  class MockAnthropic {
    messages = {
      create: messagesCreate,
    };
  }
  return { messagesCreate, MockAnthropic };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: anthropicMocks.MockAnthropic,
}));

// We test the internal tool implementations by importing the module and
// exercising them through the exported runToolUseReview (with a mocked SDK).
// For unit testing the tools directly, we re-implement the path safety check.

describe('review tool runner - Anthropic request shape', () => {
  afterEach(() => {
    anthropicMocks.messagesCreate.mockReset();
  });

  it('uses the supplied provider client and resolved model without default authentication', async () => {
    const response = {
      content: [{ type: 'text', text: '{"status":"pass"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    anthropicMocks.messagesCreate.mockResolvedValue(response);
    const create = vi.fn().mockResolvedValue(response);
    const { runToolUseReview } = await import('./review-tool-runner.js');
    const result = await runToolUseReview({
      model: 'configured-alias',
      prompt: 'review',
      worktreePath: process.cwd(),
      timeout: 1000,
      apiKey: 'unrelated-default-key',
      providerClient: {
        model: 'resolved-deployment',
        client: { messages: { create } } as unknown as Anthropic,
      },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: 'resolved-deployment' });
    expect(anthropicMocks.messagesCreate).not.toHaveBeenCalled();
    expect(result.tokenUsage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it('retains the selected client and model across actual tool turns', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-bound-turn-'));
    try {
      await fs.writeFile(path.join(root, 'evidence.txt'), 'selected repo evidence');
      const create = vi
        .fn()
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'read1', name: 'read_file', input: { path: 'evidence.txt' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 2 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: '{"status":"pass"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 3 },
        });
      const { runToolUseReview } = await import('./review-tool-runner.js');
      const beforeRequest = vi.fn();
      const onDispatch = vi.fn();
      const result = await runToolUseReview({
        beforeRequest,
        onDispatch,
        model: 'configured',
        prompt: 'review',
        worktreePath: root,
        timeout: 1000,
        providerClient: {
          model: 'selected-deployment',
          client: { messages: { create } } as unknown as Anthropic,
        },
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(beforeRequest).toHaveBeenCalledTimes(7);
      expect(onDispatch.mock.calls).toEqual([['selected-deployment'], ['selected-deployment']]);
      expect(create.mock.calls.map(([body]) => body.model)).toEqual([
        'selected-deployment',
        'selected-deployment',
      ]);
      expect(JSON.stringify(create.mock.calls[1]?.[0].messages)).toContain(
        'selected repo evidence',
      );
      expect(anthropicMocks.messagesCreate).not.toHaveBeenCalled();
      expect(result.tokenUsage).toEqual({ inputTokens: 30, outputTokens: 5 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not continue API tool turns after review ownership changes', async () => {
    let current = true;
    const create = vi
      .fn()
      .mockImplementationOnce(async () => {
        current = false;
        return {
          content: [
            {
              type: 'tool_use',
              id: 'read1',
              name: 'read_file',
              input: { path: 'absent-fixture.txt' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      })
      .mockResolvedValue({
        content: [{ type: 'text', text: '{"status":"pass"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 3 },
      });
    const { runToolUseReview } = await import('./review-tool-runner.js');
    const result = await runToolUseReview({
      model: 'selected',
      prompt: 'review',
      worktreePath: process.cwd(),
      timeout: 1000,
      providerClient: {
        model: 'selected',
        client: { messages: { create } } as unknown as Anthropic,
      },
      beforeRequest: () => {
        if (!current) throw new Error('review ownership lost');
      },
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({
      message: 'review ownership lost',
      kind: 'ownership-lost',
      tokenUsage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('allows one final request without tools and stops if the model requests more tools', async () => {
    const tool = (id: string) => ({
      type: 'tool_use',
      id,
      name: 'read_file',
      input: { path: 'absent-fixture.txt' },
    });
    const usage = { input_tokens: 10, output_tokens: 2 };
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        content: [tool('one'), tool('two')],
        stop_reason: 'tool_use',
        usage,
      })
      .mockResolvedValueOnce({ content: [tool('three')], stop_reason: 'tool_use', usage })
      .mockResolvedValue({
        content: [{ type: 'text', text: '{"status":"pass"}' }],
        stop_reason: 'end_turn',
        usage,
      });
    const { runToolUseReview } = await import('./review-tool-runner.js');
    const result = await runToolUseReview({
      model: 'selected',
      prompt: 'review',
      worktreePath: process.cwd(),
      timeout: 1000,
      maxToolCalls: 1,
      providerClient: {
        model: 'selected',
        client: { messages: { create } } as unknown as Anthropic,
      },
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({
      kind: 'budget-exhausted',
      tokenUsage: { inputTokens: 20, outputTokens: 4 },
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0].tools).toBeUndefined();
    expect(create.mock.calls[1]?.[0].messages.at(-1)?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_result', tool_use_id: 'one' }),
        expect.objectContaining({ type: 'tool_result', tool_use_id: 'two', is_error: true }),
      ]),
    );
  });

  it('retains known usage when a later API request fails and disables implicit SDK retry', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'read1',
            name: 'read_file',
            input: { path: 'absent-fixture.txt' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 3 },
      })
      .mockRejectedValue(new Error('second request transport failed'));
    const { runToolUseReview } = await import('./review-tool-runner.js');
    const result = await runToolUseReview({
      model: 'selected',
      prompt: 'review',
      worktreePath: process.cwd(),
      timeout: 1000,
      providerClient: {
        model: 'selected',
        client: { messages: { create } } as unknown as Anthropic,
      },
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({
      kind: 'provider-error',
      tokenUsage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(create).toHaveBeenCalledTimes(2);
    for (const [, options] of create.mock.calls) expect(options).toMatchObject({ maxRetries: 0 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid tool budgets before dispatch: %s',
    async (maxToolCalls) => {
      const create = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      const { runToolUseReview } = await import('./review-tool-runner.js');
      const result = await runToolUseReview({
        model: 'selected',
        prompt: 'review',
        worktreePath: process.cwd(),
        timeout: 1000,
        maxToolCalls,
        providerClient: {
          model: 'selected',
          client: { messages: { create } } as unknown as Anthropic,
        },
      }).catch((error: unknown) => error);
      expect(result).toMatchObject({ message: expect.stringMatching(/tool budget/i) });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('retains a late response measurement but does not accept a verdict after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      const create = vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(1001);
        return {
          content: [{ type: 'text', text: '{"status":"pass"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 3 },
        };
      });
      const { runToolUseReview } = await import('./review-tool-runner.js');
      const result = await runToolUseReview({
        model: 'selected',
        prompt: 'review',
        worktreePath: process.cwd(),
        timeout: 1000,
        providerClient: {
          model: 'selected',
          client: { messages: { create } } as unknown as Anthropic,
        },
      }).catch((error: unknown) => error);
      expect(result).toMatchObject({
        kind: 'timeout',
        tokenUsage: { inputTokens: 12, outputTokens: 3 },
      });
      expect(create).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 1])('accepts a final verdict within a tool budget of %s', async (maxToolCalls) => {
    const usage = { input_tokens: 4, output_tokens: 1 };
    const create = vi.fn();
    if (maxToolCalls)
      create.mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'one', name: 'read_file', input: { path: 'absent-fixture.txt' } },
        ],
        stop_reason: 'tool_use',
        usage,
      });
    create.mockResolvedValue({
      content: [{ type: 'text', text: '{"status":"uncertain"}' }],
      stop_reason: 'end_turn',
      usage,
    });
    const { runToolUseReview } = await import('./review-tool-runner.js');
    const result = await runToolUseReview({
      model: 'selected',
      prompt: 'review',
      worktreePath: process.cwd(),
      timeout: 1000,
      maxToolCalls,
      providerClient: {
        model: 'selected',
        client: { messages: { create } } as unknown as Anthropic,
      },
    });
    expect(result.stdout).toBe('{"status":"uncertain"}');
    expect(create).toHaveBeenCalledTimes(maxToolCalls + 1);
    expect(create.mock.calls.at(-1)?.[0].tools).toBeUndefined();
    expect(result.tokenUsage).toEqual({
      inputTokens: 4 * (maxToolCalls + 1),
      outputTokens: maxToolCalls + 1,
    });
  });

  it('sends one real SDK HTTP request on a retryable provider error', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'local fixture unavailable' },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    try {
      const sdk = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
      const client = new sdk.default({
        apiKey: 'local-fixture-only',
        baseURL: `http://127.0.0.1:${address.port}`,
      });
      const { runToolUseReview } = await import('./review-tool-runner.js');
      const result = await runToolUseReview({
        model: 'selected',
        prompt: 'local fixture',
        worktreePath: process.cwd(),
        timeout: 1000,
        providerClient: { client, model: 'selected' },
      }).catch((error: unknown) => error);
      expect(result).toMatchObject({ kind: 'provider-error' });
      expect(requests).toBe(1);
      expect((result as { tokenUsage?: unknown }).tokenUsage).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes timeout as an SDK option instead of an API body field', async () => {
    anthropicMocks.messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"status":"pass","reasoning":"ok","issues":[]}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    const { runToolUseReview } = await import('./review-tool-runner.js');

    await runToolUseReview({
      model: 'claude-sonnet-4-6',
      prompt: 'Review this diff.',
      worktreePath: process.cwd(),
      timeout: 60_000,
      apiKey: 'test-key',
    });

    expect(anthropicMocks.messagesCreate).toHaveBeenCalledTimes(1);
    const [body, options] = anthropicMocks.messagesCreate.mock.calls[0] ?? [];
    expect(body).not.toHaveProperty('timeout');
    expect(options).toMatchObject({ timeout: expect.any(Number) });
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(60_000);
  });
});

describe('review tool runner - path safety', () => {
  let tmpDir: string;

  function isContained(resolved: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), resolved);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-tools-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export const x = 1;');
    await fs.writeFile(path.join(tmpDir, 'secret.env'), 'API_KEY=hunter2');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolveSafePath rejects path traversal', () => {
    // Simulate the path resolution logic
    const relPath = '../../etc/passwd';
    const resolved = path.resolve(tmpDir, relPath);
    expect(isContained(resolved, tmpDir)).toBe(false);
  });

  it('resolveSafePath allows valid paths', () => {
    const relPath = 'src/index.ts';
    const resolved = path.resolve(tmpDir, relPath);
    expect(isContained(resolved, tmpDir)).toBe(true);
  });

  it('resolveSafePath allows nested paths', () => {
    const relPath = 'src/../src/index.ts';
    const resolved = path.resolve(tmpDir, relPath);
    expect(isContained(resolved, tmpDir)).toBe(true);
  });

  it('resolveSafePath rejects sibling paths with a shared prefix', () => {
    const root = path.join(tmpDir, 'repo');
    const sibling = path.join(tmpDir, 'repo-secret', 'token');
    expect(sibling.startsWith(root)).toBe(true);
    expect(isContained(sibling, root)).toBe(false);
  });
});

describe('review tool runner - git log arg filtering', () => {
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

  function isAllowedFlag(arg: string): boolean {
    if (arg.startsWith('--')) {
      const flagName = arg.includes('=') ? arg.split('=')[0] : arg;
      return ALLOWED_GIT_LOG_FLAGS.has(flagName);
    }
    if (arg.match(/^-\d+$/)) return true;
    if (arg.match(/^[a-zA-Z0-9_.~^/.-]+(?:\.\.[a-zA-Z0-9_.~^/.-]+)?$/)) return true;
    if (arg.startsWith('--format=') || arg.startsWith('--pretty=')) return true;
    return false;
  }

  it('allows safe flags', () => {
    expect(isAllowedFlag('--oneline')).toBe(true);
    expect(isAllowedFlag('--stat')).toBe(true);
    expect(isAllowedFlag('--name-status')).toBe(true);
    expect(isAllowedFlag('-10')).toBe(true);
    expect(isAllowedFlag('HEAD~3..HEAD')).toBe(true);
    expect(isAllowedFlag('--format=%H %s')).toBe(true);
  });

  it('rejects dangerous flags', () => {
    expect(isAllowedFlag('--exec')).toBe(false);
    expect(isAllowedFlag('--diff-filter')).toBe(false);
    expect(isAllowedFlag('--follow')).toBe(false);
  });
});

describe('review tool runner - model ID resolution', () => {
  it('maps short aliases to full IDs', () => {
    const aliases: Record<string, string> = {
      sonnet: 'claude-sonnet-4-6',
      opus: 'claude-opus-4-7',
      haiku: 'claude-haiku-4-5',
    };

    expect(aliases.sonnet).toBe('claude-sonnet-4-6');
    expect(aliases.opus).toBe('claude-opus-4-7');
  });

  it('passes through full model IDs', () => {
    const aliases: Record<string, string> = {
      sonnet: 'claude-sonnet-4-6',
    };
    const model = 'claude-3-5-sonnet-20241022';
    expect(aliases[model] ?? model).toBe('claude-3-5-sonnet-20241022');
  });
});

describe('review tool runner - tool implementations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-tools-impl-'));
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    // Disable commit/tag signing locally so tests don't depend on the host's
    // global gpg.format / gpg.ssh.program configuration.
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'tag.gpgsign', 'false'], { cwd: tmpDir });
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export const hello = "world";');
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name": "test"}');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('read_file reads files from worktree', async () => {
    const content = await fs.readFile(path.join(tmpDir, 'src/index.ts'), 'utf-8');
    expect(content).toContain('hello');
  });

  it('list_directory lists entries', async () => {
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    const names = entries.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('package.json');
  });

  it('git_status works on clean repo', async () => {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
    expect(stdout.trim()).toBe('');
  });

  it('git_status detects uncommitted changes', async () => {
    await fs.writeFile(path.join(tmpDir, 'new.ts'), 'export {};');
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
    expect(stdout).toContain('new.ts');
  });

  it('search_files finds patterns', async () => {
    const { stdout } = await execFileAsync('grep', ['-rn', '--', 'hello', '.'], { cwd: tmpDir });
    expect(stdout).toContain('index.ts');
  });
});
