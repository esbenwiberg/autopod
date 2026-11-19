import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerRewriteAbandonmentCommand } from './approval-rewrite-abandonment.js';

function fixture() {
  const client = {
    getRewriteAbandonment: vi.fn(async () => ({ binding: 'a'.repeat(64) })),
    abandonRewrite: vi.fn(async () => ({ podDeleted: true })),
  };
  const program = new Command();
  program.exitOverride();
  registerRewriteAbandonmentCommand(program, () => client as unknown as AutopodClient);
  return {
    client,
    run: (args: string[]) =>
      program.parseAsync(['abandon-rewrite', 'exact-pod-id', ...args, '--json'], { from: 'user' }),
  };
}
const apply = [
  '--apply',
  '--request-id',
  'human-request',
  '--generation',
  '2',
  '--binding',
  'a'.repeat(64),
  '--reason',
  'Discard this exact rewrite and its reports',
  '--acknowledge-data-loss',
];
describe('abandon-rewrite CLI', () => {
  it('inspects without inferring a deletion selection', async () => {
    const f = fixture();
    await f.run([]);
    expect(f.client.getRewriteAbandonment).toHaveBeenCalledWith('exact-pod-id');
    expect(f.client.abandonRewrite).not.toHaveBeenCalled();
  });
  it('submits the exact explicit request once without preview or fallback', async () => {
    const f = fixture();
    await f.run(apply);
    expect(f.client.getRewriteAbandonment).not.toHaveBeenCalled();
    expect(f.client.abandonRewrite).toHaveBeenCalledExactlyOnceWith('exact-pod-id', {
      id: 'human-request',
      expectedGeneration: 2,
      expectedBinding: 'a'.repeat(64),
      reason: 'Discard this exact rewrite and its reports',
      acknowledgeDataLoss: true,
    });
  });
  it.each([
    '--apply',
    '--acknowledge-data-loss',
    '--generation',
    '--binding',
  ])('rejects incomplete %s before any API call', async (flag) => {
    const f = fixture();
    const args = [...apply];
    const i = args.indexOf(flag);
    args.splice(i, flag === '--generation' || flag === '--binding' ? 2 : 1);
    await expect(f.run(args)).rejects.toThrow('Apply requires');
    expect(f.client.abandonRewrite).not.toHaveBeenCalled();
    expect(f.client.getRewriteAbandonment).not.toHaveBeenCalled();
  });
});
