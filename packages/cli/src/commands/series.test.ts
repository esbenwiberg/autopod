import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerSeriesCommands } from './series.js';

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}));

const contractYaml = `contract_version: 1
title: "First brief"
depends_on: []
scenarios:
  - id: scenario-cli-series
    given:
      - "a series spec folder exists"
    when:
      - "ap series create parses it"
    then:
      - "the daemon request carries parsed briefs"
required_facts:
  - id: fact-cli-series
    proves:
      - scenario-cli-series
    kind: unit-test
    artifact:
      path: packages/cli/src/commands/series.test.ts
      change: create
    command: npx pnpm --filter @autopod/cli test -- series.test.ts
human_review: []
`;

function createSeriesSpecFolder(contractName = 'contract.yaml'): string {
  const root = mkdtempSync(join(tmpdir(), 'autopod-cli-series-'));
  const briefDir = join(root, 'briefs', '01-first');
  mkdirSync(briefDir, { recursive: true });
  writeFileSync(join(root, 'purpose.md'), 'Ship a small feature.\n');
  writeFileSync(join(root, 'design.md'), 'Keep the design scoped.\n');
  writeFileSync(join(briefDir, 'brief.md'), '## Task\nBuild the first piece.\n');
  writeFileSync(join(briefDir, contractName), contractYaml);
  return root;
}

function createMockClient() {
  return {
    createSeries: vi.fn().mockResolvedValue({
      seriesId: 'series-1',
      seriesName: 'feature',
      pods: [
        {
          id: 'abcd1234',
          task: 'Build the first piece.',
          status: 'queued',
        },
      ],
      tokenUsageSummary: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      statusCounts: { queued: 1 },
    }),
  } as unknown as AutopodClient;
}

describe('series commands', () => {
  let program: Command;
  let mockClient: AutopodClient;
  const createdDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerSeriesCommands(program, () => mockClient);
  });

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes local spec files as runtime context for series creation by default', async () => {
    const specRoot = createSeriesSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync(['node', 'ap', 'series', 'create', specRoot, '--profile', 'test']);

    const call = (mockClient.createSeries as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.briefs).toHaveLength(1);
    expect(call.specFiles).toBeUndefined();
    const outputRoot = `specs/${specRoot.split('/').at(-1)}`;
    expect(call.specContextFiles).toEqual([
      {
        path: `${outputRoot}/briefs/01-first/brief.md`,
        content: '## Task\nBuild the first piece.\n',
      },
      { path: `${outputRoot}/briefs/01-first/contract.yaml`, content: contractYaml },
      { path: `${outputRoot}/design.md`, content: 'Keep the design scoped.\n' },
      { path: `${outputRoot}/purpose.md`, content: 'Ship a small feature.\n' },
    ]);
  });

  it('rejects symlinked files in series spec context', async () => {
    const specRoot = createSeriesSpecFolder();
    const outside = mkdtempSync(join(tmpdir(), 'autopod-cli-series-secret-'));
    createdDirs.push(specRoot, outside);
    writeFileSync(join(outside, 'secret.txt'), 'do-not-send\n');
    symlinkSync(join(outside, 'secret.txt'), join(specRoot, 'leak.txt'));

    await expect(
      program.parseAsync(['node', 'ap', 'series', 'create', specRoot, '--profile', 'test']),
    ).rejects.toThrow('spec file symlink not allowed');
    expect(mockClient.createSeries).not.toHaveBeenCalled();
  });

  it('accepts contract.yml for series creation', async () => {
    const specRoot = createSeriesSpecFolder('contract.yml');
    createdDirs.push(specRoot);

    await program.parseAsync(['node', 'ap', 'series', 'create', specRoot, '--profile', 'test']);

    const call = (mockClient.createSeries as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.briefs).toHaveLength(1);
  });

  it('includes local spec files for series creation when opted in', async () => {
    const specRoot = createSeriesSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync([
      'node',
      'ap',
      'series',
      'create',
      specRoot,
      '--profile',
      'test',
      '--include-specs',
    ]);

    const call = (mockClient.createSeries as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    const outputRoot = `specs/${specRoot.split('/').at(-1)}`;
    expect(call.specFiles).toEqual([
      {
        path: `${outputRoot}/briefs/01-first/brief.md`,
        content: '## Task\nBuild the first piece.\n',
      },
      { path: `${outputRoot}/briefs/01-first/contract.yaml`, content: contractYaml },
      { path: `${outputRoot}/design.md`, content: 'Keep the design scoped.\n' },
      { path: `${outputRoot}/purpose.md`, content: 'Ship a small feature.\n' },
    ]);
    expect(call.specContextFiles).toEqual(call.specFiles);
  });

  it('can disable runtime spec context for series creation', async () => {
    const specRoot = createSeriesSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync([
      'node',
      'ap',
      'series',
      'create',
      specRoot,
      '--profile',
      'test',
      '--no-spec-context',
    ]);

    const call = (mockClient.createSeries as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.specFiles).toBeUndefined();
    expect(call.specContextFiles).toBeUndefined();
  });
});
