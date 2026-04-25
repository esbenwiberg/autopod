import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AciContainerManager } from './aci-container-manager.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Hoist mock fns so they're available inside vi.mock factory
// ---------------------------------------------------------------------------

const {
  mockBeginCreateOrUpdateAndWait,
  mockBeginDeleteAndWait,
  mockExecuteCommand,
  mockListLogs,
  mockGet,
} = vi.hoisted(() => ({
  mockBeginCreateOrUpdateAndWait: vi.fn(),
  mockBeginDeleteAndWait: vi.fn(),
  mockExecuteCommand: vi.fn(),
  mockListLogs: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('@azure/arm-containerinstance', () => ({
  ContainerInstanceManagementClient: vi.fn().mockImplementation(() => ({
    containerGroups: {
      beginCreateOrUpdateAndWait: mockBeginCreateOrUpdateAndWait,
      beginDeleteAndWait: mockBeginDeleteAndWait,
      get: mockGet,
    },
    containers: {
      executeCommand: mockExecuteCommand,
      listLogs: mockListLogs,
    },
  })),
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(() => ({})),
}));

// ---------------------------------------------------------------------------
// Test factory
// ---------------------------------------------------------------------------

function createManager() {
  return new AciContainerManager(
    {
      subscriptionId: 'sub-123',
      resourceGroup: 'rg-test',
      acrRegistryUrl: 'myregistry.azurecr.io',
      acrUsername: 'testuser',
      acrPassword: 'testpassword',
      location: 'westeurope',
      cpu: 2,
      memoryGb: 4,
      logPollIntervalMs: 50, // fast for tests
    },
    logger,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AciContainerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // spawn
  // -------------------------------------------------------------------------

  describe('spawn', () => {
    it('creates a container group and returns the container ID', async () => {
      mockBeginCreateOrUpdateAndWait.mockResolvedValue({ provisioningState: 'Succeeded' });

      const manager = createManager();
      const containerId = await manager.spawn({
        image: 'node22',
        podId: 'sess-abc',
        env: { MY_VAR: 'value' },
      });

      expect(containerId).toBe('autopod-sess-abc');
      expect(mockBeginCreateOrUpdateAndWait).toHaveBeenCalledWith(
        'rg-test',
        'autopod-sess-abc',
        expect.objectContaining({
          location: 'westeurope',
          osType: 'Linux',
          restartPolicy: 'Never',
          containers: expect.arrayContaining([
            expect.objectContaining({
              name: 'agent',
              command: ['sleep', 'infinity'],
              environmentVariables: expect.arrayContaining([{ name: 'MY_VAR', value: 'value' }]),
            }),
          ]),
        }),
      );
    });

    it('resolves short image names to full ACR references', async () => {
      mockBeginCreateOrUpdateAndWait.mockResolvedValue({ provisioningState: 'Succeeded' });

      const manager = createManager();
      await manager.spawn({ image: 'node22', podId: 'sess-1', env: {} });

      const call = mockBeginCreateOrUpdateAndWait.mock.calls[0]?.[2];
      expect(call.containers[0].image).toBe('myregistry.azurecr.io/autopod-node22:latest');
    });

    it('uses a full image reference as-is', async () => {
      mockBeginCreateOrUpdateAndWait.mockResolvedValue({ provisioningState: 'Succeeded' });

      const manager = createManager();
      await manager.spawn({
        image: 'myregistry.azurecr.io/custom/image:v1',
        podId: 'sess-1',
        env: {},
      });

      const call = mockBeginCreateOrUpdateAndWait.mock.calls[0]?.[2];
      expect(call.containers[0].image).toBe('myregistry.azurecr.io/custom/image:v1');
    });

    it('includes registry credentials in the container group spec', async () => {
      mockBeginCreateOrUpdateAndWait.mockResolvedValue({ provisioningState: 'Succeeded' });

      const manager = createManager();
      await manager.spawn({ image: 'node22', podId: 'sess-1', env: {} });

      const call = mockBeginCreateOrUpdateAndWait.mock.calls[0]?.[2];
      expect(call.imageRegistryCredentials).toEqual([
        {
          server: 'myregistry.azurecr.io',
          username: 'testuser',
          password: 'testpassword',
        },
      ]);
    });

    it('uses configured CPU and memory resource requests', async () => {
      mockBeginCreateOrUpdateAndWait.mockResolvedValue({ provisioningState: 'Succeeded' });

      const manager = createManager();
      await manager.spawn({ image: 'node22', podId: 'sess-1', env: {} });

      const call = mockBeginCreateOrUpdateAndWait.mock.calls[0]?.[2];
      expect(call.containers[0].resources.requests).toEqual({ cpu: 2, memoryInGB: 4 });
    });

    it('rejects spawn with deny-all network policy mode (fix 2.4)', async () => {
      const manager = createManager();
      await expect(
        manager.spawn({ image: 'node22', podId: 'sess-1', env: {}, networkPolicyMode: 'deny-all' }),
      ).rejects.toThrow(/ACI does not support network_policy mode 'deny-all'/);
      expect(mockBeginCreateOrUpdateAndWait).not.toHaveBeenCalled();
    });

    it('rejects spawn with restricted network policy mode (fix 2.4)', async () => {
      const manager = createManager();
      await expect(
        manager.spawn({
          image: 'node22',
          podId: 'sess-1',
          env: {},
          networkPolicyMode: 'restricted',
        }),
      ).rejects.toThrow(/ACI does not support network_policy mode 'restricted'/);
      expect(mockBeginCreateOrUpdateAndWait).not.toHaveBeenCalled();
    });

    it('allows spawn with allow-all network policy mode', async () => {
      mockBeginCreateOrUpdateAndWait.mockResolvedValue({ provisioningState: 'Succeeded' });
      const manager = createManager();
      await expect(
        manager.spawn({
          image: 'node22',
          podId: 'sess-1',
          env: {},
          networkPolicyMode: 'allow-all',
        }),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // kill
  // -------------------------------------------------------------------------

  describe('kill', () => {
    it('deletes the container group', async () => {
      mockBeginDeleteAndWait.mockResolvedValue(undefined);

      const manager = createManager();
      await manager.kill('autopod-sess-1');

      expect(mockBeginDeleteAndWait).toHaveBeenCalledWith('rg-test', 'autopod-sess-1');
    });

    it('does not throw on 404 (container already gone)', async () => {
      mockBeginDeleteAndWait.mockRejectedValue({ statusCode: 404 });

      const manager = createManager();
      await expect(manager.kill('autopod-gone')).resolves.toBeUndefined();
    });

    it('does not throw on ResourceNotFound code', async () => {
      mockBeginDeleteAndWait.mockRejectedValue({ code: 'ResourceNotFound' });

      const manager = createManager();
      await expect(manager.kill('autopod-gone2')).resolves.toBeUndefined();
    });

    it('rethrows non-404 errors', async () => {
      mockBeginDeleteAndWait.mockRejectedValue(new Error('Network error'));

      const manager = createManager();
      await expect(manager.kill('autopod-fail')).rejects.toThrow('Network error');
    });

    it('stops active log polling when killing', async () => {
      mockBeginDeleteAndWait.mockResolvedValue(undefined);

      const manager = createManager();
      // Inject a fake poll entry
      const fakeTimer = setInterval(() => {}, 10_000);
      (manager as unknown as { activePolls: Map<string, unknown> }).activePolls.set(
        'autopod-sess-1',
        {
          timer: fakeTimer,
          aborted: false,
        },
      );

      await manager.kill('autopod-sess-1');

      expect(
        (manager as unknown as { activePolls: Map<string, unknown> }).activePolls.has(
          'autopod-sess-1',
        ),
      ).toBe(false);
      clearInterval(fakeTimer);
    });
  });

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns running when container state is running', async () => {
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Running' } } }],
      });

      const manager = createManager();
      expect(await manager.getStatus('autopod-sess-1')).toBe('running');
    });

    it('returns running when container state is waiting', async () => {
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Waiting' } } }],
      });

      const manager = createManager();
      expect(await manager.getStatus('autopod-sess-1')).toBe('running');
    });

    it('returns stopped when container state is terminated', async () => {
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Terminated' } } }],
      });

      const manager = createManager();
      expect(await manager.getStatus('autopod-sess-1')).toBe('stopped');
    });

    it('returns unknown for unrecognised states', async () => {
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Pending' } } }],
      });

      const manager = createManager();
      expect(await manager.getStatus('autopod-sess-1')).toBe('unknown');
    });

    it('returns unknown on 404', async () => {
      mockGet.mockRejectedValue({ statusCode: 404 });

      const manager = createManager();
      expect(await manager.getStatus('autopod-gone')).toBe('unknown');
    });

    it('rethrows non-404 errors', async () => {
      mockGet.mockRejectedValue(new Error('Auth failure'));

      const manager = createManager();
      await expect(manager.getStatus('autopod-fail')).rejects.toThrow('Auth failure');
    });
  });

  // -------------------------------------------------------------------------
  // writeFile
  // -------------------------------------------------------------------------

  describe('writeFile', () => {
    it('executes a base64 write command in the container', async () => {
      mockExecuteCommand.mockResolvedValue({ webSocketUri: null });

      const manager = createManager();
      await manager.writeFile('autopod-sess-1', '/workspace/test.txt', 'hello world');

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'rg-test',
        'autopod-sess-1',
        'agent',
        expect.objectContaining({
          command: expect.stringContaining('base64'),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------

  describe('readFile', () => {
    it('returns a string result from the container', async () => {
      mockExecuteCommand.mockResolvedValue({ webSocketUri: null });

      const manager = createManager();
      const result = await manager.readFile('autopod-sess-1', '/workspace/file.txt');
      expect(typeof result).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // stop / start / refreshFirewall — unsupported ops
  // -------------------------------------------------------------------------

  describe('unsupported operations', () => {
    it('stop throws NOT_SUPPORTED', async () => {
      const manager = createManager();
      await expect(manager.stop('any')).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      });
    });

    it('start throws NOT_SUPPORTED', async () => {
      const manager = createManager();
      await expect(manager.start('any')).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      });
    });

    it('refreshFirewall is a no-op and does not throw', async () => {
      const manager = createManager();
      await expect(manager.refreshFirewall('any', 'iptables ...')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // execStreaming — log polling behaviour
  // -------------------------------------------------------------------------

  describe('execStreaming', () => {
    it('returns stdout/stderr streams and an exitCode promise', async () => {
      mockExecuteCommand.mockResolvedValue({ webSocketUri: 'ws://...' });
      mockListLogs.mockResolvedValue({ content: '' });
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Running' } } }],
      });

      const manager = createManager();
      const result = await manager.execStreaming('autopod-sess-1', ['echo', 'hello']);

      expect(result.stdout).toBeDefined();
      expect(result.stderr).toBeDefined();
      expect(result.exitCode).toBeInstanceOf(Promise);
      expect(typeof result.kill).toBe('function');

      await result.kill();
    });

    it('streams new log content to stdout', async () => {
      vi.useFakeTimers();

      mockExecuteCommand.mockResolvedValue({ webSocketUri: 'ws://...' });

      let callCount = 0;
      mockListLogs.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { content: '' };
        if (callCount === 2) return { content: 'line one\n' };
        return { content: 'line one\nEXIT_CODE=0\n' };
      });
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Running' } } }],
      });

      const manager = createManager();
      const result = await manager.execStreaming('autopod-sess-1', ['run-task']);

      const chunks: string[] = [];
      result.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      const exitCode = await result.exitCode;
      expect(exitCode).toBe(0);
      expect(chunks.join('')).toContain('line one');
    });

    it('resolves exitCode=1 when container stops without exit marker', async () => {
      vi.useFakeTimers();

      mockExecuteCommand.mockResolvedValue({ webSocketUri: 'ws://...' });
      mockListLogs.mockResolvedValue({ content: '' });
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Terminated' } } }],
      });

      const manager = createManager();
      const result = await manager.execStreaming('autopod-sess-1', ['crash']);

      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      const exitCode = await result.exitCode;
      expect(exitCode).toBe(1);
    });

    it('kill() aborts polling and removes poll tracking', async () => {
      mockExecuteCommand.mockResolvedValue({ webSocketUri: 'ws://...' });
      mockListLogs.mockResolvedValue({ content: '' });
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Running' } } }],
      });

      const manager = createManager();
      const result = await manager.execStreaming('autopod-sess-1', ['long-task']);

      await expect(result.kill()).resolves.toBeUndefined();

      expect(
        (manager as unknown as { activePolls: Map<string, unknown> }).activePolls.has(
          'autopod-sess-1',
        ),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // reconnectLogStream
  // -------------------------------------------------------------------------

  describe('reconnectLogStream', () => {
    it('returns a streaming result with stdout/stderr/kill', async () => {
      vi.useFakeTimers();

      mockListLogs.mockResolvedValue({ content: '' });
      mockGet.mockResolvedValue({
        containers: [{ instanceView: { currentState: { state: 'Terminated' } } }],
      });

      const manager = createManager();
      const result = await manager.reconnectLogStream('autopod-sess-1');

      expect(result.stdout).toBeDefined();
      expect(result.stderr).toBeDefined();
      expect(typeof result.kill).toBe('function');

      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      await result.kill();
    });
  });
});
