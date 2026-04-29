import { describe, expect, it, vi } from 'vitest';
import type { ValidationPhaseName, ValidationPhaseResult } from '../pod-bridge.js';
import { validateLocally } from './validate-locally.js';

type PhaseStub = Partial<ValidationPhaseResult>;

function makeBridge(stubs: Partial<Record<ValidationPhaseName, PhaseStub>>) {
  const runValidationPhase = vi
    .fn<(podId: string, phase: ValidationPhaseName) => Promise<ValidationPhaseResult>>()
    .mockImplementation(async (_podId, phase) => {
      const stub = stubs[phase] ?? { configured: false };
      return {
        phase,
        configured: stub.configured ?? false,
        passed: stub.passed ?? false,
        exitCode: stub.exitCode ?? null,
        command: stub.command ?? null,
        durationMs: stub.durationMs ?? 0,
        output: stub.output ?? '',
      };
    });
  return { runValidationPhase };
}

describe('validateLocally', () => {
  it('runs every configured phase by default and reports passed=true when all pass', async () => {
    const bridge = makeBridge({
      lint: { configured: true, passed: true, exitCode: 0, command: 'biome check .' },
      build: { configured: true, passed: true, exitCode: 0, command: 'npm run build' },
      tests: { configured: true, passed: true, exitCode: 0, command: 'npm test' },
    });

    const raw = await validateLocally('pod-1', {}, bridge as never);
    const result = JSON.parse(raw);

    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r: { phase: string }) => r.phase)).toEqual([
      'lint',
      'build',
      'tests',
    ]);
    expect(bridge.runValidationPhase).toHaveBeenCalledTimes(3);
  });

  it('reports passed=false and surfaces the failing phase', async () => {
    const bridge = makeBridge({
      lint: { configured: true, passed: true, exitCode: 0, command: 'biome check .' },
      build: { configured: true, passed: true, exitCode: 0, command: 'npm run build' },
      tests: {
        configured: true,
        passed: false,
        exitCode: 1,
        command: 'npm test',
        output: 'AssertionError: expected 1 to equal 2',
      },
    });

    const raw = await validateLocally('pod-1', {}, bridge as never);
    const result = JSON.parse(raw);

    expect(result.passed).toBe(false);
    const failing = result.results.find((r: { phase: string }) => r.phase === 'tests');
    expect(failing.passed).toBe(false);
    expect(failing.output).toContain('AssertionError');
  });

  it('skips tests when build fails (matches the daemon pipeline)', async () => {
    const bridge = makeBridge({
      lint: { configured: true, passed: true, exitCode: 0, command: 'biome check .' },
      build: {
        configured: true,
        passed: false,
        exitCode: 1,
        command: 'npm run build',
        output: 'TS2304: Cannot find name foo',
      },
      tests: { configured: true, passed: true, exitCode: 0, command: 'npm test' },
    });

    const raw = await validateLocally('pod-1', {}, bridge as never);
    const result = JSON.parse(raw);

    expect(result.passed).toBe(false);
    const tests = result.results.find((r: { phase: string }) => r.phase === 'tests');
    expect(tests.skipped).toBe(true);
    expect(tests.skippedReason).toContain('Build failed');
    // Tests phase should not have actually been executed
    const calledPhases = bridge.runValidationPhase.mock.calls.map((c) => c[1]);
    expect(calledPhases).not.toContain('tests');
  });

  it('treats unconfigured phases as neutral (passed stays true if everything else passes)', async () => {
    const bridge = makeBridge({
      lint: { configured: false },
      build: { configured: true, passed: true, exitCode: 0, command: 'npm run build' },
      tests: { configured: false },
    });

    const raw = await validateLocally('pod-1', {}, bridge as never);
    const result = JSON.parse(raw);

    expect(result.passed).toBe(true);
  });

  it('returns passed=false when nothing is configured to run', async () => {
    const bridge = makeBridge({
      lint: { configured: false },
      build: { configured: false },
      tests: { configured: false },
    });

    const raw = await validateLocally('pod-1', {}, bridge as never);
    const result = JSON.parse(raw);

    // No commands were configured — passed=false signals "I didn't actually verify
    // anything" rather than a misleading green light.
    expect(result.passed).toBe(false);
  });

  it('honours an explicit phases list and runs only those', async () => {
    const bridge = makeBridge({
      lint: { configured: true, passed: true, exitCode: 0, command: 'biome check .' },
      build: { configured: true, passed: true, exitCode: 0, command: 'npm run build' },
      tests: { configured: true, passed: true, exitCode: 0, command: 'npm test' },
    });

    const raw = await validateLocally('pod-1', { phases: ['lint'] }, bridge as never);
    const result = JSON.parse(raw);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].phase).toBe('lint');
    expect(bridge.runValidationPhase).toHaveBeenCalledTimes(1);
  });

  it('runs phases in canonical order regardless of caller order', async () => {
    const bridge = makeBridge({
      lint: { configured: true, passed: true, exitCode: 0, command: 'biome check .' },
      build: { configured: true, passed: true, exitCode: 0, command: 'npm run build' },
      tests: { configured: true, passed: true, exitCode: 0, command: 'npm test' },
    });

    await validateLocally('pod-1', { phases: ['tests', 'lint', 'build'] }, bridge as never);

    const calledPhases = bridge.runValidationPhase.mock.calls.map((c) => c[1]);
    expect(calledPhases).toEqual(['lint', 'build', 'tests']);
  });

  it('rejects unknown phases with a clear error', async () => {
    const bridge = makeBridge({});

    await expect(
      validateLocally('pod-1', { phases: ['typecheck' as ValidationPhaseName] }, bridge as never),
    ).rejects.toThrow(/Unknown phase/);
  });
});
