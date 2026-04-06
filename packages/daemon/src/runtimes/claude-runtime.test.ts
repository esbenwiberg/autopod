import { PassThrough } from 'node:stream';
import type { AgentErrorEvent, SpawnConfig } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { ClaudeRuntime } from './claude-runtime.js';

const logger = pino({ level: 'silent' });

function createMockHandle(options?: { exitCode?: number }): StreamingExecResult & {
  finish(code?: number): void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExitCode: (code: number) => void;
  const exitCodePromise = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });

  const handle = {
    stdout,
    stderr,
    exitCode: exitCodePromise,
    kill: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
      resolveExitCode?.(options?.exitCode ?? 137);
    }),
    finish(code?: number) {
      stdout.push(null);
      resolveExitCode?.(code ?? options?.exitCode ?? 0);
    },
  };

  return handle;
}

function createMockContainerManager(handle: StreamingExecResult): ContainerManager {
  return {
    spawn: vi.fn(async () => 'container-123'),
    kill: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    refreshFirewall: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ''),
    getStatus: vi.fn(async () => 'running' as const),
    execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    execStreaming: vi.fn(async () => handle),
  };
}

/** Emit a single Claude NDJSON line onto stdout. */
function emitLine(stdout: PassThrough, obj: unknown) {
  stdout.write(`${JSON.stringify(obj)}\n`);
}

describe('ClaudeRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.AUTOPOD_DEBUG_AGENT = undefined;
  });

  // ---------------------------------------------------------------------------
  // buildSpawnArgs
  // ---------------------------------------------------------------------------

  describe('buildSpawnArgs', () => {
    it('includes required flags', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        sessionId: 'abc',
        task: 'Add a test',
        model: 'claude-opus-4-5',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      });

      expect(args).toContain('-p');
      expect(args).toContain('Add a test');
      expect(args).toContain('--model');
      expect(args).toContain('claude-opus-4-5');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--permission-mode');
      expect(args).toContain('bypassPermissions');
      expect(args).toContain('--append-system-prompt-file');
      expect(args).toContain('/home/autopod/.autopod/system-instructions.md');
    });

    it('resolves short model aliases to full model IDs', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const buildArgs = (model: string) =>
        (
          runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
        ).buildSpawnArgs({
          sessionId: 'abc',
          task: 'task',
          model,
          workDir: '/workspace',
          containerId: 'c1',
          env: {},
        });

      // Short aliases → full model IDs
      expect(buildArgs('sonnet')).toContain('claude-sonnet-4-6');
      expect(buildArgs('opus')).toContain('claude-opus-4-6');
      expect(buildArgs('haiku')).toContain('claude-haiku-4-5');

      // Full model IDs pass through unchanged
      expect(buildArgs('claude-sonnet-4-5')).toContain('claude-sonnet-4-5');
      expect(buildArgs('claude-opus-4-6')).toContain('claude-opus-4-6');
    });

    it('includes --session-id flag', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        sessionId: 'abc',
        task: 'task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      });

      expect(args).toContain('--session-id');
    });

    it('includes --debug when AUTOPOD_DEBUG_AGENT=1', () => {
      process.env.AUTOPOD_DEBUG_AGENT = '1';
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        sessionId: 'abc',
        task: 'task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      });

      expect(args).toContain('--debug');
    });

    it('does not include --debug by default', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        sessionId: 'abc',
        task: 'task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      });

      expect(args).not.toContain('--debug');
    });

    it('includes --mcp-config with file path when mcpServers is provided', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        sessionId: 'abc',
        task: 'task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
        mcpServers: [{ name: 'escalation', url: 'http://localhost:3100/mcp' }],
      });

      expect(args).toContain('--mcp-config');
      const configIdx = args.indexOf('--mcp-config');
      expect(args[configIdx + 1]).toBe('/home/autopod/.autopod/mcp-config.json');
    });

    it('does not include --mcp-config when mcpServers is empty', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        sessionId: 'abc',
        task: 'task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
        mcpServers: [],
      });

      expect(args).not.toContain('--mcp-config');
    });
  });

  // ---------------------------------------------------------------------------
  // writeMcpConfig
  // ---------------------------------------------------------------------------

  describe('writeMcpConfig', () => {
    it('writes MCP config JSON to the container', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await (
        runtime as unknown as {
          writeMcpConfig: (config: SpawnConfig) => Promise<void>;
        }
      ).writeMcpConfig({
        sessionId: 'abc',
        task: 'task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
        mcpServers: [
          {
            name: 'escalation',
            url: 'http://host.docker.internal:3100/mcp/abc',
            headers: { Authorization: 'Bearer tok123' },
          },
        ],
      });

      expect(cm.writeFile).toHaveBeenCalledWith(
        'c1',
        '/home/autopod/.autopod/mcp-config.json',
        expect.any(String),
      );

      const written = (cm.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
      const parsed = JSON.parse(written);
      expect(parsed.mcpServers.escalation).toMatchObject({
        type: 'streamable-http',
        url: 'http://host.docker.internal:3100/mcp/abc',
        headers: { Authorization: 'Bearer tok123' },
      });
    });

    it('skips writing when mcpServers is empty', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await (
        runtime as unknown as {
          writeMcpConfig: (config: SpawnConfig) => Promise<void>;
        }
      ).writeMcpConfig({
        sessionId: 'abc',
        task: 'task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
        mcpServers: [],
      });

      expect(cm.writeFile).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // buildResumeArgs
  // ---------------------------------------------------------------------------

  describe('buildResumeArgs', () => {
    it('includes --resume flag when claudeSessionId is provided', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildResumeArgs: (msg: string, id?: string) => string[] }
      ).buildResumeArgs('Continue please', 'claude-session-xyz');

      expect(args).toContain('--resume');
      expect(args).toContain('claude-session-xyz');
      expect(args).toContain('--append-system-prompt-file');
      expect(args).toContain('/home/autopod/.autopod/system-instructions.md');
    });

    it('omits --resume when claudeSessionId is undefined', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildResumeArgs: (msg: string, id?: string) => string[] }
      ).buildResumeArgs('Continue please', undefined);

      expect(args).not.toContain('--resume');
    });
  });

  // ---------------------------------------------------------------------------
  // spawn
  // ---------------------------------------------------------------------------

  describe('spawn', () => {
    it('calls execStreaming and yields parsed events from stdout', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        emitLine(handle.stdout as PassThrough, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it...' }] },
        });
        emitLine(handle.stdout as PassThrough, {
          type: 'result',
          subtype: 'success',
          result: 'Done',
        });
        handle.finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        sessionId: 'sess-1',
        task: 'Do the thing',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        expect.arrayContaining(['claude', '-p', 'Do the thing']),
        expect.objectContaining({ cwd: '/workspace' }),
      );
      expect(events.length).toBeGreaterThan(0);
    });

    it('yields a fatal error event on non-zero exit code', async () => {
      const handle = createMockHandle({ exitCode: 1 });
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(1);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        sessionId: 'sess-fail',
        task: 'Fail',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as unknown as AgentErrorEvent).message).toContain('exited with code 1');
      expect((errorEvent as unknown as AgentErrorEvent).fatal).toBe(true);
    });

    it('does not yield an error event on exit code 0', async () => {
      const handle = createMockHandle({ exitCode: 0 });
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        sessionId: 'sess-ok',
        task: 'Success',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const fatalError = events.find(
        (e) => e.type === 'error' && (e as unknown as AgentErrorEvent).fatal === true,
      );
      expect(fatalError).toBeUndefined();
    });

    it('flushes stderr events interleaved with stdout events', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        // Write stderr first
        (handle.stderr as PassThrough).write('something went to stderr\n');
        // Then write a stdout event which will flush the buffered stderr event
        emitLine(handle.stdout as PassThrough, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        });
        handle.finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        sessionId: 'sess-stderr',
        task: 'Task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const stderrEvent = events.find(
        (e) => e.type === 'error' && (e as unknown as AgentErrorEvent).message.includes('[stderr]'),
      );
      expect(stderrEvent).toBeDefined();
    });

    it('extracts and stores Claude session ID from init event', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        emitLine(handle.stdout as PassThrough, {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-sess-abc123',
        });
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        sessionId: 'sess-id-track',
        task: 'Task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        /* consume */
      }

      expect(runtime.getClaudeSessionId('sess-id-track')).toBe('claude-sess-abc123');
    });

    it('removes handle tracking after completion', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        sessionId: 'track-sess',
        task: 'Task',
        model: 'opus',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        /* consume */
      }

      expect(
        (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.has(
          'track-sess',
        ),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // resume
  // ---------------------------------------------------------------------------

  describe('resume', () => {
    it('calls execStreaming with --resume when a claude session ID is known', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      // Pre-set a Claude session ID
      runtime.setClaudeSessionId('sess-1', 'claude-internal-xyz');

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.resume('sess-1', 'Fix the issue', 'container-123', {})) {
        /* consume */
      }

      const calledArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      expect(calledArgs).toContain('--resume');
      expect(calledArgs).toContain('claude-internal-xyz');
    });

    it('calls execStreaming without --resume when no claude session ID is known', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.resume('sess-new', 'Continue please', 'container-123')) {
        /* consume */
      }

      const calledArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      expect(calledArgs).not.toContain('--resume');
    });

    it('removes handle tracking after resume completion', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.resume('track-resume', 'msg', 'c1')) {
        /* consume */
      }

      expect(
        (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.has(
          'track-resume',
        ),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // abort
  // ---------------------------------------------------------------------------

  describe('abort', () => {
    it('calls handle.kill() and cleans up both session and claude session IDs', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.set(
        'sess-1',
        handle,
      );
      runtime.setClaudeSessionId('sess-1', 'claude-xyz');

      await runtime.abort('sess-1');

      expect(handle.kill).toHaveBeenCalled();
      expect(
        (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.has('sess-1'),
      ).toBe(false);
      expect(runtime.getClaudeSessionId('sess-1')).toBeUndefined();
    });

    it('is a no-op when no handle is tracked', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await expect(runtime.abort('nonexistent')).resolves.toBeUndefined();
      expect(handle.kill).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // suspend
  // ---------------------------------------------------------------------------

  describe('suspend', () => {
    it('kills the handle but preserves the claude session ID for resume', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.set(
        'sess-1',
        handle,
      );
      runtime.setClaudeSessionId('sess-1', 'claude-preserve-me');

      await runtime.suspend('sess-1');

      expect(handle.kill).toHaveBeenCalled();
      expect(
        (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.has('sess-1'),
      ).toBe(false);
      // Session ID preserved (unlike abort)
      expect(runtime.getClaudeSessionId('sess-1')).toBe('claude-preserve-me');
    });

    it('is a no-op when no handle is tracked', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await expect(runtime.suspend('nonexistent')).resolves.toBeUndefined();
      expect(handle.kill).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // setClaudeSessionId / getClaudeSessionId
  // ---------------------------------------------------------------------------

  describe('setClaudeSessionId / getClaudeSessionId', () => {
    it('stores and retrieves a claude session ID', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      runtime.setClaudeSessionId('my-session', 'claude-abc');
      expect(runtime.getClaudeSessionId('my-session')).toBe('claude-abc');
    });

    it('returns undefined for unknown sessions', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      expect(runtime.getClaudeSessionId('unknown')).toBeUndefined();
    });
  });
});
