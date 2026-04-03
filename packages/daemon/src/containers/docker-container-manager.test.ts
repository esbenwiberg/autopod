import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerContainerManager } from './docker-container-manager.js';

// ─── Mock helpers ────────────────────────────────────────────

const logger = pino({ level: 'silent' });

/** Create a fake Docker container with controllable methods. */
function createMockContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abc123deadbeef',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
    putArchive: vi.fn().mockResolvedValue(undefined),
    getArchive: vi.fn(),
    exec: vi.fn(),
    ...overrides,
  };
}

/** Create a fake multiplexed stream that ends immediately. */
function createMockMuxStream(stdout = '', stderr = '') {
  const stream = new PassThrough();
  // Tag it so the demux mock can identify it
  (stream as PassThrough & { _mockStdout?: string; _mockStderr?: string })._mockStdout = stdout;
  (stream as PassThrough & { _mockStdout?: string; _mockStderr?: string })._mockStderr = stderr;
  // Drain readable side so 'end' event fires when we call .end()
  stream.resume();
  process.nextTick(() => stream.end());
  return stream;
}

/** Create a fake exec object. */
function createMockExec(exitCode = 0) {
  const muxStream = createMockMuxStream();
  return {
    exec: {
      start: vi.fn().mockResolvedValue(muxStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: exitCode }),
    },
    stream: muxStream,
  };
}

function createMockDocker(container = createMockContainer()) {
  return {
    createContainer: vi.fn().mockResolvedValue(container),
    getContainer: vi.fn().mockReturnValue(container),
    modem: {
      demuxStream: vi.fn(
        (
          stream: { _mockStdout?: string; _mockStderr?: string },
          stdoutWriter: NodeJS.WritableStream,
          stderrWriter: NodeJS.WritableStream,
        ) => {
          // Write mock data if present
          if (stream._mockStdout) stdoutWriter.write(stream._mockStdout);
          if (stream._mockStderr) stderrWriter.write(stream._mockStderr);
        },
      ),
    },
  } as unknown as Dockerode;
}

// ─── Tests ───────────────────────────────────────────────────

describe('DockerContainerManager', () => {
  let docker: ReturnType<typeof createMockDocker>;
  let container: ReturnType<typeof createMockContainer>;
  let manager: DockerContainerManager;

  beforeEach(() => {
    container = createMockContainer();
    docker = createMockDocker(container);
    manager = new DockerContainerManager({ docker, logger });
  });

  // ─── spawn() ────────────────────────────────────────────

  describe('spawn()', () => {
    const baseConfig = {
      image: 'node:22-alpine',
      sessionId: 'sess-abc',
      env: { SESSION_ID: 'sess-abc', PORT: '3000' },
    };

    it('creates and starts a container with correct name', async () => {
      const id = await manager.spawn(baseConfig);

      expect(id).toBe('abc123deadbeef');
      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: 'node:22-alpine',
          name: 'autopod-sess-abc',
          Cmd: ['sleep', 'infinity'],
          WorkingDir: '/workspace',
        }),
      );
      expect(container.start).toHaveBeenCalledTimes(1);
    });

    it('maps env vars to KEY=VALUE format', async () => {
      await manager.spawn(baseConfig);

      const createCall = docker.createContainer.mock.calls[0]?.[0];
      expect(createCall.Env).toEqual(expect.arrayContaining(['SESSION_ID=sess-abc', 'PORT=3000']));
    });

    it('configures port bindings when ports provided', async () => {
      await manager.spawn({
        ...baseConfig,
        ports: [{ container: 3000, host: 12345 }],
      });

      const createCall = docker.createContainer.mock.calls[0]?.[0];
      expect(createCall.ExposedPorts).toEqual({ '3000/tcp': {} });
      expect(createCall.HostConfig.PortBindings).toEqual({
        '3000/tcp': [{ HostPort: '12345' }],
      });
    });

    it('configures multiple port bindings', async () => {
      await manager.spawn({
        ...baseConfig,
        ports: [
          { container: 3000, host: 12345 },
          { container: 8080, host: 54321 },
        ],
      });

      const createCall = docker.createContainer.mock.calls[0]?.[0];
      expect(createCall.ExposedPorts).toEqual({
        '3000/tcp': {},
        '8080/tcp': {},
      });
      expect(createCall.HostConfig.PortBindings).toEqual({
        '3000/tcp': [{ HostPort: '12345' }],
        '8080/tcp': [{ HostPort: '54321' }],
      });
    });

    it('skips port config when no ports provided', async () => {
      await manager.spawn(baseConfig);

      const createCall = docker.createContainer.mock.calls[0]?.[0];
      expect(createCall.ExposedPorts).toEqual({});
      expect(createCall.HostConfig.PortBindings).toBeUndefined();
    });

    it('configures volume binds', async () => {
      await manager.spawn({
        ...baseConfig,
        volumes: [{ host: '/tmp/worktree/abc', container: '/workspace' }],
      });

      const createCall = docker.createContainer.mock.calls[0]?.[0];
      expect(createCall.HostConfig.Binds).toEqual(['/tmp/worktree/abc:/workspace']);
    });

    it('skips volume config when no volumes provided', async () => {
      await manager.spawn(baseConfig);

      const createCall = docker.createContainer.mock.calls[0]?.[0];
      expect(createCall.HostConfig.Binds).toBeUndefined();
    });

    it('sets NetworkMode and NET_ADMIN when networkName provided', async () => {
      await manager.spawn({
        ...baseConfig,
        networkName: 'autopod-net',
      });

      const createCall = docker.createContainer.mock.calls[0]?.[0];
      expect(createCall.HostConfig.NetworkMode).toBe('autopod-net');
      expect(createCall.HostConfig.CapAdd).toEqual(['NET_ADMIN']);
    });

    it('does NOT set NetworkMode when networkName absent', async () => {
      await manager.spawn(baseConfig);

      const createCall = docker.createContainer.mock.calls[0]?.[0];
      expect(createCall.HostConfig.NetworkMode).toBeUndefined();
      expect(createCall.HostConfig.CapAdd).toBeUndefined();
    });

    it('applies firewall script after container starts', async () => {
      // Mock the exec for applyFirewall
      const execObj = createMockExec(0);
      container.exec.mockResolvedValue(execObj.exec);

      await manager.spawn({
        ...baseConfig,
        firewallScript: '#!/bin/sh\niptables -A OUTPUT -j DROP',
      });

      // writeFile was called (for the firewall script)
      expect(container.putArchive).toHaveBeenCalled();
      // exec was called (to run the firewall script)
      expect(container.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          Cmd: ['sh', '/tmp/firewall.sh'],
          User: 'root',
        }),
      );
    });

    it('continues without isolation when firewall application fails', async () => {
      container.exec.mockRejectedValue(new Error('iptables not found'));

      const id = await manager.spawn({
        ...baseConfig,
        firewallScript: '#!/bin/sh\nexit 1',
      });

      // Should still return container ID (graceful degradation)
      expect(id).toBe('abc123deadbeef');
    });

    it('removes stale container on 409 and retries', async () => {
      const freshContainer = createMockContainer({ id: 'fresh123' });
      const staleContainer = createMockContainer();

      // First createContainer → 409, second → success
      docker.createContainer
        .mockRejectedValueOnce(Object.assign(new Error('name already in use'), { statusCode: 409 }))
        .mockResolvedValueOnce(freshContainer);
      docker.getContainer.mockReturnValue(staleContainer);

      const id = await manager.spawn(baseConfig);

      expect(id).toBe('fresh123');
      expect(staleContainer.stop).toHaveBeenCalledWith({ t: 5 });
      expect(staleContainer.remove).toHaveBeenCalledWith({ force: true });
      expect(docker.createContainer).toHaveBeenCalledTimes(2);
    });

    it('removes stale container on 409 even if stop fails', async () => {
      const freshContainer = createMockContainer({ id: 'fresh123' });
      const staleContainer = createMockContainer({
        stop: vi.fn().mockRejectedValue(Object.assign(new Error('not running'), { statusCode: 304 })),
      });

      docker.createContainer
        .mockRejectedValueOnce(Object.assign(new Error('name already in use'), { statusCode: 409 }))
        .mockResolvedValueOnce(freshContainer);
      docker.getContainer.mockReturnValue(staleContainer);

      const id = await manager.spawn(baseConfig);

      expect(id).toBe('fresh123');
      expect(staleContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it('propagates errors from createContainer', async () => {
      docker.createContainer.mockRejectedValue(new Error('image not found'));

      await expect(manager.spawn(baseConfig)).rejects.toThrow('image not found');
    });

    it('propagates errors from container.start', async () => {
      container.start.mockRejectedValue(new Error('port already in use'));

      await expect(manager.spawn(baseConfig)).rejects.toThrow('port already in use');
    });
  });

  // ─── stop() ─────────────────────────────────────────────

  describe('stop()', () => {
    it('stops the container without removing it', async () => {
      await manager.stop('abc123');

      expect(container.stop).toHaveBeenCalledWith({ t: 10 });
      expect(container.remove).not.toHaveBeenCalled();
    });

    it('swallows 304 (already stopped)', async () => {
      container.stop.mockRejectedValue({ statusCode: 304 });

      await expect(manager.stop('abc123')).resolves.toBeUndefined();
    });

    it('throws unexpected errors', async () => {
      container.stop.mockRejectedValue({ statusCode: 500, message: 'internal error' });

      await expect(manager.stop('abc123')).rejects.toEqual(
        expect.objectContaining({ statusCode: 500 }),
      );
    });
  });

  // ─── start() ────────────────────────────────────────────

  describe('start()', () => {
    it('starts a stopped container', async () => {
      await manager.start('abc123');

      expect(container.start).toHaveBeenCalled();
    });

    it('swallows 304 (already running)', async () => {
      container.start.mockRejectedValue({ statusCode: 304 });

      await expect(manager.start('abc123')).resolves.toBeUndefined();
    });

    it('throws unexpected errors', async () => {
      container.start.mockRejectedValue({ statusCode: 500, message: 'internal error' });

      await expect(manager.start('abc123')).rejects.toEqual(
        expect.objectContaining({ statusCode: 500 }),
      );
    });
  });

  // ─── kill() ─────────────────────────────────────────────

  describe('kill()', () => {
    it('stops and removes the container', async () => {
      await manager.kill('abc123');

      expect(container.stop).toHaveBeenCalledWith({ t: 10 });
      expect(container.remove).toHaveBeenCalledWith({ force: true });
    });

    it('swallows 304 (already stopped) on stop', async () => {
      container.stop.mockRejectedValue({ statusCode: 304 });

      await expect(manager.kill('abc123')).resolves.toBeUndefined();
      expect(container.remove).toHaveBeenCalled();
    });

    it('swallows 404 (not found) on stop', async () => {
      container.stop.mockRejectedValue({ statusCode: 404 });

      await expect(manager.kill('abc123')).resolves.toBeUndefined();
      expect(container.remove).toHaveBeenCalled();
    });

    it('swallows 404 on remove', async () => {
      container.remove.mockRejectedValue({ statusCode: 404 });

      await expect(manager.kill('abc123')).resolves.toBeUndefined();
    });

    it('swallows 404 when entire container is already gone', async () => {
      // getContainer returns an object, but stop throws 404
      container.stop.mockRejectedValue({ statusCode: 404 });
      container.remove.mockRejectedValue({ statusCode: 404 });

      await expect(manager.kill('abc123')).resolves.toBeUndefined();
    });

    it('throws unexpected errors from stop', async () => {
      container.stop.mockRejectedValue({ statusCode: 500, message: 'internal error' });

      await expect(manager.kill('abc123')).rejects.toEqual(
        expect.objectContaining({ statusCode: 500 }),
      );
    });

    it('throws unexpected errors from remove', async () => {
      container.remove.mockRejectedValue({ statusCode: 500, message: 'disk full' });

      await expect(manager.kill('abc123')).rejects.toEqual(
        expect.objectContaining({ statusCode: 500 }),
      );
    });
  });

  // ─── getStatus() ────────────────────────────────────────

  describe('getStatus()', () => {
    it('returns "running" when container is running', async () => {
      container.inspect.mockResolvedValue({ State: { Running: true } });

      expect(await manager.getStatus('abc123')).toBe('running');
    });

    it('returns "stopped" when container is not running', async () => {
      container.inspect.mockResolvedValue({ State: { Running: false } });

      expect(await manager.getStatus('abc123')).toBe('stopped');
    });

    it('returns "unknown" when inspect throws', async () => {
      container.inspect.mockRejectedValue(new Error('not found'));

      expect(await manager.getStatus('abc123')).toBe('unknown');
    });
  });

  // ─── writeFile() ────────────────────────────────────────

  describe('writeFile()', () => {
    it('puts a tar archive to the container root', async () => {
      await manager.writeFile('abc123', '/workspace/CLAUDE.md', '# Hello');

      expect(container.putArchive).toHaveBeenCalledTimes(1);
      const call0 = container.putArchive.mock.calls[0];
      expect(call0).toBeDefined();
      const [tarBuffer, options] = call0 ?? [];
      expect(tarBuffer).toBeInstanceOf(Buffer);
      expect(options).toEqual({ path: '/' });
    });

    it('strips leading slash from file path for tar entry', async () => {
      await manager.writeFile('abc123', '/etc/config.json', '{}');

      // The tar buffer should contain the entry at 'etc/config.json' (no leading slash)
      const [tarBuffer] = container.putArchive.mock.calls[0] ?? [];
      expect(tarBuffer.length).toBeGreaterThan(0);
    });

    it('handles paths without leading slash', async () => {
      await manager.writeFile('abc123', 'relative/path.txt', 'content');

      expect(container.putArchive).toHaveBeenCalledTimes(1);
    });
  });

  // ─── readFile() ─────────────────────────────────────────

  describe('readFile()', () => {
    it('extracts file content from tar archive stream', async () => {
      // Create a tar archive containing a single file
      const tarStream = await createTarStream('test.txt', 'file content here');
      container.getArchive.mockResolvedValue(tarStream);

      const content = await manager.readFile('abc123', '/workspace/test.txt');
      expect(content).toBe('file content here');
    });

    it('propagates errors from getArchive', async () => {
      container.getArchive.mockRejectedValue(new Error('file not found'));

      await expect(manager.readFile('abc123', '/nonexistent')).rejects.toThrow('file not found');
    });
  });

  // ─── execInContainer() ──────────────────────────────────

  describe('execInContainer()', () => {
    it('executes command and returns output', async () => {
      const muxStream = createMockMuxStream('hello world', '');
      const mockExec = {
        start: vi.fn().mockResolvedValue(muxStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
      };
      container.exec.mockResolvedValue(mockExec);

      const result = await manager.execInContainer('abc123', ['echo', 'hello world']);

      expect(result.stdout).toBe('hello world');
      expect(result.exitCode).toBe(0);
    });

    it('passes cwd option as WorkingDir', async () => {
      const muxStream = createMockMuxStream();
      const mockExec = {
        start: vi.fn().mockResolvedValue(muxStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
      };
      container.exec.mockResolvedValue(mockExec);

      await manager.execInContainer('abc123', ['ls'], { cwd: '/workspace/src' });

      expect(container.exec).toHaveBeenCalledWith(
        expect.objectContaining({ WorkingDir: '/workspace/src' }),
      );
    });

    it('returns exit code from exec inspection', async () => {
      const muxStream = createMockMuxStream('', 'error occurred');
      const mockExec = {
        start: vi.fn().mockResolvedValue(muxStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 1 }),
      };
      container.exec.mockResolvedValue(mockExec);

      const result = await manager.execInContainer('abc123', ['false']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('error occurred');
    });

    it('defaults to exit code 1 when ExitCode is null', async () => {
      const muxStream = createMockMuxStream();
      const mockExec = {
        start: vi.fn().mockResolvedValue(muxStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: null }),
      };
      container.exec.mockResolvedValue(mockExec);

      const result = await manager.execInContainer('abc123', ['cmd']);
      expect(result.exitCode).toBe(1);
    });
  });

  // ─── execStreaming() ────────────────────────────────────

  describe('execStreaming()', () => {
    it('returns stdout/stderr streams and exit code promise', async () => {
      const muxStream = new PassThrough();
      const mockExec = {
        start: vi.fn().mockResolvedValue(muxStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
      };
      container.exec.mockResolvedValue(mockExec);

      const result = await manager.execStreaming('abc123', ['long-running-cmd']);

      expect(result.stdout).toBeDefined();
      expect(result.stderr).toBeDefined();
      expect(result.exitCode).toBeInstanceOf(Promise);
      expect(typeof result.kill).toBe('function');

      // Drain the readable side so 'end' fires when we close the stream
      muxStream.resume();
      muxStream.end();
      const exitCode = await result.exitCode;
      expect(exitCode).toBe(0);
    });

    it('passes env vars as Env list', async () => {
      const muxStream = new PassThrough();
      const mockExec = {
        start: vi.fn().mockResolvedValue(muxStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
      };
      container.exec.mockResolvedValue(mockExec);

      await manager.execStreaming('abc123', ['cmd'], {
        env: { FOO: 'bar', API_KEY: 'secret' },
      });

      expect(container.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          Env: expect.arrayContaining(['FOO=bar', 'API_KEY=secret']),
        }),
      );

      muxStream.end();
    });

    it('kill() destroys the mux stream', async () => {
      const muxStream = new PassThrough();
      const mockExec = {
        start: vi.fn().mockResolvedValue(muxStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 1 }),
      };
      container.exec.mockResolvedValue(mockExec);

      const result = await manager.execStreaming('abc123', ['cmd']);
      await result.kill();

      // Stream should be destroyed
      expect(muxStream.destroyed).toBe(true);
    });
  });

  // ─── Full spawn config integration ─────────────────────

  describe('spawn config integration', () => {
    it('wires up a full realistic spawn config', async () => {
      const execObj = createMockExec(0);
      container.exec.mockResolvedValue(execObj.exec);

      await manager.spawn({
        image: 'autopod-node22:latest',
        sessionId: 'sess-xyz',
        env: {
          SESSION_ID: 'sess-xyz',
          PORT: '3000',
          ANTHROPIC_API_KEY: 'sk-test',
        },
        ports: [{ container: 3000, host: 45678 }],
        volumes: [{ host: '/tmp/worktrees/sess-xyz', container: '/workspace' }],
        networkName: 'autopod-net',
        firewallScript: '#!/bin/sh\necho "firewall applied"',
      });

      const createCall = docker.createContainer.mock.calls[0]?.[0];

      // Container config
      expect(createCall.Image).toBe('autopod-node22:latest');
      expect(createCall.name).toBe('autopod-sess-xyz');
      expect(createCall.Cmd).toEqual(['sleep', 'infinity']);
      expect(createCall.WorkingDir).toBe('/workspace');

      // Env vars
      expect(createCall.Env).toContain('SESSION_ID=sess-xyz');
      expect(createCall.Env).toContain('PORT=3000');
      expect(createCall.Env).toContain('ANTHROPIC_API_KEY=sk-test');

      // Port bindings
      expect(createCall.ExposedPorts).toEqual({ '3000/tcp': {} });
      expect(createCall.HostConfig.PortBindings).toEqual({
        '3000/tcp': [{ HostPort: '45678' }],
      });

      // Volume binds
      expect(createCall.HostConfig.Binds).toEqual(['/tmp/worktrees/sess-xyz:/workspace']);

      // Network isolation
      expect(createCall.HostConfig.NetworkMode).toBe('autopod-net');
      expect(createCall.HostConfig.CapAdd).toEqual(['NET_ADMIN']);

      // Container was started
      expect(container.start).toHaveBeenCalledTimes(1);

      // Firewall was applied
      expect(container.putArchive).toHaveBeenCalled();
      expect(container.exec).toHaveBeenCalledWith(
        expect.objectContaining({ Cmd: ['sh', '/tmp/firewall.sh'] }),
      );
    });
  });
});

// ─── Tar helper ──────────────────────────────────────────────

async function createTarStream(filename: string, content: string): Promise<NodeJS.ReadableStream> {
  const { pack } = await import('tar-stream');
  const p = pack();
  p.entry({ name: filename }, content);
  p.finalize();
  return p;
}
