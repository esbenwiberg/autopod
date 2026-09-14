import { describe, expect, it } from 'vitest';
import { nativeGoalCapability } from './native-goal-capability.js';

const identity = {
  runtime: 'codex' as const,
  runtimeVersion: '0.152.1',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  backend: 'local' as const,
  providerId: 'openai',
};
const evidence = {
  ...identity,
  observedAt: '2026-09-13T20:00:00Z',
  evidenceId: 'fixture-record',
  checks: {
    start: true,
    continuation: true,
    terminalEvidence: true,
    cancellation: true,
    resume: true,
    daemonRecovery: true,
    usageIncludingEvaluator: true,
    confirmedTermination: true,
  },
};
describe('native Goal capability evidence', () => {
  it('cannot enable an unimplemented adapter merely by supplying a receipt', () => {
    const claude = { ...identity, runtime: 'claude' as const };
    expect(nativeGoalCapability(claude, [{ ...evidence, ...claude }])).toMatchObject({
      available: false,
      reason: expect.stringContaining('not implemented'),
    });
    const sandbox = { ...identity, backend: 'sandbox' as const };
    expect(nativeGoalCapability(sandbox, [{ ...evidence, ...sandbox }])).toMatchObject({
      available: false,
      reason: expect.stringContaining('exact native Goal process'),
    });
  });
  it('requires all provider checks for the exact image/runtime/backend/provider', () => {
    expect(nativeGoalCapability(identity, [])).toMatchObject({ available: false });
    expect(nativeGoalCapability(identity, [evidence])).toEqual({
      available: true,
      evidenceId: 'fixture-record',
    });
    expect(
      nativeGoalCapability(identity, [
        { ...evidence, checks: { ...evidence.checks, usageIncludingEvaluator: false } },
      ]),
    ).toMatchObject({ available: false });
    expect(
      nativeGoalCapability({ ...identity, runtimeVersion: '0.153.0' }, [evidence]),
    ).toMatchObject({ available: false });
    expect(nativeGoalCapability({ ...identity, backend: 'sandbox' }, [evidence])).toMatchObject({
      available: false,
    });
    expect(
      nativeGoalCapability({ ...identity, providerId: 'different' }, [evidence]),
    ).toMatchObject({ available: false });
    expect(nativeGoalCapability(identity, [evidence], true)).toMatchObject({ available: false });
  });
});
