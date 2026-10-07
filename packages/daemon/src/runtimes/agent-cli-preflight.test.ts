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
    for (const version of ['0.160.1', '0.161.0', '1.0.0'])
      await expect(
        verifyAgentCli(codexAt(version), 'c', 'codex', 'gpt-6-astra'),
      ).resolves.toMatchObject({ cliVersion: version });
  });
});
