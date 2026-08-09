import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightSeriesFolder } from './spec-preflight.js';
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
    expect(errorSpy.mock.calls[0]?.[0]).toContain('Spec check failed:');
    expect(errorSpy.mock.calls[0]?.[0]).toContain('missing-core');
  });

  it('emits every Luumi regression diagnostic in the versioned JSON envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopod-spec-'));
    created.push(root);
    const briefDir = join(root, 'briefs', '01-invalid');
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(join(briefDir, 'brief.md'), '## Task\nInvalid contract.');
    writeFileSync(
      join(briefDir, 'contract.yaml'),
      `contract_version: 1
title: Invalid
depends_on: [missing-brief]
scenarios:
  - id: known
    given: [state]
    when: [action]
    then: [result]
required_facts:
  - id: invalid-change
    proves: []
    kind: unit-test
    artifact: { path: test.ts, change: delete }
    command: npx pnpm test -- test.ts
  - id: long-reference
    proves: [${'x'.repeat(129)}]
    kind: unit-test
    artifact: { path: long.ts, change: create }
    command: npx pnpm test -- long.ts --grep long
  - id: unknown-reference
    proves: [missing]
    kind: unit-test
    artifact: { path: unknown.ts, change: create }
    command: npx pnpm test -- unknown.ts --grep missing
`,
    );
    const program = new Command();
    program.exitOverride();
    registerSpecCommands(program);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit(1)');
    }) as never);

    await expect(
      program.parseAsync(['node', 'ap', 'spec', 'check', root, '--json']),
    ).rejects.toThrow('process.exit(1)');
    const envelope = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(envelope).toMatchObject({ diagnosticsVersion: 1, contractVersion: 1, valid: false });
    expect(envelope.diagnostics.map((item: { code: string }) => item.code)).toEqual(
      expect.arrayContaining([
        'CONTRACT_ARTIFACT_CHANGE_INVALID',
        'CONTRACT_PROVES_EMPTY',
        'CONTRACT_PROVES_ENTRY_TOO_LONG',
        'CONTRACT_UNKNOWN_SCENARIO',
        'SERIES_UNKNOWN_DEPENDENCY',
      ]),
    );
    expect(
      envelope.diagnostics.every(
        (item: { source?: string; path?: string; message?: string; hint?: string }) =>
          item.source && item.path && item.message && item.hint,
      ),
    ).toBe(true);
  });

  it('preflights the tracked canonical scaffold', async () => {
    const program = new Command();
    program.exitOverride();
    registerSpecCommands(program);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node',
      'ap',
      'spec',
      'check',
      resolve(process.cwd(), '../../templates/series-contract-v1'),
      '--json',
    ]);

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      diagnosticsVersion: 1,
      contractVersion: 1,
      valid: true,
      diagnostics: [],
    });
  });

  it('continues to preflight an existing tracked contract series', () => {
    const result = preflightSeriesFolder(resolve(process.cwd(), '../../specs/advisory-browser-qa'));
    expect(result.diagnostics).toEqual([]);
    expect(result.briefs?.length).toBeGreaterThan(0);
  });
});
