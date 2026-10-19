import { afterEach, describe, expect, it } from 'vitest';
import type { StoredScan } from '../security/scan-repository.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import {
  REWORK_IN_PROGRESS_PREFIX,
  buildManualReworkReason,
  renderPiHandoffFile,
  sanitizeSecurityReworkValue,
} from './continuation-policy.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture() {
  const ctx = createTestContext();
  cleanups.push(() => ctx.db.close());
  ctx.podRepo.insert({
    id: 'policy',
    profileName: 'test-profile',
    task: 'Original task',
    status: 'failed',
    runtime: 'claude',
    model: 'opus',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  return ctx.podRepo.getOrThrow('policy');
}
describe('continuation policy', () => {
  it.each(['failed', 'review_required', 'killed', 'validated'] as const)(
    'retains %s manual rework reason',
    (status) => {
      const text = buildManualReworkReason({ ...fixture(), status });
      expect(text).toContain(
        status === 'failed'
          ? 'previous attempt failed'
          : status === 'review_required'
            ? 'exhausted its validation attempts'
            : status === 'killed'
              ? 'previous pod was killed'
              : 'previous work needs revision',
      );
    },
  );
  it('prioritizes validation feedback over scanner metadata and retains the original task', () => {
    const pod = fixture();
    const result = buildManualReworkReason({
      ...pod,
      status: 'review_required',
      lastValidationResult: {
        podId: pod.id,
        attempt: 2,
        timestamp: '2026-10-18',
        overall: 'fail',
        smoke: {
          status: 'fail',
          build: { status: 'fail', output: 'Build issue', duration: 1 },
          health: { status: 'skip', url: '', responseCode: null, duration: 0 },
          pages: [],
        },
        taskReview: null,
        duration: 1,
      },
    });
    expect(result).toContain('Manual rework after validation attempts were exhausted');
    expect(result).toContain('Validation Failed (attempt 2/3)');
    expect(result).toContain('Build issue');
    expect(result).toContain('Original task');
  });
  it('uses only structured scanner metadata and preserves the remediation instruction', () => {
    const scan: StoredScan = {
      id: 'scan',
      podId: 'policy',
      checkpoint: 'push',
      decision: 'block',
      startedAt: 1,
      completedAt: 2,
      filesScanned: 1,
      filesSkipped: 0,
      scanIncomplete: false,
      findings: [
        {
          detector: 'secrets',
          severity: 'high',
          file: 'src/test.ts',
          line: 4,
          ruleId: 'fixture',
          confidence: 0.9,
          snippet: 'matched-content-must-not-appear',
        },
      ],
    };
    const text = buildManualReworkReason(fixture(), scan);
    expect(text).toContain('location=src/test.ts:4');
    expect(text).toContain('rule=fixture');
    expect(text).toContain('Do not bypass, disable, or suppress the scanner');
    expect(text).not.toContain('matched-content-must-not-appear');
    expect(buildManualReworkReason(fixture(), { ...scan, decision: 'pass' })).not.toContain(
      'Blocked findings',
    );
  });
  it('bounds and normalizes metadata and uses a fallback for absent text', () => {
    expect(sanitizeSecurityReworkValue('  ordinary\n  metadata  ', 'fallback')).toBe(
      'ordinary metadata',
    );
    expect(sanitizeSecurityReworkValue(undefined, 'fallback')).toBe('fallback');
    expect(sanitizeSecurityReworkValue(' ', 'fallback')).toBe('fallback');
    expect(sanitizeSecurityReworkValue('a'.repeat(500), 'fallback')).toHaveLength(400);
  });
  it('renders the managed Pi handoff with trimmed verbatim instructions', () => {
    expect(REWORK_IN_PROGRESS_PREFIX).toBe('[REWORK IN PROGRESS]');
    expect(renderPiHandoffFile('  First line\n\nSecond `line`  ')).toBe(
      "<!-- Autopod-managed: a copy of this pod's handoff instructions.\n     Git-excluded — edits here are not tracked and will not be committed\n     unless you `git add -f` this path. -->\n\n# Pi handoff\n\nFirst line\n\nSecond `line`\n",
    );
  });
});
