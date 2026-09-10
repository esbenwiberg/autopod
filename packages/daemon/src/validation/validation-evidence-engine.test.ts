import type { ValidationInputIdentity } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { validationCoverage } from '../pods/validation-coverage.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createLocalValidationEngine } from './local-validation-engine.js';
import { createValidationEvidenceCache } from './validation-evidence-cache.js';

const identity: ValidationInputIdentity = {
  version: 1,
  hermetic: true,
  sourceTree: '1'.repeat(64),
  contract: '2'.repeat(64),
  toolchain: '3'.repeat(64),
  commands: '4'.repeat(64),
  dependencies: '5'.repeat(64),
  environment: '6'.repeat(64),
  implementation: '7'.repeat(64),
};
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  db.prepare(`INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
    VALUES ('original', 'test-profile', 'validate', 'validating', 'model', 'codex', 'branch', 'user')`).run();
  const exec = vi.fn(async () => ({ stdout: 'passed', stderr: '', exitCode: 0 }));
  const cm = { execInContainer: exec } as unknown as ContainerManager;
  const cache = createValidationEvidenceCache(db);
  const engine = createLocalValidationEngine(cm, undefined, undefined, undefined, cache);
  const config: ValidationEngineConfig = {
    podId: 'original',
    containerId: 'fixture',
    previewUrl: '',
    buildCommand: 'node build.cjs',
    lintCommand: 'node lint.cjs',
    testCommand: 'node test.cjs',
    startCommand: '',
    healthPath: '/',
    healthTimeout: 1,
    smokePages: [],
    attempt: 1,
    task: 'test deterministic validation',
    diff: '',
    hasWebUi: false,
    captureEvidenceIdentity: async () => identity,
  };
  const count = (command: string) =>
    exec.mock.calls.filter((call) => (call as unknown as [string, string[]])[1][2] === command)
      .length;
  return { db, exec, engine, config, count };
}
describe('actual validation engine evidence reuse', () => {
  it('reuses only matching successful lint/test evidence and still executes build on every run', async () => {
    const { db, engine, config, count } = fixture();
    try {
      const first = await engine.validate(config);
      const second = await engine.validate({ ...config, attempt: 2 });
      expect(first.overall).toBe('pass');
      expect(second.overall).toBe('pass');
      expect(count('node build.cjs')).toBe(2);
      expect(count('node lint.cjs')).toBe(1);
      expect(count('node test.cjs')).toBe(1);
      expect(second.test?.reusedEvidence?.receiptId).toBeTruthy();
      expect(validationCoverage(second).find((entry) => entry.stage === 'test')?.executed).toBe(
        false,
      );
      expect(validationCoverage(first).find((entry) => entry.stage === 'test')?.executed).toBe(
        true,
      );
      await engine.validate({
        ...config,
        attempt: 3,
        captureEvidenceIdentity: async () => ({ ...identity, environment: 'a'.repeat(64) }),
      });
      expect(count('node test.cjs')).toBe(2);
    } finally {
      db.close();
    }
  });
  it('executes all configured checks when complete identity is unavailable', async () => {
    const { db, engine, config, count } = fixture();
    try {
      await engine.validate(config);
      await engine.validate({
        ...config,
        attempt: 2,
        captureEvidenceIdentity: async () => undefined,
      });
      expect(count('node lint.cjs')).toBe(2);
      expect(count('node test.cjs')).toBe(2);
    } finally {
      db.close();
    }
  });
});
