import { describe, expect, it } from 'vitest';
import {
  buildReviewPrompt,
  deduplicateAcsByBaseText,
  enforceRequirementsStatus,
  parseAcInstructionsJson,
  parseAcResults,
  parseApiCheckSpecs,
  parseClassificationJson,
  stripMarkdownFences,
} from './local-validation-engine.js';

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
  const acs = [acTypeExport, acApiEndpoint, acUiToggle];

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
    const result = parseClassificationJson(input, [acTypeExport]);
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
      acApiEndpoint,
    ]);
    expect(result).toHaveLength(1);
    expect(result?.at(0)?.validationType).toBe('api');
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
      'POST /jobs returns 201',
      'GET /jobs returns 200',
      'DELETE /jobs/{id} returns 204',
    ];
    const { deduped } = deduplicateAcsByBaseText(acs);
    expect(deduped).toHaveLength(3);
    expect(deduped).toEqual(acs);
  });

  it('deduplicates exact duplicates', () => {
    const acs = ['POST /jobs returns 201', 'POST /jobs returns 201'];
    const { deduped } = deduplicateAcsByBaseText(acs);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toBe('POST /jobs returns 201');
  });

  it('deduplicates when one AC is the other plus a parenthetical suffix', () => {
    const short = 'POST /jobs returns 201';
    const long =
      'POST /jobs returns 201 (HTTP status code is directly verifiable via a POST request)';
    const { deduped } = deduplicateAcsByBaseText([short, long]);
    expect(deduped).toHaveLength(1);
    // Keeps the longer (more informative) form
    expect(deduped[0]).toBe(long);
  });

  it('deduplicates and keeps longest when long form comes first', () => {
    const short = 'ConsecutiveFailureCount increments by 1 on each failure';
    const long =
      'ConsecutiveFailureCount increments by 1 on each failure (ConsecutiveFailureCount is a persisted job field verifiable via GET /api/schedule/jobs/{id} after induced failures.)';
    const { deduped } = deduplicateAcsByBaseText([long, short]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toBe(long);
  });

  it('expandResult maps canonical result back to all original criteria', () => {
    const short = 'POST /jobs returns 201';
    const long = 'POST /jobs returns 201 (HTTP status code is directly verifiable)';
    const { expandResult } = deduplicateAcsByBaseText([short, long]);

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
    const { expandResult } = deduplicateAcsByBaseText([short, long]);

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
    const { deduped } = deduplicateAcsByBaseText([unique, short, long]);
    expect(deduped).toHaveLength(2);
    expect(deduped).toContain(unique);
    expect(deduped).toContain(long);
    expect(deduped).not.toContain(short);
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
    sessionId: 'sess-1',
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
    expect(prompt).toContain('ACCEPTANCE CRITERIA — DIFF VERIFICATION REQUIRED');
    expect(prompt).toContain('Scheduler runs on startup');
    expect(prompt).toContain('ConsecutiveFailureCount increments on failure');
    expect(prompt).toContain('YOU ARE THE ONLY CHECK');
  });

  it('renders AUTO-VERIFIED section for non-none ACs when noneAcCriteria is provided', () => {
    const config = {
      ...baseConfig,
      acceptanceCriteria: ['POST /api/jobs returns 201', 'Scheduler runs on startup'],
    };
    const noneAcs = ['Scheduler runs on startup'];
    const prompt = buildReviewPrompt(config, undefined, noneAcs);
    expect(prompt).toContain('ACCEPTANCE CRITERIA — AUTO-VERIFIED');
    expect(prompt).toContain('POST /api/jobs returns 201');
    expect(prompt).toContain('ACCEPTANCE CRITERIA — DIFF VERIFICATION REQUIRED');
    expect(prompt).toContain('Scheduler runs on startup');
    // The auto-verified section should NOT include the none AC
    const autoSectionMatch = prompt.match(/AUTO-VERIFIED[\s\S]*?DIFF VERIFICATION/);
    expect(autoSectionMatch?.[0]).not.toContain('Scheduler runs on startup');
  });

  it('omits DIFF VERIFICATION section when noneAcCriteria is empty', () => {
    const config = { ...baseConfig, acceptanceCriteria: ['POST /api/jobs returns 201'] };
    const prompt = buildReviewPrompt(config, undefined, []);
    expect(prompt).not.toContain('DIFF VERIFICATION REQUIRED');
  });

  it('omits AUTO-VERIFIED section when all ACs are none-classified', () => {
    const config = { ...baseConfig, acceptanceCriteria: ['Scheduler runs on startup'] };
    const noneAcs = ['Scheduler runs on startup'];
    const prompt = buildReviewPrompt(config, undefined, noneAcs);
    expect(prompt).not.toContain('AUTO-VERIFIED');
    expect(prompt).toContain('DIFF VERIFICATION REQUIRED');
  });

  it('omits requirementsCheck from JSON format comment when no none ACs', () => {
    const config = { ...baseConfig, acceptanceCriteria: ['POST /api/jobs returns 201'] };
    const prompt = buildReviewPrompt(config, undefined, []);
    // Standard requirementsCheck format (not the diff-only variant)
    expect(prompt).toContain('"requirementsCheck"');
    expect(prompt).not.toContain('DIFF VERIFICATION REQUIRED');
  });

  it('instructs reviewer to include only DIFF VERIFICATION criteria in requirementsCheck', () => {
    const config = {
      ...baseConfig,
      acceptanceCriteria: ['POST /api/jobs returns 201', 'Scheduler runs on startup'],
    };
    const noneAcs = ['Scheduler runs on startup'];
    const prompt = buildReviewPrompt(config, undefined, noneAcs);
    expect(prompt).toContain('Include ONLY the "DIFF VERIFICATION REQUIRED" criteria');
    expect(prompt).toContain('Do NOT include auto-verified');
  });
});
