import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pod, ValidationResult } from '@autopod/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import {
  assertProtectedOperationalPathsInScope,
  failedFactIds,
  failedValidationPhases,
  getPodValidationSkipPhases,
  getPodValidationSuite,
  hasPendingFactDecision,
  isPodValidationDisabled,
  loadCodeReviewSkill,
  makeUnexpectedValidationFailureResult,
  podExplicitlyScopesOperationalPaths,
  protectedOperationalPathReason,
  summarizeValidationPhases,
} from './validation-workflow-policy.js';
import { createValidationWorkflowState } from './validation-workflow-state.js';
type FactCheckResult = NonNullable<ValidationResult['factValidation']>['results'][number];
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  try {
    const repo = createPodRepository(db);
    repo.insert({
      id: 'policy',
      profileName: 'test-profile',
      task: 'Ordinary task',
      status: 'running',
      runtime: 'claude',
      model: 'test-model',
      executionTarget: 'local',
      branch: 'autopod/policy',
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    return {
      pod: repo.getOrThrow('policy'),
      profile: createMockProfileStore(db).get('test-profile'),
    };
  } finally {
    db.close();
  }
}
function result(): ValidationResult {
  return {
    podId: 'policy',
    attempt: 2,
    timestamp: '2026-10-18T12:00:00Z',
    overall: 'pass',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'pass', url: 'http://fixture', responseCode: 200, duration: 1 },
      pages: [],
    },
    taskReview: null,
    duration: 2,
  };
}
function fact(status: FactCheckResult['status'], exitCode?: number): FactCheckResult {
  return {
    factId: 'proof',
    proves: [],
    artifactPath: 'proof.json',
    command: 'prove',
    passed: status === 'pass',
    status,
    exitCode,
    reasoning: 'Fact evidence',
  };
}
describe('validation workflow policy and state', () => {
  it('keeps collection identity within one owner and separates manager instances', () => {
    const a = createValidationWorkflowState();
    const b = createValidationWorkflowState();
    const controller = new AbortController();
    a.validationAbortControllers.set('pod', controller);
    a.pendingUpdateFromBaseIntents.add('pod');
    a.attemptExtensionRuns.set('pod', Promise.resolve());
    expect(a.validationAbortControllers.get('pod')).toBe(controller);
    expect(b.validationAbortControllers.size).toBe(0);
    expect(b.pendingUpdateFromBaseIntents.size).toBe(0);
    expect(b.attemptExtensionRuns.size).toBe(0);
  });
  it('summarizes blocking phases in order and marks infrastructure failures without changing the result', () => {
    const r = result();
    r.infrastructureFailure = {
      phase: 'test',
      code: 'TOOL_UNAVAILABLE',
      message: 'Unavailable',
      retryable: true,
    };
    const before = structuredClone(r);
    expect(summarizeValidationPhases(r)).toBe(
      'setup: skip, lint: skip, sast: skip, build: pass, tests: infrastructure_error, health: pass, pages: skip, facts: skip, review: skip',
    );
    expect(r).toEqual(before);
  });
  it('retains failure labels and failed fact identities, including false legacy passed flags', () => {
    const r = result();
    r.setup = { status: 'fail', output: '', duration: 1 };
    r.smoke.build.status = 'fail';
    r.smoke.health.status = 'fail';
    r.factValidation = {
      status: 'fail',
      results: [fact('fail'), { ...fact('waived'), factId: 'legacy', passed: false }],
    };
    expect(failedValidationPhases(r)).toEqual(['setup', 'build', 'health', 'facts']);
    expect(failedFactIds(r)).toEqual(['proof', 'legacy']);
    expect(failedValidationPhases(null)).toEqual([]);
    expect(failedFactIds(null)).toEqual([]);
    expect(summarizeValidationPhases(r)).toContain('build: skip');
  });
  it.each([undefined, 0, 127])(
    'distinguishes human fact decisions from a missing command (exit=%s)',
    (exitCode) => {
      const r = result();
      r.factValidation = { status: 'pending_human', results: [fact('pending_human', exitCode)] };
      expect(hasPendingFactDecision(r)).toBe(exitCode !== 127);
      expect(hasPendingFactDecision(null)).toBe(false);
    },
  );
  it.each([
    '.mcp.json',
    '.husky/pre-commit',
    '.githooks/pre-commit',
    '.git/hooks/pre-commit',
    '.claude/settings.json',
    '.codex/config.toml',
  ])('blocks unscoped operational changes to %s', (file) => {
    const { pod } = fixture();
    expect(protectedOperationalPathReason(file)).toBe('agent/runtime operational path');
    expect(() => assertProtectedOperationalPathsInScope(pod, [file])).toThrow(
      expect.objectContaining({ code: 'PROTECTED_OPERATIONAL_PATHS_CHANGED', statusCode: 422 }),
    );
  });
  it('allows ordinary paths and operational scope disclosed in task/summary/touches', () => {
    const { pod } = fixture();
    expect(protectedOperationalPathReason('src/app.ts')).toBeNull();
    expect(() => assertProtectedOperationalPathsInScope(pod, ['src/app.ts'])).not.toThrow();
    for (const scoped of [
      { ...pod, task: 'Fix MCP settings' },
      { ...pod, touches: ['.husky/pre-commit'] },
      { ...pod, taskSummary: { actualSummary: 'Changed agent tooling', deviations: [] } },
    ]) {
      expect(podExplicitlyScopesOperationalPaths(scoped)).toBe(true);
      expect(() => assertProtectedOperationalPathsInScope(scoped, ['.mcp.json'])).not.toThrow();
    }
  });
  it('preserves suite default, explicit off and skip switches', () => {
    const { pod, profile } = fixture();
    expect(getPodValidationSuite(pod)).toBe('full');
    expect(isPodValidationDisabled(pod)).toBe(false);
    const off: Pod = { ...pod, options: { ...pod.options, validationSuite: 'off' } };
    expect(getPodValidationSuite(off)).toBe('off');
    expect(isPodValidationDisabled(off)).toBe(true);
    expect(getPodValidationSkipPhases(profile, off)).toContain('build');
    expect(isPodValidationDisabled({ ...pod, skipValidation: true })).toBe(true);
    expect(getPodValidationSuite({ ...pod, options: { ...pod.options, validate: false } })).toBe(
      'full',
    );
    expect(isPodValidationDisabled({ ...pod, options: { ...pod.options, validate: false } })).toBe(
      true,
    );
    expect(
      getPodValidationSuite({
        ...pod,
        options: { ...pod.options, validationSuite: undefined, validate: false },
      }),
    ).toBe('off');
  });
  it.each(['message', 'status', 'ordinary'] as const)(
    'keeps unexpected validation errors classified by %s',
    (kind) => {
      const error =
        kind === 'message'
          ? new Error('container stopped/paused')
          : kind === 'status'
            ? Object.assign(new Error('Conflict'), { statusCode: 409 })
            : new Error('Ordinary failure');
      const r = makeUnexpectedValidationFailureResult('pod', 3, error);
      expect(r).toMatchObject({
        podId: 'pod',
        attempt: 3,
        overall: 'fail',
        duration: 0,
        smoke: {
          build: { status: 'fail', duration: 0 },
          health: { status: 'fail', responseCode: null },
          pages: [],
        },
        taskReview: null,
      });
      expect(r.smoke.build.output).toBe(
        kind === 'ordinary'
          ? 'Error: Ordinary failure'
          : 'Container exited before validation could run — check agent logs for errors',
      );
    },
  );
  it('loads preferred or fallback review skills and leaves an absent skill optional', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'validation-policy-'));
    roots.push(root);
    expect(await loadCodeReviewSkill(root)).toBeUndefined();
    await fs.mkdir(path.join(root, '.claude/skills'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude/skills/code-review.md'), 'fallback');
    expect(await loadCodeReviewSkill(root)).toBe('fallback');
    await fs.mkdir(path.join(root, 'skills'));
    await fs.writeFile(path.join(root, 'skills/code-review.md'), 'preferred');
    expect(await loadCodeReviewSkill(root)).toBe('preferred');
  });
});
