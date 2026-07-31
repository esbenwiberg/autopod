import type { PodsitterConfiguration, PodsitterDecisionRecord } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient, PodsitterStatusResponse } from '../api/client.js';
import { registerPodsitterCommands } from './podsitter.js';

const configuration: PodsitterConfiguration = {
  enabled: false,
  activation: { mode: 'always' },
  authorizedUntil: null,
  generation: 3,
  profileScope: null,
  decisionTarget: {
    providerAccountId: 'dedicated-codex',
    runtime: 'codex',
    model: 'gpt-5.2-codex',
  },
  budgets: { maxDecisionsPerWindow: 20, maxActionsPerWindow: 10 },
  updatedBy: { type: 'human', userId: 'operator' },
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

const status: PodsitterStatusResponse = {
  configuration,
  activation: {
    active: false,
    windowId: null,
    windowStartedAt: null,
    windowEndsAt: null,
    reason: 'disabled',
  },
  provider: {
    providerAccountId: 'dedicated-codex',
    status: 'quota_exhausted',
    consecutiveFailures: 2,
    retryAt: '2026-08-01T00:00:00.000Z',
    resetAt: null,
    sanitizedReason: 'Provider capacity is limited',
    probeLeaseOwner: null,
    probeLeaseVersion: 0,
    probeLeaseExpiresAt: null,
    recoveredAt: null,
    updatedAt: '2026-07-31T00:00:00.000Z',
  },
  queueCount: 4,
};

const decision: PodsitterDecisionRecord = {
  id: 'decision-1',
  attentionId: 'attention-1',
  podId: 'uptight-eel',
  attentionSignature: 'signature',
  configurationGeneration: 3,
  activationWindowId: 'always:3',
  evidenceHash: 'hash',
  evidenceVersion: 1,
  target: {
    providerAccountId: 'SENSITIVE_HISTORY_ACCOUNT',
    runtime: 'codex',
    model: 'SENSITIVE_HISTORY_MODEL',
  },
  decision: {
    contractVersion: 1,
    attentionSignature: 'signature',
    action: 'report',
    arguments: { message: 'SENSITIVE_ARGUMENT_VALUE' },
    reason: 'SENSITIVE_REASON_VALUE',
    evidenceRefs: ['SENSITIVE_EVIDENCE_REFERENCE'],
    confidence: 'medium',
    remainingRisk: 'SENSITIVE_REMAINING_RISK',
    stopCondition: 'SENSITIVE_STOP_CONDITION',
  },
  outcome: 'completed',
  failureCode: null,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: null,
  createdAt: '2026-07-31T01:00:00.000Z',
  completedAt: '2026-07-31T01:01:00.000Z',
  executedAt: null,
};

function createProgram(client: Partial<AutopodClient>): Command {
  const program = new Command();
  program.exitOverride();
  registerPodsitterCommands(program, () => client as AutopodClient);
  return program;
}

async function run(client: Partial<AutopodClient>, args: string[]): Promise<void> {
  await createProgram(client).parseAsync(['node', 'ap', 'podsitter', ...args]);
}

describe('podsitter command', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('controls only daemon Podsitter APIs', async () => {
    const getPodsitterStatus = vi.fn(async () => status);
    const updatePodsitterConfiguration = vi.fn(async (request) => ({
      ...configuration,
      ...request,
      decisionTarget: request.decisionTarget,
    }));
    const disablePodsitter = vi.fn(async () => ({ ...configuration, enabled: false }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = {
      getPodsitterStatus,
      updatePodsitterConfiguration,
      disablePodsitter,
    };

    await run(client, [
      'configure',
      '--account',
      'account-2',
      '--runtime',
      'claude',
      '--model',
      'claude-opus-4-1',
    ]);
    expect(updatePodsitterConfiguration).toHaveBeenLastCalledWith({
      enabled: false,
      activation: { mode: 'always' },
      authorizedUntil: null,
      profileScope: null,
      budgets: configuration.budgets,
      decisionTarget: {
        providerAccountId: 'account-2',
        runtime: 'claude',
        model: 'claude-opus-4-1',
      },
    });

    await run(client, ['off']);
    expect(disablePodsitter).toHaveBeenCalledOnce();
    expect(Object.keys(client)).toEqual([
      'getPodsitterStatus',
      'updatePodsitterConfiguration',
      'disablePodsitter',
    ]);
  });

  it('validates always recurring duration timezone and expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T18:00:00.000Z'));
    const getPodsitterStatus = vi.fn(async () => status);
    const updatePodsitterConfiguration = vi.fn(async (request) => ({
      ...configuration,
      ...request,
    }));
    const client = { getPodsitterStatus, updatePodsitterConfiguration };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(client, ['on', '--always', '--until', '12h']);
    expect(updatePodsitterConfiguration).toHaveBeenLastCalledWith({
      enabled: true,
      activation: { mode: 'always' },
      authorizedUntil: '2026-08-01T06:00:00.000Z',
      profileScope: null,
      decisionTarget: configuration.decisionTarget,
      budgets: configuration.budgets,
    });

    await run(client, [
      'on',
      '--cron',
      '0 20 * * *',
      '--duration',
      '12h',
      '--timezone',
      'Europe/Copenhagen',
      '--until',
      '2026-08-07T20:00:00+02:00',
    ]);
    expect(updatePodsitterConfiguration).toHaveBeenLastCalledWith({
      enabled: true,
      activation: {
        mode: 'recurring',
        cronExpression: '0 20 * * *',
        durationMinutes: 720,
        timeZone: 'Europe/Copenhagen',
      },
      authorizedUntil: '2026-08-07T18:00:00.000Z',
      profileScope: null,
      decisionTarget: configuration.decisionTarget,
      budgets: configuration.budgets,
    });

    await expect(run(client, ['on'])).rejects.toThrow('Exactly one');
    await expect(run(client, ['on', '--always', '--cron', '* * * * *'])).rejects.toThrow(
      'Exactly one',
    );
    await expect(run(client, ['on', '--cron', '0 20 * * *'])).rejects.toThrow(
      'requires --duration and --timezone',
    );
    await expect(
      run(client, [
        'on',
        '--cron',
        '0 20 * * *',
        '--duration',
        'half-day',
        '--timezone',
        'Europe/Copenhagen',
      ]),
    ).rejects.toThrow('Invalid duration');
    await expect(
      run(client, [
        'on',
        '--cron',
        '0 20 * * *',
        '--duration',
        '12h',
        '--timezone',
        'Mars/Olympus',
      ]),
    ).rejects.toThrow('Invalid IANA timezone');
    await expect(run(client, ['on', '--always', '--until', 'tomorrow-ish'])).rejects.toThrow(
      'Invalid expiry',
    );
  });

  it('renders redacted provider status and decisions', async () => {
    const getPodsitterStatus = vi.fn(async () => status);
    const listPodsitterDecisions = vi.fn(async () => ({ items: [decision], total: 51 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const client = { getPodsitterStatus, listPodsitterDecisions };

    await run(client, ['status']);
    const text = log.mock.calls.flat().join('\n');
    expect(text).toContain('Daemon-native Podsitter');
    expect(text).toContain('quota_exhausted');
    expect(text).toContain('2026-08-01T00:00:00.000Z');
    expect(text).toContain('Pending:');
    expect(text).toContain('report (completed)');
    expect(text).not.toContain('raw prompt');
    expect(text).not.toContain('credential');

    await run(client, ['status', '--json']);
    const json = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    expect(json.providerCircuit.status).toBe('quota_exhausted');
    expect(json.lastAction.id).toBe('decision-1');
    expect(json.lastAction).toEqual({
      id: 'decision-1',
      podId: 'uptight-eel',
      action: 'report',
      outcome: 'completed',
      confidence: 'medium',
      evidenceRefCount: 1,
      createdAt: '2026-07-31T01:00:00.000Z',
      completedAt: '2026-07-31T01:01:00.000Z',
      executedAt: null,
    });
    expect(listPodsitterDecisions).toHaveBeenCalledWith({ limit: 1, offset: 0 });

    log.mockClear();
    await run(client, ['decisions', '--pod', 'uptight-eel', '--limit', '25', '--offset', '50']);
    expect(listPodsitterDecisions).toHaveBeenLastCalledWith({
      podId: 'uptight-eel',
      limit: 25,
      offset: 50,
    });
    const decisionText = log.mock.calls.flat().join('\n');
    expect(decisionText).toContain('Evidence references: 1');
    expect(decisionText).toContain('Showing 1 of 51');

    await run(client, [
      'decisions',
      '--pod',
      'uptight-eel',
      '--limit',
      '25',
      '--offset',
      '50',
      '--json',
    ]);
    const decisionJson = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    expect(decisionJson.items[0]).toEqual(json.lastAction);

    const allOutput = `${log.mock.calls.flat().join('\n')}\n${write.mock.calls
      .map((call) => String(call[0]))
      .join('\n')}`;
    for (const sensitiveValue of [
      'SENSITIVE_HISTORY_ACCOUNT',
      'SENSITIVE_HISTORY_MODEL',
      'SENSITIVE_ARGUMENT_VALUE',
      'SENSITIVE_REASON_VALUE',
      'SENSITIVE_EVIDENCE_REFERENCE',
      'SENSITIVE_REMAINING_RISK',
      'SENSITIVE_STOP_CONDITION',
    ]) {
      expect(allOutput).not.toContain(sensitiveValue);
    }
  });

  it('reports inactive checks and provider probe outcomes', async () => {
    const getPodsitterStatus = vi.fn(async () => status);
    const checkPodsitter = vi.fn(async () => ({ queued: 3, processed: 0 }));
    const probePodsitterProvider = vi.fn(async () => ({ recovered: false }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = { getPodsitterStatus, checkPodsitter, probePodsitterProvider };

    await run(client, ['check']);
    expect(log.mock.calls.flat().join('\n')).toContain('Read-only check');
    expect(checkPodsitter).toHaveBeenCalledOnce();

    log.mockClear();
    await run(client, ['probe']);
    expect(log.mock.calls.flat().join('\n')).toContain('without recovery');
  });

  it('preserves daemon provider-account errors', async () => {
    const error = new AutopodError(
      'Runtime "claude" is incompatible with dedicated provider "openai"',
      'PODSITTER_ACCOUNT_INCOMPATIBLE',
      400,
    );
    const client = {
      getPodsitterStatus: vi.fn(async () => status),
      updatePodsitterConfiguration: vi.fn(async () => {
        throw error;
      }),
    };

    await expect(
      run(client, [
        'configure',
        '--account',
        'openai-account',
        '--runtime',
        'claude',
        '--model',
        'claude-opus-4-1',
      ]),
    ).rejects.toBe(error);
  });
});
