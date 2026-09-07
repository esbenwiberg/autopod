import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type {
  ContainerManager,
  ExecOptions,
} from '../../../../../packages/daemon/src/interfaces/container-manager.js';
import type { ValidationEngineConfig } from '../../../../../packages/daemon/src/interfaces/validation-engine.js';
import {
  createTestDb,
  insertTestProfile,
} from '../../../../../packages/daemon/src/test-utils/mock-helpers.js';
import { createLocalValidationEngine } from '../../../../../packages/daemon/src/validation/local-validation-engine.js';
import { createValidationEvidenceCache } from '../../../../../packages/daemon/src/validation/validation-evidence-cache.js';
import { createValidationIdentityCollector } from '../../../../../packages/daemon/src/validation/validation-identity-collector.js';

const exec = promisify(execFile);
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const fixtures = [
  { name: 'healthy', defect: false, source: 'module.exports = n => Math.max(0, n - 1);\n' },
  { name: 'off-by-one', defect: true, source: 'module.exports = n => Math.max(0, n - 2);\n' },
  { name: 'missing-zero-boundary', defect: true, source: 'module.exports = n => n - 1;\n' },
];
const oracle = `const assert = require('node:assert/strict'); const decrement = require('./source.cjs');
for (const [input, expected] of [[0,0],[1,0],[2,1],[10,9],[100,99]]) assert.equal(decrement(input), expected);
console.log('five fixed boundary assertions passed');\n`;

it('measures matched validation reuse with fixed assertions and seeded defects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autopod-validation-replay-'));
  const db = createTestDb();
  insertTestProfile(db);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const rows: Array<{
    fixture: string;
    mode: string;
    round: number;
    elapsedMs: number;
    overall: string;
    testReused: boolean;
    lintReused: boolean;
  }> = [];
  try {
    git('init', '-q');
    writeFileSync(join(root, 'test.cjs'), oracle);
    writeFileSync(
      join(root, 'lint.cjs'),
      "const fs = require('node:fs'); const vm = require('node:vm'); new vm.Script(fs.readFileSync('source.cjs','utf8'));\n",
    );
    writeFileSync(
      join(root, 'build.cjs'),
      "require('./source.cjs'); console.log('module loads');\n",
    );
    writeFileSync(join(root, 'source.cjs'), fixtures[0]?.source ?? '');
    git('add', '.');
    git(
      '-c',
      'user.name=Local Replay',
      '-c',
      'user.email=replay@example.invalid',
      'commit',
      '-qm',
      'fixed replay inputs',
    );
    for (const id of ['baseline', 'candidate'])
      db.prepare(`INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
      VALUES (?, 'test-profile', 'replay', 'validating', 'fixture', 'codex', 'fixture', 'local-replay')`).run(
        id,
      );
    const observedCommands: string[] = [];
    const imageDigest = `sha256:${sha(readFileSync(process.execPath))}`;
    const cm = {
      getExecutionMetadata: async () => ({
        imageDigest,
        memoryLimitBytes: null,
        cpuLimit: null,
        networkMode: 'none' /* fixture backend declaration; no Docker isolation claim */,
      }),
      execInContainer: async (_id: string, command: string[], options?: ExecOptions) => {
        if (command[0] === 'sh') {
          const text = command[2] ?? '';
          if (
            ![
              'git reset --hard HEAD && git clean -fd',
              'node lint.cjs',
              'node build.cjs',
              'node test.cjs',
            ].includes(text)
          )
            throw new Error(`Unexpected benchmark command: ${text}`);
          observedCommands.push(text);
        } else if (command[0] !== 'node' || command[1] !== '-e')
          throw new Error('Unexpected benchmark executable');
        try {
          const output = await exec(command[0] as string, command.slice(1), {
            cwd: root,
            env: { PATH: process.env.PATH, ...options?.env },
            timeout: options?.timeout ?? 30000,
          });
          return { ...output, exitCode: 0 };
        } catch (err) {
          const failure = err as { code?: number; stdout?: string; stderr?: string };
          return {
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? '',
          };
        }
      },
    } as unknown as ContainerManager;
    const implementationFiles = [
      'local-validation-engine.ts',
      'run-with-evidence.ts',
      'validation-evidence-cache.ts',
      'validation-identity-collector.ts',
    ];
    const implementation = sha(
      implementationFiles
        .map((file) => readFileSync(resolve('packages/daemon/src/validation', file), 'utf8'))
        .join('\n'),
    );
    const baseConfig: ValidationEngineConfig = {
      podId: 'baseline',
      containerId: 'fixed-local-replay',
      previewUrl: '',
      validationSetupCommand: null,
      buildCommand: 'node build.cjs',
      lintCommand: 'node lint.cjs',
      testCommand: 'node test.cjs',
      startCommand: '',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [],
      hasWebUi: false,
      attempt: 1,
      task: 'Saturating integer decrement',
      diff: '',
      skipPhases: ['review'],
      contract: {
        contractVersion: 1,
        title: 'Five immutable boundary assertions',
        dependsOn: [],
        scenarios: [],
        requiredFacts: [],
        humanReview: [],
        validationEvidence: {
          version: 1,
          hermetic: true,
          toolchainFiles: [process.execPath],
          dependencyPaths: [],
          environmentFiles: [],
          environmentRevision: sha(
            'No external dependencies or state; fixed builtin Node assertions',
          ),
        },
      },
    };
    const baseline = createLocalValidationEngine(cm);
    const candidate = createLocalValidationEngine(
      cm,
      undefined,
      undefined,
      undefined,
      createValidationEvidenceCache(db),
    );
    let round = 0;
    for (const fixture of fixtures) {
      writeFileSync(join(root, 'source.cjs'), fixture.source);
      git('add', 'source.cjs');
      git(
        '-c',
        'user.name=Local Replay',
        '-c',
        'user.email=replay@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        fixture.name,
      );
      const repeats = fixture.defect ? 2 : 5;
      for (let repeat = 0; repeat < repeats; repeat++) {
        const order = repeat % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const mode of order) {
          const config = { ...baseConfig, podId: mode, attempt: ++round };
          if (mode === 'candidate')
            config.captureEvidenceIdentity = createValidationIdentityCollector(
              cm,
              config,
              implementation,
            );
          const started = performance.now();
          const result = await (mode === 'baseline' ? baseline : candidate).validate(config);
          rows.push({
            fixture: fixture.name,
            mode,
            round: repeat,
            elapsedMs: performance.now() - started,
            overall: result.overall,
            testReused: Boolean(result.test?.reusedEvidence),
            lintReused: Boolean(result.lint?.reusedEvidence),
          });
          expect(result.overall).toBe(fixture.defect ? 'fail' : 'pass');
        }
      }
    }
    const repeated = rows.filter((row) => row.fixture === 'healthy' && row.round > 0);
    const total = (mode: string) =>
      repeated.filter((row) => row.mode === mode).reduce((sum, row) => sum + row.elapsedMs, 0);
    const baselineMs = total('baseline');
    const candidateMs = total('candidate');
    const report = {
      version: 1,
      scope:
        'local deterministic replay, actual validation engine and child processes; no production/provider claim',
      capturedAt: new Date().toISOString(),
      sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceModified: true,
      oracleSha256: sha(oracle),
      implementationSha256: implementation,
      runtime: process.version,
      imageIdentity: 'fixture hash of actual Node binary; not a Docker image receipt',
      coverage: {
        assertionsPerTestExecution: 5,
        configuredPhases: ['lint', 'build', 'test'],
        unchangedAcrossModes: true,
        excludedInBothModes: [
          'web health/pages (no web app)',
          'SAST (not configured)',
          'AI review (unpaid deterministic replay scope)',
        ],
      },
      ordering:
        'alternating AB/BA, one healthy priming pair, four measured healthy pairs, two pairs per seeded defect',
      baselineRepeatedMs: baselineMs,
      candidateRepeatedMs: candidateMs,
      reductionPercent: (1 - candidateMs / baselineMs) * 100,
      targetMet: candidateMs <= baselineMs * 0.75,
      seededDefects: fixtures.filter((f) => f.defect).map((f) => f.name),
      baselineEscapes: rows.filter(
        (r) => r.fixture !== 'healthy' && r.mode === 'baseline' && r.overall === 'pass',
      ).length,
      candidateEscapes: rows.filter(
        (r) => r.fixture !== 'healthy' && r.mode === 'candidate' && r.overall === 'pass',
      ).length,
      cacheHits: rows.filter((r) => r.testReused).length,
      actualBuildCommands: observedCommands.filter((c) => c === 'node build.cjs').length,
      rows,
    };
    writeFileSync(
      'docs/analysis/2026-09-07/execution/receipts/validation-replay-benchmark.json',
      `${JSON.stringify(report, null, 2)}\n`,
    );
    expect(report.cacheHits).toBeGreaterThan(0);
    expect(report.candidateEscapes).toBe(report.baselineEscapes);
    expect(report.actualBuildCommands).toBe(rows.length);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
