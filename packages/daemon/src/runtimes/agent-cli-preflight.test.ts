import { describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { verifyAgentCli } from './agent-cli-preflight.js';

function codexAt(version: string) {
  const cm = createMockContainerManager();
  cm.execInContainer = vi.fn(async (_id: string, command: string[]) =>
    command.join(' ') === 'codex --version'
      ? { stdout: `codex-cli ${version}\n`, stderr: '', exitCode: 0 }
      : { stdout: '/usr/local/bin/codex\n', stderr: '', exitCode: 0 },
  );
  return cm;
}

describe('verifyAgentCli', () => {
  it.each([
    'gpt-6.2-sol',
    'gpt-6.2-astra',
    'gpt-6.2',
  ])('rejects stale images for %s and admits the supported boundary', async (model) => {
    for (const version of ['0.160.1', '0.170.9']) {
      await expect(verifyAgentCli(codexAt(version), 'c', 'codex', model)).rejects.toMatchObject({
        code: 'PREFLIGHT_RUNTIME_INCOMPATIBLE',
        message: `Codex CLI ${version} is incompatible with ${model}; Autopod requires 0.171.0 or newer. Rebuild the codex base/warm image.`,
      });
    }
    for (const version of ['0.171.0', '0.171.1', '0.172.0', '1.0.0']) {
      await expect(verifyAgentCli(codexAt(version), 'c', 'codex', model)).resolves.toMatchObject({
        cliVersion: version,
      });
    }
  });

  it('includes the GPT-6.2 floor when a version cannot be verified', async () => {
    await expect(verifyAgentCli(codexAt('unknown'), 'c', 'codex', 'gpt-6.2-sol')).rejects.toThrow(
      'Rebuild the codex base/warm image with Codex CLI 0.171.0 or newer',
    );
  });

  it('keeps the general Codex floor for pre-GPT-6 models', async () => {
    for (const model of [undefined, null, 'auto', 'gpt-5.6-sol'])
      await expect(verifyAgentCli(codexAt('0.144.4'), 'c', 'codex', model)).resolves.toMatchObject({
        cliVersion: '0.144.4',
      });
    await expect(verifyAgentCli(codexAt('0.144.3'), 'c', 'codex', 'auto')).rejects.toThrow(
      'requires 0.144.4 or newer',
    );
  });

  it('requires a Codex CLI that knows GPT-6 before a GPT-6 pod spawns', async () => {
    await expect(verifyAgentCli(codexAt('0.144.4'), 'c', 'codex', 'gpt-6.1-sol')).rejects.toThrow(
      'Codex CLI 0.144.4 is incompatible with gpt-6.1-sol; Autopod requires 0.160.1 or newer',
    );
    await expect(verifyAgentCli(codexAt('0.159.9'), 'c', 'codex', 'gpt-6-astra')).rejects.toThrow(
      '0.160.1 or newer',
    );
    for (const model of [
      'gpt-6-sol',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6.1-sol',
      'gpt-6.1-astra',
      'gpt-6.1-terra',
    ])
      for (const version of ['0.160.1', '0.161.0', '1.0.0'])
        await expect(verifyAgentCli(codexAt(version), 'c', 'codex', model)).resolves.toMatchObject({
          cliVersion: version,
        });
  });
});
