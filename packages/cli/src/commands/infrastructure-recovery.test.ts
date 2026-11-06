import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerInfrastructureRecoveryCommand } from './infrastructure-recovery.js';

const client = {
  getCheckpointRecoveries: vi.fn(async () => ({ operations: [] })),
  previewRetainedExecution: vi.fn(async () => ({ digest: 'd'.repeat(64) })),
  recoverInfrastructure: vi.fn(async () => ({ operation: { id: 'stable-request' } })),
};
const getClient = vi.fn(() => client as unknown as AutopodClient);
const root = mkdtempSync(path.join(os.tmpdir(), 'infrastructure-cli-'));
const request = path.join(root, 'request.json');
const input = {
  id: 'stable-request',
  mode: 'checks',
  qualification: 'Explicit diagnosis, not a passing check',
  checkpointHead: 'a'.repeat(40),
  expectedGeneration: 1,
  expectedResultHash: 'b'.repeat(64),
  reason: 'Inspect and preserve the original failed work',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  writeFileSync(request, JSON.stringify(input));
});
afterEach(() => vi.restoreAllMocks());
async function run(...args: string[]) {
  const command = new Command().exitOverride();
  registerInfrastructureRecoveryCommand(command, getClient);
  return command.parseAsync(['recover-infrastructure', 'retained-pod', ...args, '--json'], {
    from: 'user',
  });
}
describe('preservation-safe infrastructure recovery CLI', () => {
  it('only inspects by default', async () => {
    await run();
    expect(client.getCheckpointRecoveries).toHaveBeenCalledWith('retained-pod');
    expect(client.recoverInfrastructure).not.toHaveBeenCalled();
  });
  it('previews separately from admission', async () => {
    await run('--preview-execution', 'qualified');
    expect(client.previewRetainedExecution).toHaveBeenCalledWith('retained-pod', 'qualified');
    expect(client.recoverInfrastructure).not.toHaveBeenCalled();
  });
  it.each([false, true])('submits the saved exact request (reconcile=%s)', async (reconcile) => {
    await run(reconcile ? '--reconcile' : '--apply', '--request', request);
    expect(client.recoverInfrastructure).toHaveBeenCalledWith('retained-pod', input, reconcile);
  });
  it.each([
    ['--apply'],
    ['--request', request],
    ['--apply', '--reconcile', '--request', request],
    ['--preview-execution', 'qualified', '--apply', '--request', request],
  ])('refuses ambiguous or incomplete authority %s', async (...args) => {
    await expect(run(...args)).rejects.toThrow();
    expect(getClient).not.toHaveBeenCalled();
  });
  it.each([
    'null',
    '[]',
    '"not an object"',
  ])('refuses non-object JSON %s rather than silently inspecting', async (content) => {
    writeFileSync(request, content);
    await expect(run('--apply', '--request', request)).rejects.toThrow('JSON object');
    expect(getClient).not.toHaveBeenCalled();
  });
  it('bounds request files before contacting the daemon', async () => {
    writeFileSync(request, 'x'.repeat(131073));
    await expect(run('--apply', '--request', request)).rejects.toThrow('128 KiB');
    expect(getClient).not.toHaveBeenCalled();
  });
});
// Only this test-owned temporary directory is removed.
afterAll(() => rmSync(root, { recursive: true, force: true }));
