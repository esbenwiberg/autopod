import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerArtifactChecksRecoveryCommand } from './artifact-checks-recovery.js';

const client = {
  inspectArtifactChecksRecovery: vi.fn(async () => ({
    selection: null,
    refusal: 'Source unavailable',
  })),
  recoverArtifactChecks: vi.fn(async () => ({
    operation: { id: 'exact-request', events: { stopDispatched: true } },
  })),
};
const getClient = vi.fn(() => client as unknown as AutopodClient);
const root = mkdtempSync(path.join(os.tmpdir(), 'artifact-checks-cli-'));
const request = path.join(root, 'request.json');
const input = {
  id: 'exact-request',
  expectedBindingHash: 'a'.repeat(64),
  reason: 'Check retained existing artifact source',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  writeFileSync(request, JSON.stringify(input));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function run(...args: string[]) {
  const command = new Command().exitOverride();
  registerArtifactChecksRecoveryCommand(command, getClient);
  return command.parseAsync(['recover-artifact-checks', 'synthetic-artifact', ...args, '--json'], {
    from: 'user',
  });
}
describe('checks-only artifact recovery CLI', () => {
  it('only inspects by default and displays a refusal honestly', async () => {
    await run();
    expect(client.inspectArtifactChecksRecovery).toHaveBeenCalledWith('synthetic-artifact');
    expect(client.recoverArtifactChecks).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('Source unavailable'),
    );
  });
  it.each([
    false,
    true,
  ])('preserves the exact saved request for selection/reconciliation (%s)', async (reconcile) => {
    await run(reconcile ? '--reconcile' : '--apply', '--request', request);
    expect(client.recoverArtifactChecks).toHaveBeenCalledExactlyOnceWith(
      'synthetic-artifact',
      input,
      reconcile,
    );
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('stopDispatched'));
  });
  it('does not automatically retry a lost response or generate another request ID', async () => {
    client.recoverArtifactChecks.mockRejectedValueOnce(new Error('Lost response'));
    await expect(run('--apply', '--request', request)).rejects.toThrow('Lost response');
    expect(client.recoverArtifactChecks).toHaveBeenCalledOnce();
  });
  it.each([
    ['--apply'],
    ['--request', request],
    ['--apply', '--reconcile', '--request', request],
  ])('refuses incomplete/ambiguous authority %s', async (...args) => {
    await expect(run(...args)).rejects.toThrow();
    expect(getClient).not.toHaveBeenCalled();
  });
  it.each(['null', '[]', '"string"'])('refuses non-object request %s', async (contents) => {
    writeFileSync(request, contents);
    await expect(run('--apply', '--request', request)).rejects.toThrow('JSON object');
    expect(getClient).not.toHaveBeenCalled();
  });
  it('bounds input before contacting the daemon', async () => {
    writeFileSync(request, 'x'.repeat(131073));
    await expect(run('--apply', '--request', request)).rejects.toThrow('128 KiB');
    expect(getClient).not.toHaveBeenCalled();
  });
});
