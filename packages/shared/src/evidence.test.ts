import { describe, expect, it } from 'vitest';
import { buildEvidenceDocument, renderEvidenceYaml } from './evidence.js';
import type { SpecContract } from './types/contract.js';
import type { ValidationResult } from './types/validation.js';

const contract: SpecContract = {
  contractVersion: 1,
  title: 'Add finding lifecycle storage',
  dependsOn: [],
  scenarios: [
    {
      id: 'finding-created',
      given: ['a validation finding exists'],
      when: ['the validator stores evidence'],
      then: ['the finding can be audited later'],
    },
  ],
  requiredFacts: [
    {
      id: 'fact-finding-created',
      proves: ['finding-created'],
      kind: 'integration-test',
      artifact: { path: 'packages/daemon/src/pods/finding.test.ts', change: 'create' },
      command: 'npx pnpm --filter @autopod/daemon test -- finding.test.ts',
    },
  ],
  humanReview: [],
};

const validation: ValidationResult = {
  podId: 'pod-123',
  attempt: 2,
  timestamp: '2026-05-18T10:00:00.000Z',
  smoke: {
    status: 'pass',
    build: { status: 'pass', output: '', duration: 1 },
    health: { status: 'skip', url: '', responseCode: null, duration: 0 },
    pages: [],
  },
  factValidation: {
    status: 'pass',
    results: [
      {
        factId: 'fact-finding-created',
        proves: ['finding-created'],
        kind: 'integration-test',
        artifactPath: 'packages/daemon/src/pods/finding.test.ts',
        command: 'npx pnpm --filter @autopod/daemon test -- finding.test.ts',
        passed: true,
        status: 'pass',
        exitCode: 0,
        durationMs: 1234,
        artifact: {
          path: 'packages/daemon/src/pods/finding.test.ts',
          change: 'create',
          exists: true,
          changed: true,
          hash: 'abc123',
        },
        attachments: [],
        reasoning: 'Fact passed.',
        stdout: '✓ finding-created',
      },
    ],
  },
  taskReview: null,
  overall: 'pass',
  duration: 1234,
};

describe('evidence document', () => {
  it('builds attempt-scoped fact evidence from validation results', () => {
    const doc = buildEvidenceDocument({ podId: 'pod-123', attempt: 2, validation, contract });
    expect(doc).toMatchObject({
      evidence_version: 1,
      pod_id: 'pod-123',
      attempt: 2,
      contract: {
        title: 'Add finding lifecycle storage',
        scenarios: ['finding-created'],
        required_facts: ['fact-finding-created'],
      },
      facts: [
        {
          id: 'fact-finding-created',
          status: 'pass',
          kind: 'integration-test',
          exit_code: 0,
          duration_ms: 1234,
          artifact: {
            exists: true,
            changed: true,
            hash: 'abc123',
          },
        },
      ],
    });
  });

  it('renders yaml for external review without asking workers to author it', () => {
    const yaml = renderEvidenceYaml({ podId: 'pod-123', attempt: 2, validation, contract });
    expect(yaml).toContain('evidence_version: 1');
    expect(yaml).toContain('id: fact-finding-created');
    expect(yaml).toContain('exit_code: 0');
    expect(yaml).toContain('hash: abc123');
  });
});
