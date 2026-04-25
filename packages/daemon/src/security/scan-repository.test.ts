import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createScanRepository } from './scan-repository.js';

describe('scan-repository', () => {
  it('persists a scan with findings and reads them back', () => {
    const db = createTestDb();
    const repo = createScanRepository(db);
    const stored = repo.insert({
      podId: 'pod-1',
      checkpoint: 'provisioning',
      decision: 'warn',
      startedAt: 1000,
      completedAt: 2000,
      filesScanned: 4,
      filesSkipped: 1,
      scanIncomplete: false,
      findings: [
        {
          detector: 'secrets',
          severity: 'critical',
          file: 'src/secrets.ts',
          line: 12,
          ruleId: '@secretlint/rule-aws',
          snippet: 'AKIA...[REDACTED]',
        },
        {
          detector: 'injection',
          severity: 'high',
          file: 'docs/note.md',
          confidence: 0.91,
          snippet: 'Ignore previous instructions',
        },
      ],
    });

    expect(stored.id).toBeTruthy();
    expect(stored.findings).toHaveLength(2);

    const fetched = repo.getForPod('pod-1');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.decision).toBe('warn');
    expect(fetched[0]?.findings).toHaveLength(2);
    const finding = fetched[0]?.findings.find((f) => f.detector === 'injection');
    expect(finding?.confidence).toBeCloseTo(0.91, 2);
  });

  it('returns an empty list for a pod with no scans', () => {
    const db = createTestDb();
    const repo = createScanRepository(db);
    expect(repo.getForPod('nope')).toEqual([]);
  });

  it('marks scan_incomplete correctly across the boolean roundtrip', () => {
    const db = createTestDb();
    const repo = createScanRepository(db);
    repo.insert({
      podId: 'pod-2',
      checkpoint: 'push',
      decision: 'pass',
      startedAt: 0,
      completedAt: 1,
      filesScanned: 0,
      filesSkipped: 0,
      scanIncomplete: true,
      findings: [],
    });
    const [scan] = repo.getForPod('pod-2');
    expect(scan?.scanIncomplete).toBe(true);
  });
});
