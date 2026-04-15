import { describe, expect, it } from 'vitest';
import {
  parseAcInstructionsJson,
  parseAcResults,
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
