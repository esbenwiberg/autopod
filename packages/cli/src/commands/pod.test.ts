import { createServer } from 'node:http';
import { AutopodError } from '@autopod/shared';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
import { registerPodCommands } from './pod.js';

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}));

function createMockClient() {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    getTaskExecution: vi.fn().mockRejectedValue(new Error('Unavailable on older daemon')),
    getSession: vi.fn().mockResolvedValue({
      id: 'abcd1234',
      profileName: 'test',
      task: 'do things',
      status: 'validated',
      model: 'opus',
      runtime: 'claude',
      branch: 'ap/abcd1234',
      containerId: 'ctr1',
      worktreePath: null,
      validationAttempts: 1,
      maxValidationAttempts: 3,
      lastValidationResult: null,
      pendingEscalation: null,
      escalationCount: 0,
      skipValidation: false,
      createdAt: '2024-01-01T00:00:00Z',
      startedAt: '2024-01-01T00:00:01Z',
      completedAt: null,
      updatedAt: '2024-01-01T00:00:01Z',
      userId: 'user1',
      filesChanged: 5,
      linesAdded: 100,
      linesRemoved: 20,
      previewUrl: null,
      readinessReview: null,
    }),
    getSessionEvents: vi.fn().mockResolvedValue([
      {
        type: 'status',
        timestamp: '2026-06-02T08:00:00.000Z',
        message: 'Creating worktree...',
      },
    ]),
    getFirewallDenials: vi.fn().mockResolvedValue([]),
    getSessionLogs: vi.fn().mockResolvedValue('build log output'),
    updateFromBase: vi.fn().mockResolvedValue({ ok: true, action: 'queued_after_abort' }),
    continueProvider: vi.fn().mockResolvedValue({ ok: true, action: 'same-provider' }),
  } as unknown as AutopodClient;
}

describe('continue-provider command', () => {
  let program: Command;
  let mockClient: AutopodClient;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerPodCommands(program, () => mockClient);
  });

  it('requests explicit profile-primary recovery', async () => {
    (mockClient.continueProvider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      action: 'primary-provider',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'continue-provider', 'positive-urial', '--primary']);

    expect(mockClient.continueProvider).toHaveBeenCalledWith('positive-urial', {
      primary: true,
    });
    expect(logSpy).toHaveBeenCalledWith(
      'Pod positive-urial queued on its profile primary provider.',
    );
    logSpy.mockRestore();
  });

  it('preserves paused provider-limit continuation', async () => {
    await program.parseAsync(['node', 'ap', 'continue-provider', 'positive-urial']);

    expect(mockClient.continueProvider).toHaveBeenCalledWith('positive-urial', {
      primary: undefined,
    });
  });
});

it('shows compact evidence omissions through the actual HTTP client and CLI command', async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify([
        {
          id: 'bounded-list',
          profileName: 'test',
          status: 'complete',
          title: 'Preserved work',
          startedAt: null,
          completedAt: null,
          recordDiagnostics: [{ field: 'task_summary', code: 'size_limit' }],
        },
      ]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const client = new AutopodClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getToken: async () => 'local-fixture-only',
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const program = new Command();
    registerPodCommands(program, () => client);
    await program.parseAsync(['node', 'ap', 'ls', '--compact', '--limit', '10']);
    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Preserved work');
    expect(output).toContain(
      'bounded-list: Evidence unavailable in this view: task_summary (size_limit)',
    );
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error('CLI did not send its list request');
    const url = new URL(request.slice(4), 'http://localhost');
    expect(url.pathname).toBe('/pods');
    expect(url.searchParams.get('compact')).toBe('true');
    expect(url.searchParams.get('limit')).toBe('10');
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('ls command', () => {
  let program: Command;
  let mockClient: AutopodClient;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerPodCommands(program, () => mockClient);
  });

  it('ls since forwards a duration filter as an ISO timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-08T00:00:00.000Z'));
    try {
      await program.parseAsync(['node', 'ap', 'ls', '--since', '7d']);
      expect(mockClient.listSessions).toHaveBeenCalledWith({
        status: undefined,
        profile: undefined,
        limit: undefined,
        since: '2026-02-01T00:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints settled worker evidence without treating pending input as completion', async () => {
    const baseline = await mockClient.getSession('abcd1234');
    vi.mocked(mockClient.getSession).mockResolvedValueOnce({
      ...baseline,
      status: 'awaiting_input',
      finalization: {
        generation: 1,
        cycle: 1,
        phase: 'awaiting_human',
        agentSettledAt: '2026-09-07T08:00:00Z',
        pendingDecisionId: 'selection',
        sourcePreservedAt: null,
        result: 'Report collected',
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['node', 'ap', 'status', 'abcd1234']);
      const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('Agent settled:');
      expect(output).toContain('not verified');
      expect(output).toContain('Human decision remains unanswered');
    } finally {
      log.mockRestore();
    }
  });

  it('rejects unsupported status before listing pods', async () => {
    await expect(program.parseAsync(['node', 'ap', 'ls', '--status', 'blocked'])).rejects.toThrow(
      /Unsupported pod status: blocked.*Supported statuses:/,
    );
    expect(mockClient.listSessions).not.toHaveBeenCalled();
  });

  it('rejects malformed ISO since values before listing pods', async () => {
    await expect(program.parseAsync(['node', 'ap', 'ls', '--since', '2026-02-30'])).rejects.toThrow(
      /since must be a duration/,
    );
    expect(mockClient.listSessions).not.toHaveBeenCalled();
  });
});

describe('update-from-base command', () => {
  let program: Command;
  let mockClient: AutopodClient;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerPodCommands(program, () => mockClient);
  });

  it('registers update-from-base <id>', async () => {
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    expect(mockClient.updateFromBase).toHaveBeenCalledWith('abcd1234');
  });

  it('resolves short ID before calling updateFromBase', async () => {
    const fullId = 'abcd1234';
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: fullId }]);
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd']);
    expect(mockClient.listSessions).toHaveBeenCalled();
    expect(mockClient.updateFromBase).toHaveBeenCalledWith(fullId);
  });

  it('rebased: prints base branch and exits 0', async () => {
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      action: 'rebased',
      baseBranch: 'main',
      validation: 'started',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    expect(logSpy).toHaveBeenCalledWith('Rebased onto main. Validation restarted.');
    logSpy.mockRestore();
  });

  it('queued_after_abort: prints queued message and exits 0', async () => {
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      action: 'queued_after_abort',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    expect(logSpy).toHaveBeenCalledWith(
      'Validation is stopping. Update from base will run before the next validation step.',
    );
    logSpy.mockRestore();
  });

  it('already_up_to_date: prints no validation started and exits 0', async () => {
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      action: 'already_up_to_date',
      baseBranch: 'main',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    expect(logSpy).toHaveBeenCalledWith(
      'Pod abcd1234 already contains latest main. No validation started.',
    );
    logSpy.mockRestore();
  });

  it('INVALID_STATE: AutopodError propagates instead of being swallowed', async () => {
    const daemonError = new AutopodError(
      "Cannot run update-from-base on pod abcd1234 in status 'running'",
      'INVALID_STATE',
      409,
    );
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockRejectedValueOnce(daemonError);
    await expect(program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234'])).rejects.toBe(
      daemonError,
    );
  });

  it('conflict: prints all conflicted files and exits 1', async () => {
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      action: 'conflict',
      baseBranch: 'main',
      conflicts: ['packages/foo/package.json', 'pnpm-lock.yaml'],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    try {
      await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    } catch {
      // process.exit throws in tests
    }
    expect(logSpy).toHaveBeenCalledWith('Rebase conflict while updating from main:');
    expect(logSpy).toHaveBeenCalledWith('  packages/foo/package.json');
    expect(logSpy).toHaveBeenCalledWith('  pnpm-lock.yaml');
    expect(exitSpy).toHaveBeenCalledWith(1);
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints non-follow logs from persisted events', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'logs', 'abcd1234']);

    expect(mockClient.getSessionEvents).toHaveBeenCalledWith('abcd1234');
    expect(mockClient.getFirewallDenials).toHaveBeenCalledWith('abcd1234');
    expect(mockClient.getSessionLogs).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'Creating worktree...',
    );
    logSpy.mockRestore();
  });

  it('prints non-follow firewall denials from persisted events', async () => {
    (mockClient.getSessionEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (mockClient.getFirewallDenials as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        eventId: 283824,
        timestamp: '2026-06-08T07:32:18.686Z',
        sni: 'oraios-software.de',
        src: '172.19.0.2',
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'logs', 'abcd1234']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('[firewall denied]');
    expect(output).toContain('oraios-software.de from 172.19.0.2');
    logSpy.mockRestore();
  });

  it('prints compact readiness when present', async () => {
    (mockClient.getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'abcd1234',
      profileName: 'test',
      task: 'do things',
      status: 'validated',
      model: 'opus',
      runtime: 'claude',
      branch: 'ap/abcd1234',
      containerId: 'ctr1',
      worktreePath: null,
      validationAttempts: 1,
      maxValidationAttempts: 3,
      lastValidationResult: null,
      pendingEscalation: null,
      escalationCount: 0,
      skipValidation: false,
      createdAt: '2024-01-01T00:00:00Z',
      startedAt: '2024-01-01T00:00:01Z',
      completedAt: null,
      updatedAt: '2024-01-01T00:00:01Z',
      userId: 'user1',
      filesChanged: 5,
      linesAdded: 100,
      linesRemoved: 20,
      previewUrl: null,
      readinessReview: {
        status: 'needs_review',
        summary: '2 findings before approval',
        computedAt: '2026-06-07T12:00:00.000Z',
        scope: 'pod',
        areas: [],
        findings: [
          {
            id: 'network-denied-egress',
            area: 'network',
            severity: 'warning',
            title: 'Denied egress observed',
            detail: 'Operator should inspect network events.',
            sourceRefs: [{ kind: 'event', label: 'Network events' }],
          },
        ],
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'status', 'abcd1234']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Readiness: needs_review - 2 findings before approval');
    expect(output).not.toContain('Denied egress observed');
    expect(output).not.toContain('Operator should inspect network events.');
    logSpy.mockRestore();
  });

  it('prints task-wide counts and partial cost without treating attempts as delivered PRs', async () => {
    vi.mocked(mockClient.getTaskExecution).mockResolvedValueOnce({
      taskId: 'logical-root',
      executionId: 'fix-execution',
      rootPodId: 'original',
      podCount: 2,
      agentRunCount: 3,
      failedRunCount: 1,
      transientFailureCount: 0,
      providerAttemptCount: 4,
      validationExecutionCount: 5,
      tokenBudget: 100,
      recordedInputTokens: 90,
      recordedOutputTokens: 10,
      recordedCostUsd: 1.25,
      infrastructureCostUsd: null,
      telemetry: 'partial',
      diagnostics: ['Infrastructure cost unavailable'],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['node', 'ap', 'status', 'abcd1234']);
      const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('logical-root (2 pods)');
      expect(output).toContain('3 recorded agent runs, 4 provider attempts, 5 validations');
      expect(output).toContain('100/100');
      expect(output).toContain('$1.2500 (partial telemetry)');
      expect(output).toContain('Infrastructure cost unavailable');
      expect(output).not.toContain('4 delivered');
    } finally {
      log.mockRestore();
    }
  });

  it('prints readiness pending when missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'status', 'abcd1234']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Readiness: pending/unavailable');
    logSpy.mockRestore();
  });
});

it('status command renders real HTTP delivery accounting and reused evidence, preserving JSON units', async () => {
  const pod = await createMockClient().getSession('abcd1234');
  const evidence = {
    receiptId: 'local-receipt',
    originalExecutedAt: '2026-09-07T10:00:00Z',
    originalDurationMs: 1200,
  };
  const task = {
    taskId: 'logical-root',
    executionId: 'execution-fixture',
    podCount: 2,
    agentRunCount: 3,
    providerAttemptCount: 4,
    validationExecutionCount: 5,
    recordedInputTokens: 90,
    recordedOutputTokens: 10,
    tokenBudget: 100,
    budgetCheck: {
      status: 'unavailable',
      reason: 'Task token accounting incomplete; reconcile prior execution telemetry.',
    },
    recordedCostUsd: 1.25,
    costEvidence: {
      basis: 'stored_subtotal',
      billingVerified: false,
      knownEstimatedCostUsd: 0.5,
      unavailablePhaseCount: 1,
      conflictingPodCount: 1,
      omittedDiagnosticCount: 2,
      diagnostics: [
        {
          podId: 'root',
          code: 'PHASE_COST_CONFLICT',
          message: 'Stored phase costs conflict; no proportional allocation applied.',
        },
      ],
    },
    telemetry: 'partial',
    diagnostics: [],
    delivery: {
      intentCount: 2,
      receiptCount: 1,
      unresolvedCount: 1,
      scope: 'durable-receipts-only',
    },
  };
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    expect(req.method).toBe('GET');
    expect(req.headers.authorization).toBe('Bearer local-fixture-only');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/pods/abcd1234/task-execution') res.end(JSON.stringify(task));
    else if (req.url === '/pods/abcd1234')
      res.end(
        JSON.stringify({
          ...pod,
          lastValidationResult: { overall: 'pass', attempt: 1, test: { reusedEvidence: evidence } },
        }),
      );
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const client = new AutopodClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getToken: async () => 'local-fixture-only',
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const command = () => {
      const program = new Command();
      registerPodCommands(program, () => client);
      return program;
    };
    await command().parseAsync(['node', 'ap', 'status', 'abcd1234']);
    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Stored task cost subtotal:');
    expect(output).toContain('Billing unverified');
    expect(output).toContain(
      'Known estimates: $0.5000; 1 identified phases with unavailable cost; 1 pods with conflicting attribution',
    );
    expect(output).toContain('Stored phase costs conflict; no proportional allocation applied.');
    expect(output).toContain('2 additional cost diagnostics omitted.');
    expect(output).toContain('1 confirmed, 1 unresolved of 2 intents');
    expect(output).toContain('historical URLs excluded');
    expect(output).toContain(
      'Task token accounting incomplete; reconcile prior execution telemetry.',
    );
    expect(output).toContain(
      'test: reused receipt local-receipt; originally executed 2026-09-07T10:00:00Z (1200 ms)',
    );
    log.mockClear();
    await command().parseAsync(['node', 'ap', 'status', 'abcd1234', '--json']);
    const structured = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(''));
    expect(structured.taskExecution.costEvidence).toEqual(task.costEvidence);
    expect(structured.taskExecution.delivery).toEqual(task.delivery);
    expect(paths).toEqual([
      '/pods/abcd1234',
      '/pods/abcd1234/task-execution',
      '/pods/abcd1234',
      '/pods/abcd1234/task-execution',
    ]);
  } finally {
    log.mockRestore();
    stdout.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(['validation', 'sandbox_startup'] as const)(
  'drives %s retry inspection, idempotent authorization and separate Resume through the real HTTP client',
  async (stage) => {
    const calls: Array<{ path: string; method: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      calls.push({ path: request.url ?? '', method: request.method ?? '', body });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          request.url?.includes('retry-state')
            ? {
                taskId: 'task',
                stage,
                executedCount: 3,
                admissionCount: 4,
                backoffsMs: [0, 0],
                transientRetryCount: 2,
                measuredDurationMs: 15,
                interruptedCount: 1,
                latest: { outcome: 'unknown' },
                authorizations: [],
                telemetry: 'partial',
              }
            : request.url?.endsWith('retry-authorizations')
              ? { id: 'grant', ...JSON.parse(body) }
              : request.url?.endsWith('resume')
                ? { ok: true, action: 'revalidate' }
                : { id: 'abcd1234' },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const client = new AutopodClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      getToken: async () => 'fixture-token',
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = async (args: string[]) => {
      const program = new Command();
      program.exitOverride();
      registerPodCommands(program, () => client);
      await program.parseAsync(['node', 'ap', ...args]);
    };
    try {
      await run(['retry-state', 'abcd1234', '--stage', stage]);
      expect(
        calls.some(
          (call) =>
            call.path ===
            `/pods/abcd1234/retry-state${stage === 'validation' ? '' : '?stage=sandbox_startup'}`,
        ),
      ).toBe(true);
      expect(output.mock.calls.flat().join('\n')).toContain('3 executed / 4 admitted');
      await run([
        'authorize-retry',
        '--stage',
        stage,
        'abcd1234',
        '--reason',
        'External condition verified',
        '--request-key',
        'stable-key',
      ]);
      await run([
        'authorize-retry',
        '--stage',
        stage,
        'abcd1234',
        '--reason',
        'External condition verified',
        '--request-key',
        'stable-key',
      ]);
      expect(calls.filter((call) => call.path.endsWith('resume'))).toHaveLength(0);
      const decisions = calls.filter((call) => call.path.endsWith('retry-authorizations'));
      expect(decisions).toHaveLength(2);
      expect(decisions[0]?.body).toBe(decisions[1]?.body);
      expect(JSON.parse(decisions[0]?.body ?? '{}')).toEqual({
        requestKey: 'stable-key',
        reason: 'External condition verified',
        ...(stage === 'validation' ? {} : { stage }),
      });
      await run(['resume', 'abcd1234']);
      expect(calls.filter((call) => call.path.endsWith('resume'))).toHaveLength(1);
      expect(output.mock.calls.flat().join('\n')).toContain('Inspect status and retry-state');
    } finally {
      output.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it('sends the same explicit rerun decision through the actual CLI HTTP client and prints dispatch evidence', async () => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    expect(request.headers.authorization).toBe('Bearer local-fixture-only');
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end(JSON.stringify({ id: 'rerun-id', status: 'queued' }));
    } else if (request.url?.endsWith('rerun-template'))
      response.end(
        JSON.stringify({
          profileName: 'profile',
          task: 'Exact original task',
          contract: { contractVersion: 1 },
        }),
      );
    else if (request.url?.endsWith('dispatch-preflight'))
      response.end(
        JSON.stringify({
          latest: {
            status: 'review_required',
            repository: 'host/repo',
            baseBranch: 'main',
            baseCommitSha: 'a'.repeat(40),
            executionId: 'execution',
            checkedAt: 'today',
            conflicts: [{ podId: 'other', status: 'running', evidence: 'dispatch_receipt' }],
            rerun: null,
          },
        }),
      );
    else response.end(JSON.stringify({ id: 'abcd1234' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const client = new AutopodClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getToken: async () => 'local-fixture-only',
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const command = () => {
    const program = new Command();
    registerPodCommands(program, () => client);
    return program;
  };
  try {
    for (let i = 0; i < 2; i++)
      await command().parseAsync([
        'node',
        'ap',
        'rerun',
        'abcd1234',
        '--reason',
        'Reviewed independent repeat',
        '--request-key',
        'same-key',
      ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({
      intentionalRerun: {
        ofPodId: 'abcd1234',
        reason: 'Reviewed independent repeat',
        requestKey: 'same-key',
      },
    });
    await command().parseAsync(['node', 'ap', 'dispatch-preflight', 'abcd1234']);
    expect(log.mock.calls.flat().join('\n')).toContain('review_required: host/repo main');
    expect(log.mock.calls.flat().join('\n')).toContain('other: running (dispatch_receipt)');
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('reads execution provenance through the real HTTP client without inventing unknown resource or release values', async () => {
  const server = createServer((request, response) => {
    expect(request.method).toBe('GET');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url?.endsWith('execution-provenance')
          ? {
              latest: {
                status: 'blocked',
                purpose: 'validation',
                checkedAt: 'today',
                executionId: 'execution',
                generation: 1,
                runtime: 'codex',
                model: 'fixture',
                cliVersion: '0.144.4',
                release: { commitSha: null },
                imageDigest: null,
                contractHash: 'a'.repeat(64),
                validationImplementationHash: null,
                capabilities: { memoryLimitBytes: null, cpuLimit: null },
                commands: {
                  requirements: [
                    { source: 'fact:compile', executable: 'dotnet', available: false },
                  ],
                },
                diagnostics: [
                  { code: 'PREFLIGHT_COMMAND_UNAVAILABLE', detail: 'Required launcher is missing' },
                ],
              },
            }
          : { id: 'abcd1234' },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const client = new AutopodClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getToken: async () => 'fixture-token',
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const program = new Command();
    registerPodCommands(program, () => client);
    await program.parseAsync(['node', 'ap', 'execution-provenance', 'abcd1234']);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('validation preflight blocked');
    expect(output).toContain('Memory unverified bytes; CPU unverified');
    expect(output).toContain('Daemon unverified; image unverified');
    expect(output).toContain('dotnet missing');
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
