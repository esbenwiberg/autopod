import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import { verifyValidationRecoveryReports } from './validation-recovery-reports.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('requires report bytes in the verified snapshot, including absolute workspace paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'validation-reports-'));
  roots.push(root);
  const result = createFailingValidationResult('recovery-example');
  result.factValidation = {
    status: 'fail',
    results: [
      {
        factId: 'report',
        proves: [],
        artifactPath: '/workspace/reports/test.json',
        command: 'test',
        passed: false,
        durationMs: 1,
        reasoning: 'failed',
      },
    ],
  };
  await expect(verifyValidationRecoveryReports(root, result)).rejects.toMatchObject({
    code: 'VALIDATION_REPORT_PRESERVATION_REQUIRED',
  });
  await mkdir(path.join(root, 'reports'));
  await writeFile(path.join(root, 'reports/test.json'), 'partial report');
  await expect(verifyValidationRecoveryReports(root, result)).resolves.toBeUndefined();
  result.factValidation.results[0]!.artifactPath = '../outside';
  await expect(verifyValidationRecoveryReports(root, result)).rejects.toThrow(
    'outside the preserved workspace',
  );
  result.factValidation.results[0]!.artifactPath = '/tmp/unretained';
  await expect(verifyValidationRecoveryReports(root, result)).rejects.toThrow(
    'outside the preserved workspace',
  );
});
it('rejects a required report symlink escaping the retained snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'validation-report-links-'));
  roots.push(root);
  await mkdir(path.join(root, 'snapshot'));
  await writeFile(path.join(root, 'outside'), 'not retained');
  await symlink('../outside', path.join(root, 'snapshot', 'report'));
  const result = createFailingValidationResult('recovery-example');
  result.factValidation = {
    status: 'fail',
    results: [
      {
        factId: 'report',
        proves: [],
        artifactPath: 'report',
        command: 'test',
        passed: false,
        durationMs: 1,
        reasoning: 'failed',
      },
    ],
  };
  await expect(
    verifyValidationRecoveryReports(path.join(root, 'snapshot'), result),
  ).rejects.toMatchObject({ code: 'VALIDATION_REPORT_PRESERVATION_REQUIRED' });
});
