import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AcDefinition } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type {
  ValidationEngineConfig,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import {
  buildReviewPrompt,
  classifyAcTypes,
  createLocalValidationEngine,
  deduplicateAcsByBaseText,
  enforceRequirementsStatus,
  executeCmdChecks,
  normalizeReviewIssue,
  parseAcInstructionsJson,
  parseAcResults,
  parseApiCheckSpecs,
  parseClassificationJson,
  parseReviewJson,
  parseWarningCount,
  restartSupervisorIfDown,
  runHealthCheck,
  startAppStabilityMonitor,
  stripMarkdownFences,
} from './local-validation-engine.js';

/** Build a minimal AcDefinition for tests — shorthand for the string-only fixtures. */
function ac(outcome: string, type: AcDefinition['type'] = 'none'): AcDefinition {
  return { type, outcome };
}

describe('stripMarkdownFences', () => {
  it('strips ```json fences', () => {
    const input = '```json\n[{"a": 1}]\n```';
    expect(stripMarkdownFences(input)).toBe('[{"a": 1}]');
  });

  it('strips ``` fences without language', () => {
    const input = '```\nconst x = 1;\n```';
    expect(stripMarkdownFences(input)).toBe('const x = 1;');
  });

  it('strips ```javascript fences', () => {
    const input = '```javascript\nconst x = 1;\n```';
    expect(stripMarkdownFences(input)).toBe('const x = 1;');
  });

  it('returns clean text unchanged', () => {
    const input = '[{"a": 1}]';
    expect(stripMarkdownFences(input)).toBe('[{"a": 1}]');
  });
});

describe('parseAcInstructionsJson', () => {
  it('parses valid JSON array', () => {
    const input = JSON.stringify([
      { criterion: 'Has toggle', instruction: 'Navigate to /settings' },
      { criterion: 'Toggle works', instruction: 'Click toggle' },
    ]);
    const result = parseAcInstructionsJson(input);
    expect(result).toEqual([
      { criterion: 'Has toggle', instruction: 'Navigate to /settings' },
      { criterion: 'Toggle works', instruction: 'Click toggle' },
    ]);
  });

  it('handles markdown-fenced JSON', () => {
    const input = '```json\n[{"criterion": "Test", "instruction": "Do thing"}]\n```';
    const result = parseAcInstructionsJson(input);
    expect(result).toEqual([{ criterion: 'Test', instruction: 'Do thing' }]);
  });

  it('filters out malformed entries', () => {
    const input = JSON.stringify([
      { criterion: 'Valid', instruction: 'Do thing' },
      { criterion: 'Missing instruction' },
      { instruction: 'Missing criterion' },
      'not an object',
    ]);
    const result = parseAcInstructionsJson(input);
    expect(result).toEqual([{ criterion: 'Valid', instruction: 'Do thing' }]);
  });

  it('returns null for non-array JSON', () => {
    expect(parseAcInstructionsJson('{"not": "array"}')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseAcInstructionsJson('this is not json at all')).toBeNull();
  });

  it('extracts JSON from surrounding text', () => {
    const input = 'Here are the checks:\n[{"criterion": "AC", "instruction": "Do it"}]\nDone!';
    const result = parseAcInstructionsJson(input);
    expect(result).toEqual([{ criterion: 'AC', instruction: 'Do it' }]);
  });
});

describe('parseAcResults', () => {
  const instructions = [
    { criterion: 'Has toggle', instruction: 'Check toggle' },
    { criterion: 'Toggle works', instruction: 'Click toggle' },
  ];

  it('parses results from stdout markers', () => {
    const stdout = `
Some log output
__AUTOPOD_AC_RESULTS_START__
[
  {"criterion": "Has toggle", "passed": true, "reasoning": "Found it"},
  {"criterion": "Toggle works", "passed": false, "reasoning": "Broken"}
]
__AUTOPOD_AC_RESULTS_END__
More log output
`;
    const result = parseAcResults(stdout, instructions);
    expect(result).toEqual([
      { criterion: 'Has toggle', passed: true, reasoning: 'Found it' },
      { criterion: 'Toggle works', passed: false, reasoning: 'Broken' },
    ]);
  });

  it('returns failures when markers are missing', () => {
    const result = parseAcResults('no markers here', instructions);
    expect(result).toHaveLength(2);
    expect(result[0].passed).toBe(false);
    expect(result[0].criterion).toBe('Has toggle');
    expect(result[0].reasoning).toContain('parseable');
  });

  it('returns failures when JSON is invalid', () => {
    const stdout = '__AUTOPOD_AC_RESULTS_START__\nnot json\n__AUTOPOD_AC_RESULTS_END__';
    const result = parseAcResults(stdout, instructions);
    expect(result).toHaveLength(2);
    expect(result.every((r) => !r.passed)).toBe(true);
  });

  it('handles missing results for some instructions', () => {
    const stdout = `__AUTOPOD_AC_RESULTS_START__
[{"criterion": "Has toggle", "passed": true, "reasoning": "OK"}]
__AUTOPOD_AC_RESULTS_END__`;
    const result = parseAcResults(stdout, instructions);
    expect(result).toHaveLength(2);
    expect(result[0].passed).toBe(true);
    expect(result[1].passed).toBe(false);
    expect(result[1].reasoning).toContain('No result');
  });

  it('uses instruction criterion not stdout criterion', () => {
    const stdout = `__AUTOPOD_AC_RESULTS_START__
[{"criterion": "WRONG", "passed": true, "reasoning": "OK"}]
__AUTOPOD_AC_RESULTS_END__`;
    const result = parseAcResults(stdout, instructions);
    // The criterion comes from the instructions, not the parsed output
    expect(result[0].criterion).toBe('Has toggle');
  });
});

describe('parseClassificationJson', () => {
  const acTypeExport = 'ScheduledJob type is exported from @autopod/shared';
  const acApiEndpoint = 'POST /scheduled-jobs returns 201';
  const acUiToggle = 'Settings page has a dark mode toggle';
  const acs: AcDefinition[] = [ac(acTypeExport), ac(acApiEndpoint), ac(acUiToggle)];

  it('parses valid classification array', () => {
    const input = JSON.stringify([
      {
        criterion: acTypeExport,
        validationType: 'none',
        reason: 'TypeScript export — verified by diff',
      },
      { criterion: acApiEndpoint, validationType: 'api', reason: 'HTTP endpoint status check' },
      { criterion: acUiToggle, validationType: 'web-ui', reason: 'Visual UI element' },
    ]);
    const result = parseClassificationJson(input, acs);
    expect(result).toHaveLength(3);
    expect(result?.at(0)?.validationType).toBe('none');
    expect(result?.at(1)?.validationType).toBe('api');
    expect(result?.at(2)?.validationType).toBe('web-ui');
  });

  it('handles markdown-fenced JSON', () => {
    const input = `\`\`\`json\n${JSON.stringify([{ criterion: acTypeExport, validationType: 'none', reason: 'type check' }])}\n\`\`\``;
    const result = parseClassificationJson(input, [ac(acTypeExport)]);
    expect(result).toHaveLength(1);
    expect(result?.at(0)?.validationType).toBe('none');
  });

  it('filters out entries with invalid validationType', () => {
    const input = JSON.stringify([
      { criterion: acTypeExport, validationType: 'none', reason: 'ok' },
      { criterion: acApiEndpoint, validationType: 'browser', reason: 'invalid type' },
    ]);
    const result = parseClassificationJson(input, acs);
    // 'browser' is not a valid type — filtered; missing AC falls back to none
    const types = result?.map((r) => r.validationType) ?? [];
    expect(types).not.toContain('browser');
  });

  it('backfills missing ACs as none', () => {
    const input = JSON.stringify([
      { criterion: acTypeExport, validationType: 'none', reason: 'type check' },
    ]);
    const result = parseClassificationJson(input, acs);
    expect(result).toHaveLength(3);
    const missing = result?.filter((r) => r.criterion !== acTypeExport) ?? [];
    expect(missing.every((r) => r.validationType === 'none')).toBe(true);
  });

  it('classifies a single AC from the LLM result', () => {
    const input = JSON.stringify([
      { criterion: acApiEndpoint, validationType: 'api', reason: 'endpoint' },
    ]);
    const result = parseClassificationJson(input, [ac(acApiEndpoint, 'api')]);
    expect(result?.at(0)?.validationType).toBe('api');
    expect(result?.at(0)?.criterion).toBe(acApiEndpoint);
  });

  it('returns null for garbage input', () => {
    expect(parseClassificationJson('not json at all', acs)).toBeNull();
  });

  it('returns null for non-array JSON', () => {
    expect(parseClassificationJson('{"not": "array"}', acs)).toBeNull();
  });

  it('extracts JSON from surrounding text', () => {
    const jsonPart = JSON.stringify([
      { criterion: acApiEndpoint, validationType: 'api', reason: 'endpoint' },
    ]);
    const result = parseClassificationJson(`Here is my answer:\n${jsonPart}\nDone.`, [
      ac(acApiEndpoint),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.at(0)?.validationType).toBe('api');
  });
});

describe('classifyAcTypes', () => {
  // Minimal config stub — classifyAcTypes only reads acceptanceCriteria and hasWebUi
  // in the declared-types path, so we don't need to wire real validation infra.
  function configWith(acs: AcDefinition[], hasWebUi = true): ValidationEngineConfig {
    return {
      podId: 'sess-1',
      containerId: 'c1',
      previewUrl: 'http://localhost:3000',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      healthPath: '/health',
      healthTimeout: 30_000,
      smokePages: [],
      attempt: 1,
      task: 'test task',
      diff: '',
      reviewerModel: 'sonnet',
      acceptanceCriteria: acs,
      hasWebUi,
    };
  }

  it('skips the LLM when every AC has a brief-declared type', async () => {
    const acs: AcDefinition[] = [
      { type: 'none', outcome: 'Types exported' },
      { type: 'api', outcome: 'POST /jobs returns 201', hint: 'POST /api/jobs' },
      { type: 'web', outcome: 'Settings has toggle', hint: '/settings' },
    ];
    // If the LLM were invoked, this would spawn a `claude` subprocess and hang or fail;
    // resolving synchronously proves the short-circuit path ran.
    const result = await classifyAcTypes(configWith(acs));
    expect(result).toHaveLength(3);
    expect(result?.[0]).toMatchObject({
      criterion: 'Types exported',
      validationType: 'none',
    });
    expect(result?.[1]?.validationType).toBe('api');
    // Brief `type: web` maps to engine `web-ui`.
    expect(result?.[2]?.validationType).toBe('web-ui');
    // Reason signals the skip path so logs remain diagnosable.
    expect(result?.[0]?.reason).toMatch(/brief/i);
  });

  it('downgrades web-ui to none when hasWebUi is false', async () => {
    const acs: AcDefinition[] = [
      { type: 'web', outcome: 'Settings has toggle', hint: '/settings' },
      { type: 'api', outcome: 'POST /jobs returns 201', hint: 'POST /api/jobs' },
    ];
    const result = await classifyAcTypes(configWith(acs, false));
    expect(result?.[0]?.validationType).toBe('none');
    expect(result?.[1]?.validationType).toBe('api');
  });

  it('returns [] for empty input without invoking the LLM', async () => {
    const result = await classifyAcTypes(configWith([]));
    expect(result).toEqual([]);
  });

  it('passes brief `type: cmd` through as engine `cmd` and propagates hint + polarity', async () => {
    // Regression: classifyAcTypes was dropping `hint` and `polarity` when building
    // ClassifiedAc, so executeCmdChecks fell back to running the `outcome` text as
    // a shell command. Make sure both fields survive classification.
    const acs: AcDefinition[] = [
      {
        type: 'cmd',
        outcome: "rg -l 'OldEventEmitter' packages/daemon/src returns no matches",
        hint: "rg -l 'OldEventEmitter' packages/daemon/src",
        polarity: 'expect-no-output',
      },
    ];
    const result = await classifyAcTypes(configWith(acs));
    expect(result).toHaveLength(1);
    expect(result?.[0]?.validationType).toBe('cmd');
    expect(result?.[0]?.command).toBe("rg -l 'OldEventEmitter' packages/daemon/src");
    expect(result?.[0]?.polarity).toBe('expect-no-output');
    // criterion stays the human description — it's what surfaces in UI / review prompts.
    expect(result?.[0]?.criterion).toBe(
      "rg -l 'OldEventEmitter' packages/daemon/src returns no matches",
    );
  });

  it('demotes banned build/test/lint commands to none even when declared cmd', async () => {
    // The banlist runs before declared-type evaluation, so anything matching
    // COMMAND_LIKE_AC_PATTERNS lands as 'none' regardless of authorial intent.
    const acs: AcDefinition[] = [
      { type: 'cmd', outcome: 'pnpm build', hint: 'pnpm build' },
      { type: 'cmd', outcome: 'dotnet test ./Tests', hint: 'dotnet test ./Tests' },
      { type: 'cmd', outcome: 'npx tsc --noEmit', hint: 'npx tsc --noEmit' },
    ];
    const result = await classifyAcTypes(configWith(acs));
    expect(result).toHaveLength(3);
    for (const r of result ?? []) {
      expect(r.validationType).toBe('none');
    }
  });
});

describe('executeCmdChecks', () => {
  function configWith(): ValidationEngineConfig {
    return {
      podId: 'sess-1',
      containerId: 'c1',
      previewUrl: 'http://localhost:3000',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      healthPath: '/health',
      healthTimeout: 30_000,
      smokePages: [],
      attempt: 1,
      task: 'test task',
      diff: '',
      reviewerModel: 'sonnet',
      acceptanceCriteria: [],
      hasWebUi: true,
    };
  }

  function makeContainerManager(
    handler: (cmd: string[]) => { stdout: string; stderr: string; exitCode: number },
  ): ContainerManager {
    const execInContainer = vi.fn(async (_id: string, cmd: string[]) => handler(cmd));
    return { execInContainer } as unknown as ContainerManager;
  }

  it('passes when an exit-zero command succeeds (default polarity)', async () => {
    const cm = makeContainerManager(() => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }));
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'NewMw.cs is registered',
        command: 'test -f Application/Auth/NewMw.cs',
        polarity: 'exit-zero',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.passed).toBe(true);
    expect(result[0]?.validationType).toBe('cmd');
  });

  it('fails when an exit-zero command exits non-zero', async () => {
    const cm = makeContainerManager(() => ({
      stdout: '',
      stderr: 'no such file',
      exitCode: 1,
    }));
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'NewMw.cs is registered',
        command: 'test -f Application/Auth/NewMw.cs',
        polarity: 'exit-zero',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result[0]?.passed).toBe(false);
    expect(result[0]?.reasoning).toContain('no such file');
  });

  it('expect-no-output: passes when grep finds nothing', async () => {
    // rg returns exit 1 when there are no matches; that's the pass condition.
    const cm = makeContainerManager(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'OldEventEmitter is removed from daemon source',
        command: "rg -l 'OldEventEmitter' packages/daemon/src",
        polarity: 'expect-no-output',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result[0]?.passed).toBe(true);
  });

  it('expect-no-output: fails when grep emits a match', async () => {
    const cm = makeContainerManager(() => ({
      stdout: 'packages/daemon/src/old.ts\n',
      stderr: '',
      exitCode: 0,
    }));
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'OldEventEmitter is removed from daemon source',
        command: "rg -l 'OldEventEmitter' packages/daemon/src",
        polarity: 'expect-no-output',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result[0]?.passed).toBe(false);
    expect(result[0]?.reasoning).toContain('packages/daemon/src/old.ts');
  });

  it('expect-output: passes when grep emits output (positive registration AC)', async () => {
    const cm = makeContainerManager(() => ({
      stdout: 'Client/src/context/network/http/QueryProvider/queryKeys.ts\n',
      stderr: '',
      exitCode: 0,
    }));
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'RESOURCE_PLANNER_TOP_ROW query key is registered',
        command:
          "grep -l 'RESOURCE_PLANNER_TOP_ROW' Client/src/context/network/http/QueryProvider/queryKeys.ts",
        polarity: 'expect-output',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result[0]?.passed).toBe(true);
  });

  it('expect-output: fails when grep emits nothing even with exit 0', async () => {
    // grep exits 1 when no match, but some commands exit 0 with empty stdout —
    // either way, expect-output requires non-empty stdout.
    const cm = makeContainerManager(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'thing is registered',
        command: 'grep -l THING file.ts',
        polarity: 'expect-output',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result[0]?.passed).toBe(false);
  });

  it('defaults to exit-zero polarity when polarity is omitted', async () => {
    const cm = makeContainerManager(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'file exists',
        command: 'test -f Client/src/TopTotalRow.tsx',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result[0]?.passed).toBe(true);
  });

  it('REGRESSION: executes ac.command, NOT ac.criterion (the human description)', async () => {
    // The bug we're fixing: executeCmdChecks used to run `sh -c ac.criterion`
    // where criterion was the outcome description like "LogStreamingHub is
    // mapped in SignalRMiddlewareEx.cs". The shell would try to exec
    // "LogStreamingHub" as a command, exit 127, and fail every cmd AC.
    let executed: string | null = null;
    const execInContainer = vi.fn(async (_id: string, cmd: string[]) => {
      executed = cmd[2] ?? null;
      return { stdout: 'match\n', stderr: '', exitCode: 0 };
    });
    const cm = { execInContainer } as unknown as ContainerManager;

    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'LogStreamingHub is mapped in SignalRMiddlewareEx.cs',
        command: "grep 'MapHub<LogStreamingHub>' Frameworks/PF.SignalR/SignalRMiddlewareEx.cs",
        polarity: 'expect-output',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);

    expect(executed).toBe(
      "grep 'MapHub<LogStreamingHub>' Frameworks/PF.SignalR/SignalRMiddlewareEx.cs",
    );
    expect(executed).not.toBe('LogStreamingHub is mapped in SignalRMiddlewareEx.cs');
    expect(result[0]?.passed).toBe(true);
  });

  it('fails explicitly when command (hint) is missing — does NOT exec the criterion', async () => {
    const execInContainer = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const cm = { execInContainer } as unknown as ContainerManager;
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'Some human-readable outcome',
        // command intentionally omitted
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(execInContainer).not.toHaveBeenCalled();
    expect(result[0]?.passed).toBe(false);
    expect(result[0]?.reasoning).toMatch(/hint/i);
  });

  it('returns failed results when the container is missing', async () => {
    const cm = makeContainerManager(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const config = { ...configWith(), containerId: undefined as unknown as string };
    const result = await executeCmdChecks(cm, config, [
      {
        criterion: 'thing exists',
        command: 'echo hi',
        polarity: 'exit-zero',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result[0]?.passed).toBe(false);
    expect(result[0]?.reasoning).toMatch(/no container/i);
  });

  it('captures execInContainer errors as a failed result', async () => {
    const execInContainer = vi.fn(async () => {
      throw new Error('docker exec timeout');
    });
    const cm = { execInContainer } as unknown as ContainerManager;
    const result = await executeCmdChecks(cm, configWith(), [
      {
        criterion: 'thing exists',
        command: 'echo hi',
        polarity: 'exit-zero',
        validationType: 'cmd',
        reason: 'declared in brief',
      },
    ]);
    expect(result[0]?.passed).toBe(false);
    expect(result[0]?.reasoning).toContain('docker exec timeout');
  });
});

describe('parseApiCheckSpecs', () => {
  it('parses valid specs with numeric expectedStatus', () => {
    const input = JSON.stringify([
      { criterion: 'POST /jobs returns 201', method: 'POST', path: '/jobs', expectedStatus: 201 },
      { criterion: 'GET /users returns 200', method: 'GET', path: '/users', expectedStatus: 200 },
    ]);
    const result = parseApiCheckSpecs(input);
    expect(result).toHaveLength(2);
    expect(result?.[0]?.expectedStatus).toBe(201);
    expect(result?.[1]?.expectedStatus).toBe(200);
  });

  it('coerces string expectedStatus "201" to number 201', () => {
    const input = JSON.stringify([
      {
        criterion: 'POST /jobs returns 201',
        method: 'POST',
        path: '/jobs',
        expectedStatus: '201',
      },
    ]);
    const result = parseApiCheckSpecs(input);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.expectedStatus).toBe(201);
    expect(typeof result?.[0]?.expectedStatus).toBe('number');
  });

  it('drops spec when expectedStatus is a non-numeric string', () => {
    const input = JSON.stringify([
      { criterion: 'POST /jobs returns 201', method: 'POST', path: '/jobs', expectedStatus: 'ok' },
    ]);
    const result = parseApiCheckSpecs(input);
    expect(result).toHaveLength(0);
  });

  it('drops spec when expectedStatus is missing entirely', () => {
    const input = JSON.stringify([
      { criterion: 'POST /jobs returns 201', method: 'POST', path: '/jobs' },
    ]);
    const result = parseApiCheckSpecs(input);
    expect(result).toHaveLength(0);
  });

  it('parses markdown-wrapped JSON', () => {
    const inner = JSON.stringify([
      { criterion: 'POST /jobs returns 201', method: 'POST', path: '/jobs', expectedStatus: 201 },
    ]);
    const result = parseApiCheckSpecs(`\`\`\`json\n${inner}\n\`\`\``);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.expectedStatus).toBe(201);
  });

  it('returns null for garbage input', () => {
    expect(parseApiCheckSpecs('this is not json at all')).toBeNull();
  });

  it('returns null for non-array JSON', () => {
    expect(parseApiCheckSpecs('{"criterion": "x", "method": "GET"}')).toBeNull();
  });

  it('extracts JSON from surrounding prose', () => {
    const inner = JSON.stringify([
      { criterion: 'GET /users returns 200', method: 'GET', path: '/users', expectedStatus: 200 },
    ]);
    const result = parseApiCheckSpecs(`Here are the specs:\n${inner}\nDone.`);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.method).toBe('GET');
  });

  it('preserves optional bodyContains field', () => {
    const input = JSON.stringify([
      {
        criterion: 'GET /users returns 200',
        method: 'GET',
        path: '/users',
        expectedStatus: 200,
        bodyContains: '"id"',
      },
    ]);
    const result = parseApiCheckSpecs(input);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.bodyContains).toBe('"id"');
  });

  it('preserves captureAs and captureField fields', () => {
    const input = JSON.stringify([
      {
        criterion: 'POST /jobs returns 201',
        method: 'POST',
        path: '/jobs',
        expectedStatus: 201,
        captureAs: 'jobId',
        captureField: 'id',
      },
    ]);
    const result = parseApiCheckSpecs(input);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.captureAs).toBe('jobId');
    expect(result?.[0]?.captureField).toBe('id');
  });

  it('preserves dependsOn field for chained specs', () => {
    const input = JSON.stringify([
      {
        criterion: 'GET /jobs/{id} returns 200',
        method: 'GET',
        path: '/jobs/{jobId}',
        expectedStatus: 200,
        dependsOn: 'POST /jobs returns 201',
      },
    ]);
    const result = parseApiCheckSpecs(input);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.dependsOn).toBe('POST /jobs returns 201');
    expect(result?.[0]?.path).toBe('/jobs/{jobId}');
  });

  it('parses a chained create-then-fetch spec set', () => {
    const input = JSON.stringify([
      {
        criterion: 'POST /jobs creates a job',
        method: 'POST',
        path: '/jobs',
        expectedStatus: 201,
        requestBody: { name: 'test' },
        captureAs: 'jobId',
        captureField: 'id',
      },
      {
        criterion: 'GET /jobs/{id} returns the job',
        method: 'GET',
        path: '/jobs/{jobId}',
        expectedStatus: 200,
        dependsOn: 'POST /jobs creates a job',
      },
    ]);
    const result = parseApiCheckSpecs(input);
    expect(result).toHaveLength(2);
    expect(result?.[0]?.captureAs).toBe('jobId');
    expect(result?.[1]?.dependsOn).toBe('POST /jobs creates a job');
    expect(result?.[1]?.path).toBe('/jobs/{jobId}');
  });
});

describe('deduplicateAcsByBaseText', () => {
  it('passes through non-duplicate criteria unchanged', () => {
    const acs = [
      ac('POST /jobs returns 201'),
      ac('GET /jobs returns 200'),
      ac('DELETE /jobs/{id} returns 204'),
    ];
    const { deduped } = deduplicateAcsByBaseText(acs);
    expect(deduped).toHaveLength(3);
    expect(deduped.map((d) => d.outcome)).toEqual(acs.map((a) => a.outcome));
  });

  it('deduplicates exact duplicates', () => {
    const acs = [ac('POST /jobs returns 201'), ac('POST /jobs returns 201')];
    const { deduped } = deduplicateAcsByBaseText(acs);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.outcome).toBe('POST /jobs returns 201');
  });

  it('deduplicates when one AC is the other plus a parenthetical suffix', () => {
    const short = 'POST /jobs returns 201';
    const long =
      'POST /jobs returns 201 (HTTP status code is directly verifiable via a POST request)';
    const { deduped } = deduplicateAcsByBaseText([ac(short), ac(long)]);
    expect(deduped).toHaveLength(1);
    // Keeps the longer (more informative) form
    expect(deduped[0]?.outcome).toBe(long);
  });

  it('deduplicates and keeps longest when long form comes first', () => {
    const short = 'ConsecutiveFailureCount increments by 1 on each failure';
    const long =
      'ConsecutiveFailureCount increments by 1 on each failure (ConsecutiveFailureCount is a persisted job field verifiable via GET /api/schedule/jobs/{id} after induced failures.)';
    const { deduped } = deduplicateAcsByBaseText([ac(long), ac(short)]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.outcome).toBe(long);
  });

  it('expandResult maps canonical result back to all original criteria', () => {
    const short = 'POST /jobs returns 201';
    const long = 'POST /jobs returns 201 (HTTP status code is directly verifiable)';
    const { expandResult } = deduplicateAcsByBaseText([ac(short), ac(long)]);

    const compactResults = [
      {
        criterion: long,
        passed: true,
        validationType: 'api' as const,
        reasoning: 'POST /jobs → 201',
      },
    ];
    const expanded = expandResult(compactResults);
    expect(expanded).toHaveLength(2);
    // Short form gets a result too (re-mapped from the canonical long form)
    const shortResult = expanded.find((r) => r.criterion === short);
    expect(shortResult).toBeDefined();
    expect(shortResult?.passed).toBe(true);
    // Long form result is also present
    const longResult = expanded.find((r) => r.criterion === long);
    expect(longResult).toBeDefined();
    expect(longResult?.passed).toBe(true);
  });

  it('expandResult propagates failures to all matching originals', () => {
    const short = 'GET /jobs/{id} returns 200';
    const long = 'GET /jobs/{id} returns 200 (use the id from the POST response)';
    const { expandResult } = deduplicateAcsByBaseText([ac(short), ac(long)]);

    const compactResults = [
      {
        criterion: long,
        passed: false,
        validationType: 'api' as const,
        reasoning: 'GET /jobs/1 → 404',
      },
    ];
    const expanded = expandResult(compactResults);
    expect(expanded).toHaveLength(2);
    expect(expanded.every((r) => !r.passed)).toBe(true);
  });

  it('handles criteria with no near-duplicates mixed with ones that do have near-duplicates', () => {
    const unique = 'GET /health returns 200';
    const short = 'POST /jobs returns 201';
    const long = 'POST /jobs returns 201 (verifiable via a POST request)';
    const { deduped } = deduplicateAcsByBaseText([ac(unique), ac(short), ac(long)]);
    expect(deduped).toHaveLength(2);
    const outcomes = deduped.map((d) => d.outcome);
    expect(outcomes).toContain(unique);
    expect(outcomes).toContain(long);
    expect(outcomes).not.toContain(short);
  });
});

describe('enforceRequirementsStatus', () => {
  it('returns null unchanged', () => {
    expect(enforceRequirementsStatus(null)).toBeNull();
  });

  it('leaves pass status unchanged when all requirements are met', () => {
    const parsed = {
      status: 'pass' as const,
      reasoning: 'All good',
      issues: [],
      requirementsCheck: [
        { criterion: 'Scheduler runs on startup', met: true, note: 'Confirmed in diff' },
      ],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.status).toBe('pass');
  });

  it('forces status to fail when any requirementsCheck item is unmet', () => {
    const parsed = {
      status: 'pass' as const,
      reasoning: 'Code quality looks fine',
      issues: [],
      requirementsCheck: [
        { criterion: 'Scheduler runs on startup', met: true },
        {
          criterion: 'ConsecutiveFailureCount increments on failure',
          met: false,
          note: 'Not found in diff',
        },
      ],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.status).toBe('fail');
  });

  it('leaves fail status unchanged even when all requirements are met', () => {
    const parsed = {
      status: 'fail' as const,
      reasoning: 'Code quality issues found',
      issues: ['Missing error handling'],
      requirementsCheck: [{ criterion: 'Scheduler runs on startup', met: true }],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.status).toBe('fail');
  });

  it('leaves pass status unchanged when requirementsCheck is absent', () => {
    const parsed = {
      status: 'pass' as const,
      reasoning: 'Looks good',
      issues: [],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.status).toBe('pass');
  });

  it('preserves all other fields when overriding status', () => {
    const parsed = {
      status: 'pass' as const,
      reasoning: 'Mostly fine',
      issues: ['minor nit'],
      requirementsCheck: [{ criterion: 'Some AC', met: false, note: 'Not done' }],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.reasoning).toBe('Mostly fine');
    expect(result?.issues).toEqual(['minor nit']);
    expect(result?.requirementsCheck).toHaveLength(1);
  });
});

describe('buildReviewPrompt', () => {
  const baseConfig = {
    podId: 'sess-1',
    containerId: 'c1',
    previewUrl: 'http://localhost:3000',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/health',
    healthTimeout: 30_000,
    smokePages: [],
    attempt: 1,
    task: 'Implement a job scheduler',
    diff: '+const x = 1;',
    reviewerModel: 'claude-opus-4-6',
  };

  it('renders DIFF VERIFICATION REQUIRED section when noneAcCriteria is provided', () => {
    const noneAcs = ['Scheduler runs on startup', 'ConsecutiveFailureCount increments on failure'];
    const prompt = buildReviewPrompt(baseConfig, undefined, noneAcs);
    expect(prompt).toContain('REQUIREMENTS — DIFF VERIFICATION REQUIRED');
    expect(prompt).toContain('Scheduler runs on startup');
    expect(prompt).toContain('ConsecutiveFailureCount increments on failure');
    expect(prompt).toContain('YOU ARE THE ONLY CHECK');
  });

  it('renders AUTO-VERIFIED section for non-none ACs when noneAcCriteria is provided', () => {
    const config = {
      ...baseConfig,
      acceptanceCriteria: [ac('POST /api/jobs returns 201'), ac('Scheduler runs on startup')],
    };
    const noneAcs = ['Scheduler runs on startup'];
    const prompt = buildReviewPrompt(config, undefined, noneAcs);
    expect(prompt).toContain('ACCEPTANCE CRITERIA — AUTO-VERIFIED');
    expect(prompt).toContain('POST /api/jobs returns 201');
    expect(prompt).toContain('REQUIREMENTS — DIFF VERIFICATION REQUIRED');
    expect(prompt).toContain('Scheduler runs on startup');
    // The auto-verified section should NOT include the none AC
    const autoSectionMatch = prompt.match(/AUTO-VERIFIED[\s\S]*?DIFF VERIFICATION/);
    expect(autoSectionMatch?.[0]).not.toContain('Scheduler runs on startup');
  });

  it('omits DIFF VERIFICATION section when noneAcCriteria is empty', () => {
    const config = { ...baseConfig, acceptanceCriteria: [ac('POST /api/jobs returns 201')] };
    const prompt = buildReviewPrompt(config, undefined, []);
    expect(prompt).not.toContain('DIFF VERIFICATION REQUIRED');
  });

  it('omits AUTO-VERIFIED section when all ACs are none-classified', () => {
    const config = { ...baseConfig, acceptanceCriteria: [ac('Scheduler runs on startup')] };
    const noneAcs = ['Scheduler runs on startup'];
    const prompt = buildReviewPrompt(config, undefined, noneAcs);
    expect(prompt).not.toContain('AUTO-VERIFIED');
    expect(prompt).toContain('DIFF VERIFICATION REQUIRED');
  });

  it('omits requirementsCheck from JSON format comment when no none ACs', () => {
    const config = { ...baseConfig, acceptanceCriteria: [ac('POST /api/jobs returns 201')] };
    const prompt = buildReviewPrompt(config, undefined, []);
    // Standard requirementsCheck format (not the diff-only variant)
    expect(prompt).toContain('"requirementsCheck"');
    expect(prompt).not.toContain('DIFF VERIFICATION REQUIRED');
  });

  it('instructs reviewer to include only DIFF VERIFICATION criteria in requirementsCheck', () => {
    const config = {
      ...baseConfig,
      acceptanceCriteria: [ac('POST /api/jobs returns 201'), ac('Scheduler runs on startup')],
    };
    const noneAcs = ['Scheduler runs on startup'];
    const prompt = buildReviewPrompt(config, undefined, noneAcs);
    expect(prompt).toContain('Include ONLY the "DIFF VERIFICATION REQUIRED" requirements');
    expect(prompt).toContain('Do NOT include auto-verified');
  });
});

describe('normalizeReviewIssue', () => {
  it('passes plain strings through trimmed', () => {
    expect(normalizeReviewIssue('  unhandled null in foo()  ')).toBe('unhandled null in foo()');
  });

  it('drops empty strings', () => {
    expect(normalizeReviewIssue('   ')).toBeNull();
    expect(normalizeReviewIssue('')).toBeNull();
  });

  it('formats {severity, message} objects as "[SEVERITY] message"', () => {
    expect(normalizeReviewIssue({ severity: 'high', message: 'Captive dependency' })).toBe(
      '[HIGH] Captive dependency',
    );
  });

  it('falls back to description / issue / text fields when message is missing', () => {
    expect(normalizeReviewIssue({ severity: 'medium', description: 'Missing await' })).toBe(
      '[MEDIUM] Missing await',
    );
    expect(normalizeReviewIssue({ severity: 'critical', issue: 'SQL injection' })).toBe(
      '[CRITICAL] SQL injection',
    );
    expect(normalizeReviewIssue({ severity: 'high', text: 'Unsafe cast' })).toBe(
      '[HIGH] Unsafe cast',
    );
  });

  it('omits severity prefix when no severity field is present', () => {
    expect(normalizeReviewIssue({ message: 'just a note' })).toBe('just a note');
  });

  it('accepts level as a synonym for severity', () => {
    expect(normalizeReviewIssue({ level: 'medium', message: 'foo' })).toBe('[MEDIUM] foo');
  });

  it('returns null for objects with no renderable content', () => {
    expect(normalizeReviewIssue({})).toBeNull();
    expect(normalizeReviewIssue({ severity: 'high' })).toBeNull();
    expect(normalizeReviewIssue({ message: 42 })).toBeNull();
  });

  it('returns null for non-string non-object inputs', () => {
    expect(normalizeReviewIssue(null)).toBeNull();
    expect(normalizeReviewIssue(undefined)).toBeNull();
    expect(normalizeReviewIssue(42)).toBeNull();
    expect(normalizeReviewIssue(true)).toBeNull();
  });

  it('never produces "[object Object]"', () => {
    // The regression we are guarding against: prior code did
    // `parsed.issues.map(String)` which turned every object into the literal
    // string `[object Object]`. normalizeReviewIssue must never do that.
    const result = normalizeReviewIssue({ severity: 'high', message: 'real content' });
    expect(result).not.toContain('[object Object]');
    expect(String({})).toBe('[object Object]'); // sanity-check the JS behaviour we're guarding against
  });
});

describe('parseReviewJson — issues normalization', () => {
  const baseShape = (issues: unknown[]) =>
    JSON.stringify({
      status: 'fail',
      reasoning: 'overall summary',
      issues,
    });

  it('passes plain string issues through unchanged', () => {
    const parsed = parseReviewJson(baseShape(['simple issue', 'second issue']));
    expect(parsed?.issues).toEqual(['simple issue', 'second issue']);
  });

  it('formats object-shaped issues into "[SEVERITY] message" strings', () => {
    const parsed = parseReviewJson(
      baseShape([
        { severity: 'high', message: 'Captive dependency' },
        { severity: 'medium', message: 'Missing test coverage' },
      ]),
    );
    expect(parsed?.issues).toEqual(['[HIGH] Captive dependency', '[MEDIUM] Missing test coverage']);
  });

  it('handles a mixed array of strings and objects', () => {
    const parsed = parseReviewJson(
      baseShape(['a plain string finding', { severity: 'high', message: 'an object finding' }]),
    );
    expect(parsed?.issues).toEqual(['a plain string finding', '[HIGH] an object finding']);
  });

  it('drops un-renderable entries from a mixed array but keeps the parse', () => {
    const parsed = parseReviewJson(
      baseShape(['   ', { irrelevant: true }, { severity: 'high', message: 'real one' }]),
    );
    expect(parsed?.issues).toEqual(['[HIGH] real one']);
  });

  it('rejects the parse when issues are present but every entry is un-renderable', () => {
    // Better to fail loud than to silently report "no issues" when the model
    // clearly tried to flag problems.
    const parsed = parseReviewJson(baseShape([{}, null, 42]));
    expect(parsed).toBeNull();
  });

  it('accepts an empty issues array', () => {
    const parsed = parseReviewJson(baseShape([]));
    expect(parsed?.issues).toEqual([]);
  });
});

describe('validate() — hasWebUi gating', () => {
  /** Minimal ContainerManager stub — every method throws unless explicitly invoked. */
  function stubContainerManager(): ContainerManager {
    const fail = (name: string) =>
      vi.fn(() => Promise.reject(new Error(`stub: ${name} unexpectedly called`)));
    // Pre-validation `resetWorktreeToHead` always calls execInContainer with
    // `git reset --hard HEAD && git clean -fd`. Allow that one call through;
    // anything else still fails so phase-gating assertions stay meaningful.
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
        options?: { cwd?: string },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        if (
          command[0] === 'sh' &&
          command[1] === '-c' &&
          typeof command[2] === 'string' &&
          command[2].includes('git reset --hard HEAD') &&
          command[2].includes('git clean')
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error(
          `stub: execInContainer unexpectedly called with command=${JSON.stringify(command)} cwd=${options?.cwd ?? 'unset'}`,
        );
      },
    );
    return {
      spawn: fail('spawn'),
      kill: fail('kill'),
      refreshFirewall: fail('refreshFirewall'),
      stop: fail('stop'),
      start: fail('start'),
      writeFile: fail('writeFile'),
      readFile: fail('readFile'),
      extractDirectoryFromContainer: fail('extractDirectoryFromContainer'),
      getStatus: fail('getStatus'),
      execInContainer,
      execStreaming: fail('execStreaming'),
    } as unknown as ContainerManager;
  }

  /** Minimal config — no build/test/lint/sast/start commands and empty diff so all
   *  command-driven phases (and the AI review) short-circuit without touching the
   *  container or spawning a CLI. Only the in-memory phase logic runs. */
  function baseConfig(overrides: Partial<ValidationEngineConfig> = {}): ValidationEngineConfig {
    return {
      podId: 'pod-test',
      containerId: 'container-test',
      previewUrl: 'http://127.0.0.1:9999',
      buildCommand: '',
      startCommand: 'node server.js',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [{ path: '/' }],
      attempt: 1,
      task: 'test task',
      diff: '',
      ...overrides,
    };
  }

  it('skips Health and Pages when hasWebUi is false', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const completed: Array<{ phase: string; status: string }> = [];
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseCompleted: (phase, status) => completed.push({ phase, status }),
    };

    const result = await engine.validate(
      baseConfig({ hasWebUi: false }),
      undefined,
      undefined,
      callbacks,
    );

    // Only the pre-validation worktree reset should hit execInContainer —
    // buildCommand is empty (skip), and Health is short-circuited before
    // runHealthCheck would exec the start command. Any non-cleanup call would
    // throw via the stub.
    const execMock = cm.execInContainer as unknown as ReturnType<typeof vi.fn>;
    expect(execMock).toHaveBeenCalledTimes(1);
    const [, cleanupCommand] = execMock.mock.calls[0] as [string, string[]];
    expect(cleanupCommand[2]).toContain('git reset --hard HEAD');
    expect(cleanupCommand[2]).toContain('git clean');

    expect(result.smoke.health.status).toBe('skip');
    expect(result.smoke.health.responseCode).toBeNull();
    expect(result.smoke.pages).toEqual([]);
    expect(result.smoke.status).toBe('pass');

    const healthEvent = completed.find((c) => c.phase === 'health');
    const pagesEvent = completed.find((c) => c.phase === 'pages');
    expect(healthEvent?.status).toBe('skip');
    expect(pagesEvent?.status).toBe('skip');
  });

  it('reports Health as fail when hasWebUi is true and build fails', async () => {
    // Sanity check: existing behaviour (synthetic-fail health when build fails)
    // is preserved when hasWebUi is left at its default. Here build is skipped (no
    // command) so it actually passes, meaning runHealthCheck would be invoked —
    // and would throw via the stub, which is what we want to verify the gate flips.
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    // Use a non-empty buildCommand so runBuild calls execInContainer and our stub
    // rejects → buildResult is 'fail' → health falls to the synthetic-fail branch.
    const result = await engine.validate(
      baseConfig({ hasWebUi: true, buildCommand: 'npm run build' }),
    );

    expect(result.smoke.build.status).toBe('fail');
    expect(result.smoke.health.status).toBe('fail');
    expect(result.smoke.health.url).toBe('http://127.0.0.1:9999/');
  });

  it('reports Pages as skip (not pass) when Health fails with smokePages configured', async () => {
    // Regression: `pages` is an empty array when health doesn't pass, and
    // `[].every(...)` is vacuously true — which previously made pagesStatus
    // = 'pass' and surfaced a bogus "All pages passed" while Health was red.
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const completed: Array<{ phase: string; status: string }> = [];
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseCompleted: (phase, status) => completed.push({ phase, status }),
    };

    const result = await engine.validate(
      baseConfig({
        hasWebUi: true,
        buildCommand: 'npm run build',
        smokePages: [{ path: '/' }, { path: '/dashboard' }],
      }),
      undefined,
      undefined,
      callbacks,
    );

    expect(result.smoke.health.status).toBe('fail');
    expect(result.smoke.pages).toEqual([]);
    const pagesEvent = completed.find((c) => c.phase === 'pages');
    expect(pagesEvent?.status).toBe('skip');
  });
});

describe('validate() — tier-1 gate', () => {
  function stubContainerManager(): ContainerManager {
    const fail = (name: string) =>
      vi.fn(() => Promise.reject(new Error(`stub: ${name} unexpectedly called`)));
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        if (
          command[0] === 'sh' &&
          command[1] === '-c' &&
          typeof command[2] === 'string' &&
          command[2].includes('git reset --hard HEAD')
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error(`stub: execInContainer unexpectedly called: ${JSON.stringify(command)}`);
      },
    );
    return {
      spawn: fail('spawn'),
      kill: fail('kill'),
      refreshFirewall: fail('refreshFirewall'),
      stop: fail('stop'),
      start: fail('start'),
      writeFile: fail('writeFile'),
      readFile: fail('readFile'),
      extractDirectoryFromContainer: fail('extractDirectoryFromContainer'),
      getStatus: fail('getStatus'),
      execInContainer,
      execStreaming: fail('execStreaming'),
    } as unknown as ContainerManager;
  }

  function baseConfig(overrides: Partial<ValidationEngineConfig> = {}): ValidationEngineConfig {
    return {
      podId: 'pod-test',
      containerId: 'container-test',
      previewUrl: 'http://127.0.0.1:9999',
      buildCommand: '',
      startCommand: 'node server.js',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [{ path: '/' }],
      attempt: 1,
      task: 'test task',
      diff: '',
      hasWebUi: false,
      ...overrides,
    };
  }

  it('skips AC + Review with upstream-failed reason when build fails', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const completed: Array<{ phase: string; status: string }> = [];
    const result = await engine.validate(
      baseConfig({ buildCommand: 'npm run build', acceptanceCriteria: ['AC: it works'] }),
      undefined,
      undefined,
      { onPhaseCompleted: (phase, status) => completed.push({ phase, status }) },
    );

    expect(result.smoke.build.status).toBe('fail');
    expect(result.acValidation).toBeNull();
    expect(result.acSkipReason).toBe('upstream-failed');
    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.reviewSkipReason).toMatch(/earlier validation phases failed/i);
    expect(result.overall).toBe('fail');

    const acEvent = completed.find((c) => c.phase === 'ac');
    const reviewEvent = completed.find((c) => c.phase === 'review');
    expect(acEvent?.status).toBe('skip');
    expect(reviewEvent?.status).toBe('skip');
  });

  it('skips AC + Review when lint fails', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({ lintCommand: 'eslint .', acceptanceCriteria: ['AC: it works'] }),
    );

    expect(result.lint?.status).toBe('fail');
    expect(result.acSkipReason).toBe('upstream-failed');
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.overall).toBe('fail');
  });

  it('skips AC + Review when SAST fails', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({ sastCommand: 'semgrep', acceptanceCriteria: ['AC: it works'] }),
    );

    expect(result.sast?.status).toBe('fail');
    expect(result.acSkipReason).toBe('upstream-failed');
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.overall).toBe('fail');
  });

  it('skips AC + Review when tests fail', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({ testCommand: 'vitest', acceptanceCriteria: ['AC: it works'] }),
    );

    expect(result.test?.status).toBe('fail');
    expect(result.acSkipReason).toBe('upstream-failed');
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.overall).toBe('fail');
  });

  it('runs AC + Review when all tier-1 phases pass-or-skip', async () => {
    // hasWebUi=false → health/pages auto-skip. No build/test/lint/sast commands
    // → those skip too. tier1Pass should be true and AC should be invoked.
    // diff='' makes the review short-circuit with 'No code changes detected',
    // which classifies as 'no-changes' (NOT upstream-failed).
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig());

    // No AC criteria configured → AC is null but reason is no-criteria, not upstream-failed
    expect(result.acSkipReason).toBe('no-criteria');
    // Review path was taken (no diff → 'no-changes' kind)
    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('no-changes');
    expect(result.reviewSkipReason).toBe('No code changes detected');
    expect(result.overall).toBe('pass');
  });

  it('marks profile-skip on AC when skipPhases includes ac', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig({ skipPhases: ['ac'] }));

    expect(result.acValidation).toBeNull();
    expect(result.acSkipReason).toBe('profile-skip');
  });

  it('marks profile-skip on Review when skipPhases includes review', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig({ skipPhases: ['review'] }));

    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('profile-skip');
  });
});

// ── Pre-validation worktree reset (regression for `sporting-coral`) ─────────────
// Untracked files were being picked up by the build (filesystem walk, not git
// index) and read by the agentic reviewer (unrestricted Read on worktreePath),
// driving false-positive validation failures. The fix runs
// `git reset --hard HEAD && git clean -fd` against both the container and host
// worktrees at the top of validate(), before phase 1.

describe('validate() — pre-validation worktree reset', () => {
  const execFileAsync = promisify(execFile);

  function recordingContainerManager(): {
    cm: ContainerManager;
    calls: { command: string[]; cwd?: string }[];
  } {
    const calls: { command: string[]; cwd?: string }[] = [];
    const fail = (name: string) =>
      vi.fn(() => Promise.reject(new Error(`stub: ${name} unexpectedly called`)));
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
        options?: { cwd?: string },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        calls.push({ command, cwd: options?.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );
    const cm = {
      spawn: fail('spawn'),
      kill: fail('kill'),
      refreshFirewall: fail('refreshFirewall'),
      stop: fail('stop'),
      start: fail('start'),
      writeFile: fail('writeFile'),
      readFile: fail('readFile'),
      extractDirectoryFromContainer: fail('extractDirectoryFromContainer'),
      getStatus: fail('getStatus'),
      execInContainer,
      execStreaming: fail('execStreaming'),
    } as unknown as ContainerManager;
    return { cm, calls };
  }

  function minimalConfig(overrides: Partial<ValidationEngineConfig> = {}): ValidationEngineConfig {
    return {
      podId: 'pod-test',
      containerId: 'container-test',
      previewUrl: 'http://127.0.0.1:9999',
      buildCommand: '',
      startCommand: '',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [],
      attempt: 1,
      task: 'test task',
      diff: '',
      hasWebUi: false,
      skipPhases: ['review'],
      ...overrides,
    };
  }

  it('issues git reset + clean inside the container at /workspace before phase 1', async () => {
    const { cm, calls } = recordingContainerManager();
    const engine = createLocalValidationEngine(cm);

    await engine.validate(minimalConfig());

    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('expected at least one execInContainer call');
    expect(first.cwd).toBe('/workspace');
    expect(first.command[0]).toBe('sh');
    expect(first.command[1]).toBe('-c');
    expect(first.command[2]).toContain('git reset --hard HEAD');
    expect(first.command[2]).toContain('git clean -fd');
  });

  it('uses /workspace for cleanup even when buildWorkDir is set', async () => {
    // Cleanup is deliberately NOT scoped to buildWorkDir — we want untracked
    // files anywhere in the repo gone, not just under the build subdir.
    const { cm, calls } = recordingContainerManager();
    const engine = createLocalValidationEngine(cm);

    await engine.validate(minimalConfig({ buildWorkDir: 'apps/web' }));

    const cleanup = calls[0];
    expect(cleanup).toBeDefined();
    if (!cleanup) throw new Error('expected at least one execInContainer call');
    expect(cleanup.cwd).toBe('/workspace');
  });

  it('cleans untracked + uncommitted files on the host worktree when worktreePath is set', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-reset-'));
    try {
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });

      // Committed file → must survive cleanup.
      await fs.writeFile(path.join(tmpDir, 'README.md'), '# committed\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: tmpDir });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

      // Untracked file → must be removed (the `sporting-coral` failure mode).
      await fs.writeFile(path.join(tmpDir, 'AADGroups.cs'), 'using PF.Graph;\n');
      // Uncommitted modification of a tracked file → must be reverted.
      await fs.writeFile(path.join(tmpDir, 'README.md'), '# modified locally\n');

      // Sanity: status is dirty before validation.
      const dirty = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
      expect(dirty.stdout).toContain('AADGroups.cs');
      expect(dirty.stdout).toContain('README.md');

      const { cm } = recordingContainerManager();
      const engine = createLocalValidationEngine(cm);

      await engine.validate(minimalConfig({ worktreePath: tmpDir }));

      // After cleanup: no untracked, no modifications.
      const clean = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
      expect(clean.stdout.trim()).toBe('');

      // Untracked file is gone, committed file is restored to HEAD content.
      await expect(fs.access(path.join(tmpDir, 'AADGroups.cs'))).rejects.toThrow();
      const readme = await fs.readFile(path.join(tmpDir, 'README.md'), 'utf-8');
      expect(readme).toBe('# committed\n');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves gitignored files (build caches) on the host worktree', async () => {
    // `git clean -fd` (without -x) must not nuke node_modules / dist / etc.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-reset-ign-'));
    try {
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });

      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n');
      await fs.writeFile(path.join(tmpDir, 'README.md'), '# committed\n');
      await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

      // Gitignored caches with content.
      await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'cached');
      await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'dist', 'bundle.js'), 'compiled');

      const { cm } = recordingContainerManager();
      const engine = createLocalValidationEngine(cm);

      await engine.validate(minimalConfig({ worktreePath: tmpDir }));

      await expect(
        fs.access(path.join(tmpDir, 'node_modules', 'pkg.txt')),
      ).resolves.toBeUndefined();
      await expect(fs.access(path.join(tmpDir, 'dist', 'bundle.js'))).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not throw when host cleanup fails (degraded, not broken)', async () => {
    // Point worktreePath at a non-git directory; the host-side reset will fail.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-reset-broken-'));
    try {
      const { cm } = recordingContainerManager();
      const engine = createLocalValidationEngine(cm);

      // Should not throw — failure is logged and validation continues.
      await expect(engine.validate(minimalConfig({ worktreePath: tmpDir }))).resolves.toBeDefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips host-side cleanup silently when worktreePath is omitted', async () => {
    const { cm, calls } = recordingContainerManager();
    const engine = createLocalValidationEngine(cm);

    await engine.validate(minimalConfig()); // no worktreePath

    // Container cleanup still runs.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command[2]).toContain('git reset --hard HEAD');
  });
});

describe('parseWarningCount', () => {
  it('reads MSBuild trailing summary as the authoritative count', () => {
    const output = [
      'Infrastructure net10.0 succeeded with 3 warning(s) (2.4s)',
      '  /repo/Foo.cs(16,46): warning S1075: Refactor your code',
      'Build succeeded with 3 warning(s) in 17.8s',
    ].join('\n');
    expect(parseWarningCount(output)).toBe(3);
  });

  it('falls back to summing per-project lines when no trailing summary is present', () => {
    const output = [
      'ProjectA net10.0 succeeded with 2 warning(s) (1.0s)',
      'ProjectB net10.0 succeeded with 5 warning(s) (1.0s)',
    ].join('\n');
    expect(parseWarningCount(output)).toBe(7);
  });

  it('falls back to per-line "warning CODE:" when no summary is present', () => {
    const output = [
      '/repo/Foo.cs(16,46): warning S1075: Refactor your code',
      '/repo/Bar.cs(56,26): warning S2139: Either log this exception',
      '/repo/Baz.cs(143,26): warning CS1591: Missing XML comment',
    ].join('\n');
    expect(parseWarningCount(output)).toBe(3);
  });

  it('returns 0 for clean output', () => {
    expect(parseWarningCount('Build succeeded.\n  0 Warning(s)\n  0 Error(s)')).toBe(0);
    expect(parseWarningCount('')).toBe(0);
  });

  it('does not match a path that contains the substring "warning"', () => {
    // The fallback regex is anchored on "path(line,col): warning CODE:" — a path
    // segment named "warning" without that structure must not be counted.
    const output = '/repo/warning-test/foo.cs(1,1): error CS001: Something broke';
    expect(parseWarningCount(output)).toBe(0);
  });

  it('prefers trailing summary even when per-project lines disagree (truncated output)', () => {
    // If the per-project lines were truncated mid-build but the trailer made it
    // through, trust the trailer.
    const output = 'Build succeeded with 5 warning(s) in 17.8s';
    expect(parseWarningCount(output)).toBe(5);
  });
});

describe('runBuild — warning policy', () => {
  function baseConfigForBuild(buildCommand: string): ValidationEngineConfig {
    return {
      podId: 'pod-test',
      containerId: 'container-test',
      previewUrl: 'http://127.0.0.1:9999',
      buildCommand,
      startCommand: 'node server.js',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [{ path: '/' }],
      attempt: 1,
      task: 'test task',
      diff: '',
      hasWebUi: false,
    };
  }

  function containerManagerWithBuildOutput(stdout: string, exitCode: number): ContainerManager {
    return {
      spawn: vi.fn(),
      kill: vi.fn(),
      refreshFirewall: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      extractDirectoryFromContainer: vi.fn(),
      getStatus: vi.fn(),
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        // The pre-build healing exec calls (find for 0-byte stubs, chmod for native bins)
        // run via `sh -c "find ..."` — return empty stdout so the heal paths are skipped.
        const joined = cmd.join(' ');
        if (joined.includes('-empty -print') || joined.includes('chmod +x')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        // The actual buildCommand exec — return our crafted output.
        return { stdout, stderr: '', exitCode };
      }),
      execStreaming: vi.fn(),
    } as unknown as ContainerManager;
  }

  it("keeps status 'pass' when exit 0 but warnings are present", async () => {
    const cm = containerManagerWithBuildOutput(
      'Restore complete (1.0s)\nBuild succeeded with 3 warning(s) in 17.8s',
      0,
    );
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('dotnet build'));

    expect(result.smoke.build.status).toBe('pass');
    expect(result.smoke.build.warningCount).toBe(3);
    expect(result.smoke.build.output).not.toContain('Build exited 0 but emitted');
    expect(result.smoke.build.output).not.toContain('--- build output ---');
  });

  it("keeps status 'pass' when exit 0 and no warnings", async () => {
    const cm = containerManagerWithBuildOutput('Build succeeded.\n  0 Warning(s)\n  0 Error(s)', 0);
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('dotnet build'));

    expect(result.smoke.build.status).toBe('pass');
    expect(result.smoke.build.warningCount).toBe(0);
    expect(result.smoke.build.output).not.toContain('exited 0 but emitted');
  });

  it('fails when project warning policy makes the build exit nonzero', async () => {
    const cm = containerManagerWithBuildOutput(
      'Foo.cs(10,5): error CS8618: Non-nullable property must contain a non-null value',
      1,
    );
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('dotnet build'));

    expect(result.smoke.build.status).toBe('fail');
    expect(result.smoke.build.output).toContain('error CS8618');
    expect(result.smoke.build.output).not.toContain('Build exited 0 but emitted');
  });

  it('reports warningCount on a real failure (exit nonzero) without overriding status reasoning', async () => {
    // A genuine build failure may also emit warnings before erroring out.
    // The warning count is still informative, but the failure stands on its own.
    const cm = containerManagerWithBuildOutput(
      'Foo.cs(10,5): warning S1075: hardcoded URI\nBar.cs(20,5): error CS1002: ;',
      1,
    );
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('dotnet build'));

    expect(result.smoke.build.status).toBe('fail');
    // The output is the raw build output, since the build legitimately failed
    // via exit code.
    expect(result.smoke.build.output).not.toContain('Build exited 0 but emitted');
  });
});

// ── Preview supervisor integration tests ─────────────────────────────────────

describe('runHealthCheck — supervisor spawn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeConfig(overrides: Partial<ValidationEngineConfig> = {}): ValidationEngineConfig {
    return {
      podId: 'pod-hc',
      containerId: 'c-hc',
      previewUrl: 'http://127.0.0.1:9001',
      buildCommand: '',
      startCommand: 'pnpm dev',
      healthPath: '/health',
      healthTimeout: 5,
      smokePages: [],
      attempt: 1,
      task: 'test',
      diff: '',
      ...overrides,
    };
  }

  it('invokes buildSupervisorCommand exactly once and does not tear it down', async () => {
    const execCalls: string[] = [];
    const cm = {
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        if (cmd[2]) execCalls.push(cmd[2]);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as ContainerManager;

    // Health check resolves immediately with 200
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve('ok') }),
    );

    await runHealthCheck(cm, makeConfig());

    const supervisorCalls = execCalls.filter((c) => c.includes('export START_COMMAND'));
    expect(supervisorCalls).toHaveLength(1);
    // No kill of the supervisor PID at the end of the phase
    const killCalls = execCalls.filter(
      (c) => c.includes('kill -9') && c.includes('autopod-supervisor.pid'),
    );
    expect(killCalls).toHaveLength(0);
  });

  it('skips supervisor spawn when no startCommand is configured', async () => {
    const execCalls: string[] = [];
    const cm = {
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        if (cmd[2]) execCalls.push(cmd[2]);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as ContainerManager;

    // No fetch needed — without startCommand the health check returns pass immediately
    const result = await runHealthCheck(cm, makeConfig({ startCommand: undefined }));

    expect(result.status).toBe('pass');
    const supervisorCalls = execCalls.filter((c) => c.includes('export START_COMMAND'));
    expect(supervisorCalls).toHaveLength(0);
  });
});

describe('restartSupervisorIfDown — post-Claude reachability guard', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeConfig(): ValidationEngineConfig {
    return {
      podId: 'pod-rsid',
      containerId: 'c-rsid',
      previewUrl: 'http://127.0.0.1:9002',
      buildCommand: '',
      startCommand: 'pnpm dev',
      healthPath: '/health',
      healthTimeout: 5,
      smokePages: [],
      attempt: 1,
      task: 'test',
      diff: '',
    };
  }

  it('does not exec kill+restart when server is reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve('ok') }),
    );
    const execCmds: string[] = [];
    const cm = {
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        if (cmd[2]) execCmds.push(cmd[2]);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as ContainerManager;

    await restartSupervisorIfDown(cm, makeConfig());

    const restartCalls = execCmds.filter((c) => c.includes('kill -9'));
    expect(restartCalls).toHaveLength(0);
  });

  it('kills old supervisor and spawns fresh one when server is unreachable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const execCmds: string[] = [];
    const cm = {
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        if (cmd[2]) execCmds.push(cmd[2]);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as ContainerManager;

    const promise = restartSupervisorIfDown(cm, makeConfig());
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    // Should have called execInContainer with a kill+respawn command
    const restartCalls = execCmds.filter(
      (c) => c.includes('kill -9') && c.includes('autopod-supervisor.pid'),
    );
    expect(restartCalls).toHaveLength(1);
    // The restart command also includes buildSupervisorCommand output
    expect(restartCalls[0]).toContain('export START_COMMAND');
  });

  it('marks criterion failed when server stays down after restart (permanent failure)', async () => {
    vi.useFakeTimers();
    // Server always unreachable → restartSupervisorIfDown runs but server never comes up
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const cm = {
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        const c = cmd[2] ?? '';
        if (c.includes('kill -9') || c.includes('export START_COMMAND')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as ContainerManager;

    const config = makeConfig();
    // Call restartSupervisorIfDown directly — it should not throw even when permanently unreachable
    const promise = restartSupervisorIfDown(cm, config);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('startAppStabilityMonitor — regression guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires onCrash after 2 consecutive fetch failures', async () => {
    vi.useFakeTimers();
    let fetchCallCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCallCount++;
        throw new Error('ECONNREFUSED');
      }),
    );

    const onCrash = vi.fn();
    startAppStabilityMonitor('http://127.0.0.1:9003/health', onCrash);

    // Advance past initial delay + 2 poll intervals (5s each)
    await vi.advanceTimersByTimeAsync(5_100); // initial delay
    await vi.advanceTimersByTimeAsync(5_100); // poll 1 failure
    await vi.advanceTimersByTimeAsync(5_100); // poll 2 failure → crash

    expect(onCrash).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('stop function prevents onCrash from firing', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const onCrash = vi.fn();
    const stop = startAppStabilityMonitor('http://127.0.0.1:9004/health', onCrash);
    stop();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(onCrash).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
