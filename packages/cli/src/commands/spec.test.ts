import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSpecCommands } from './spec.js';

const contractYaml = `contract_version: 1
title: "Check spec parser"
depends_on: []
scenarios:
  - id: parses-series
    given:
      - "a contract-backed brief folder exists"
    when:
      - "the local spec checker runs"
    then:
      - "the shared parser accepts the series"
required_facts:
  - id: fact-parses-series
    proves:
      - parses-series
    kind: unit-test
    artifact:
      path: packages/cli/src/commands/spec.test.ts
      change: create
    command: npx pnpm --filter @autopod/cli test -- spec.test.ts
human_review: []
`;

describe('spec command', () => {
  const created: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parse-checks a contract-backed series folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopod-spec-'));
    created.push(root);
    const briefDir = join(root, 'briefs', '01-check-parser');
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(root, 'purpose.md'), 'Keep spec contracts parseable.');
    writeFileSync(join(root, 'design.md'), 'Use the shared parser.');
    writeFileSync(join(briefDir, 'brief.md'), '## Task\nCheck the parser.');
    writeFileSync(join(briefDir, 'contract.yaml'), contractYaml);

    const program = new Command();
    program.exitOverride();
    registerSpecCommands(program);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'spec', 'check', root]);

    expect(logSpy).toHaveBeenCalledWith('Spec OK: 1 briefs, 1 facts');
  });

  it('accepts contract.yml in a single-pod spec folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopod-spec-'));
    created.push(root);
    writeFileSync(join(root, 'brief.md'), '## Task\nCheck the parser.');
    writeFileSync(join(root, 'contract.yml'), contractYaml);

    const program = new Command();
    program.exitOverride();
    registerSpecCommands(program);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'spec', 'check', root]);

    expect(logSpy).toHaveBeenCalledWith('Spec OK: 1 brief, 1 facts');
  });

  it('rejects an unknown series dependency locally with repair guidance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopod-spec-'));
    created.push(root);
    const briefDir = join(root, 'briefs', 'api');
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, 'brief.md'), '## Task\nBuild the API.');
    writeFileSync(
      join(briefDir, 'contract.yaml'),
      contractYaml.replace('depends_on: []', 'depends_on: [missing-core]'),
    );

    const program = new Command();
    program.exitOverride();
    registerSpecCommands(program);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit(1)');
    }) as never);

    await expect(program.parseAsync(['node', 'ap', 'spec', 'check', root])).rejects.toThrow(
      'process.exit(1)',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'Spec check failed: Brief "Check spec parser" (folder "api") depends on unknown brief ' +
        'folder "missing-core". Use a depends_on value that exactly matches a sibling brief folder.',
    );
  });
});
