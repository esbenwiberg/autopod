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
  it.each(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.2'])(
    'rejects stale GPT-6.2 images and admits the supported pin for %s', async (model) => {
      for (const version of ['0.160.1', '0.170.9']) {
        await expect(verifyAgentCli(codexAt(version), 'c', 'codex', model)).rejects.toMatchObject({
          code: 'PREFLIGHT_RUNTIME_INCOMPATIBLE',
          message: `Codex CLI ${version} is incompatible with ${model}; Autopod requires 0.171.0 or newer. Rebuild the codex base/warm image.`,
        });
      }
      for (const version of ['0.171.0', '0.172.0', '1.0.0']) {
        await expect(verifyAgentCli(codexAt(version), 'c', 'codex', model)).resolves.toMatchObject({
          cliVersion: version,
        });
      }
    },
  );

  it('retains the existing floor for earlier GPT-6 families', async () => {
    for (const model of ['gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-astra']) {
      await expect(verifyAgentCli(codexAt('0.160.1'), 'c', 'codex', model)).resolves.toMatchObject({
        cliVersion: '0.160.1',
      });
    }
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
    for (const version of ['0.160.1', '0.161.0', '1.0.0'])
      await expect(
        verifyAgentCli(codexAt(version), 'c', 'codex', 'gpt-6-astra'),
      ).resolves.toMatchObject({ cliVersion: version });
  });
});
