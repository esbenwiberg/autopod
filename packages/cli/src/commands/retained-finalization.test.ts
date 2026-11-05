import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import {
  finalizationReceipt,
  finalizationRequest,
  finalizationView,
} from '../test-utils/retained-finalization.js';
import { registerPodCommands } from './pod.js';
import { registerRetainedFinalizationCommand } from './retained-finalization.js';

const client = {
  listSessions: vi.fn(),
  inspectRetainedFinalization: vi.fn(),
  finalizeRetained: vi.fn(),
};
const getClient = vi.fn(() => client as unknown as AutopodClient);
const request = finalizationRequest();
const fields: Record<string, string> = {
  '--request-key': request.requestKey,
  '--generation': String(request.expectedGeneration),
  '--binding': request.expectedBinding,
  '--reason': request.reason,
};
const fieldArgs = (values = fields) => Object.entries(values).flat();
async function run(args: string[] = [], json = true, id = 'retained-pod') {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerRetainedFinalizationCommand(program, getClient);
  return program.parseAsync(['finalize-retained', id, ...args, ...(json ? ['--json'] : [])], {
    from: 'user',
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  getClient.mockReturnValue(client as unknown as AutopodClient);
  client.inspectRetainedFinalization.mockResolvedValue(finalizationView());
  client.finalizeRetained.mockResolvedValue(finalizationReceipt());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe('finalize-retained', () => {
  it('is registered with the pod commands', () => {
    const program = new Command();
    registerPodCommands(program, getClient);
    expect(program.commands.some((command) => command.name() === 'finalize-retained')).toBe(true);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('defaults to read-only inspection and clean JSON', async () => {
    await run();
    expect(client.inspectRetainedFinalization).toHaveBeenCalledExactlyOnceWith('retained-pod');
    expect(client.finalizeRetained).not.toHaveBeenCalled();
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(
      `${JSON.stringify(finalizationView(), null, 2)}\n`,
    );
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each(['stop-retain', 'complete-merged'] as const)(
    'submits %s with only the exact supplied body',
    async (mode) => {
      const receipt = finalizationReceipt('pending', { ...request, mode });
      client.finalizeRetained.mockResolvedValue(receipt);
      await run(['--apply', `--${mode}`, ...fieldArgs()]);
      expect(client.finalizeRetained).toHaveBeenCalledExactlyOnceWith('retained-pod', {
        ...request,
        mode,
      });
      expect(client.inspectRetainedFinalization).not.toHaveBeenCalled();
      expect(client.listSessions).not.toHaveBeenCalled();
      expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      expect(console.log).not.toHaveBeenCalled();
    },
  );

  const malformed: Array<[string, string]> = [
    ...Object.keys(fields).map((flag): [string, string] => [flag, '']),
    ['--request-key', 'with space'],
    ['--request-key', 'with_underscore'],
    ['--request-key', 'a'.repeat(65)],
    ['--request-key', 'é'],
    ...['0', '-1', '1.5', 'NaN', 'Infinity', '1e2', ' 2', '02', '9007199254740992'].map(
      (value): [string, string] => ['--generation', value],
    ),
    ['--binding', 'a'.repeat(63)],
    ['--binding', 'a'.repeat(65)],
    ['--binding', 'g'.repeat(64)],
    ['--binding', 'A'.repeat(64)],
    ['--reason', 'short'],
    ['--reason', ' '.repeat(10)],
    ['--reason', 'x'.repeat(4001)],
  ];
  it.each(malformed)(
    'rejects malformed %s=%j before even resolving a short ID',
    async (flag, value) => {
      await expect(
        run(['--apply', '--stop-retain', ...fieldArgs({ ...fields, [flag]: value })], true, 'ret'),
      ).rejects.toThrow();
      expect(getClient).not.toHaveBeenCalled();
      for (const call of Object.values(client)) expect(call).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(fields))('requires %s on apply', async (missing) => {
    const values = { ...fields };
    delete values[missing];
    await expect(
      run(['--apply', '--stop-retain', ...fieldArgs(values)], true, 'ret'),
    ).rejects.toThrow();
    expect(getClient).not.toHaveBeenCalled();
  });

  it.each([
    ['--apply'],
    ['--apply', ...fieldArgs()],
    ['--apply', '--stop-retain', '--complete-merged', ...fieldArgs()],
    ['--stop-retain'],
    ['--complete-merged'],
    ...Object.entries(fields).flatMap(([flag, value]) => [
      [flag, value],
      [flag, ''],
    ]),
    ['--apply', '--stop-retain', ...fieldArgs(), '--actor', 'operator'],
    ...Object.keys(fields).map((flag) => ['--apply', '--stop-retain', flag]),
  ])('rejects missing apply/conflicting/missing-value/unknown options: %j', async (...args) => {
    await expect(run(args, true, 'ret')).rejects.toThrow();
    expect(getClient).not.toHaveBeenCalled();
    for (const call of Object.values(client)) expect(call).not.toHaveBeenCalled();
  });

  it('resolves an abbreviated ID only after valid selection', async () => {
    client.listSessions.mockResolvedValue([{ id: 'retained-pod' }]);
    await run(['--apply', '--stop-retain', ...fieldArgs()], true, 'ret');
    expect(client.listSessions).toHaveBeenCalledTimes(1);
    expect(client.finalizeRetained).toHaveBeenCalledExactlyOnceWith('retained-pod', request);
    expect(client.inspectRetainedFinalization).not.toHaveBeenCalled();
  });

  it('replays only on a new manual invocation with the identical request', async () => {
    const args = ['--apply', '--stop-retain', ...fieldArgs()];
    client.finalizeRetained.mockRejectedValueOnce(new Error('Connection lost after submit'));
    await expect(run(args)).rejects.toThrow('Connection lost after submit');
    expect(client.finalizeRetained).toHaveBeenCalledTimes(1);
    expect(process.stdout.write).not.toHaveBeenCalled();
    await run(args);
    expect(client.finalizeRetained.mock.calls).toEqual([
      ['retained-pod', request],
      ['retained-pod', request],
    ]);
    expect(client.inspectRetainedFinalization).not.toHaveBeenCalled();
  });

  it('surfaces daemon refusal with no success output or fallback', async () => {
    client.finalizeRetained.mockRejectedValueOnce(
      new Error('Active execution; finalization refused'),
    );
    await expect(run(['--apply', '--complete-merged', ...fieldArgs()], false)).rejects.toThrow(
      'Active execution',
    );
    expect(client.finalizeRetained).toHaveBeenCalledTimes(1);
    expect(client.inspectRetainedFinalization).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each(['pending', 'finalized'] as const)(
    'renders authoritative %s without claiming a different outcome',
    async (state) => {
      client.finalizeRetained.mockResolvedValue(finalizationReceipt(state));
      await run(['--apply', '--stop-retain', ...fieldArgs()], false);
      const output = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(output).toContain(`retained-pod: ${state} (stop-retain)`);
      expect(output).toContain('Resources remain retained');
      expect(output).toContain('source-recovery owners may remain held');
      expect(output).toContain('replay manually with the same key and identical body');
      expect(output).toContain(
        state === 'pending' ? 'Pending is not finalized' : 'does not claim completed delivery',
      );
      expect(output).not.toContain('External merged delivery finalized');
    },
  );

  it('distinguishes externally merged finalization from a merge request', async () => {
    client.finalizeRetained.mockResolvedValue(
      finalizationReceipt('finalized', { ...request, mode: 'complete-merged' }),
    );
    await run(['--apply', '--complete-merged', ...fieldArgs()], false);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      'External merged delivery finalized by the daemon; no merge was requested.',
    );
  });

  it('explains inspection blockers, custody, and an existing pending operation', async () => {
    client.inspectRetainedFinalization.mockResolvedValue({
      ...finalizationView(),
      operation: finalizationReceipt(),
    });
    await run([], false);
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('read-only inspection');
    expect(output).toContain(`Binding: ${request.expectedBinding}`);
    expect(output).toContain('Blocked: External merge proof required');
    expect(output).toContain('Custody: continuation held-owner');
    expect(output).toContain('Pending is not finalized');
    expect(client.finalizeRetained).not.toHaveBeenCalled();
  });
});
