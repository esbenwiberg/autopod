import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager, ExecOptions } from '../interfaces/container-manager.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { requiresValidationSettlement } from '../pods/validation-recovery-policy.js';
import { createLocalValidationEngine } from './local-validation-engine.js';

async function run(
  marker: string,
  phase: 'facts' | 'lint' | 'sast' | 'setup' | 'build' | 'test',
  observedExit = false,
  message = 'Exec timed out after 123ms',
) {
  const commands: string[] = [];
  const cm = {
    execInContainer: vi.fn(async (_id: string, command: string[], options?: ExecOptions) => {
      expect(options?.requireObservedExit).toBe(true);
      const shell = command[2] ?? '';
      commands.push(shell);
      if (shell.includes(marker)) {
        if (!observedExit) throw new Error(message);
        return { stdout: '', stderr: 'observed command failure', exitCode: 124 };
      }
      return {
        stdout: shell.includes('sha256sum')
          ? 'a'.repeat(64)
          : marker === 'npm rebuild' && shell.includes('-empty -print')
            ? '/workspace/node_modules/.bin/tool'
            : '',
        stderr: '',
        exitCode: 0,
      };
    }),
  } as unknown as ContainerManager;
  const config: ValidationEngineConfig = {
    podId: 'artifact-buffered-proof',
    containerId: 'fixture',
    previewUrl: '',
    validationSetupCommand: phase === 'setup' ? 'setup-original' : undefined,
    buildCommand: phase === 'build' ? 'build-original' : '',
    testCommand: phase === 'test' ? 'test-original' : undefined,
    startCommand: '',
    healthPath: '/',
    healthTimeout: 1,
    smokePages: [],
    attempt: 1,
    task: 'Independently check preserved source',
    hasWebUi: false,
    diff: '',
    artifactSource: { sha256: 'a'.repeat(64), verify: async () => {} },
    lintCommand: phase === 'lint' ? 'lint-original' : undefined,
    sastCommand: phase === 'sast' ? 'sast-original' : undefined,
    skipPhases: [
      ...(phase !== 'setup' ? ['setup' as const] : []),
      ...(phase !== 'build' ? ['build' as const] : []),
      ...(phase !== 'test' ? ['test' as const] : []),
      'health',
      'pages',
      'review',
      ...(phase !== 'lint' ? ['lint' as const] : []),
      ...(phase !== 'sast' ? ['sast' as const] : []),
    ],
    contract: {
      contractVersion: 1,
      title: 'Frozen artifact commands',
      dependsOn: [],
      scenarios: [],
      humanReview: [],
      requiredFacts: ['first', 'second'].map((id) => ({
        id,
        proves: [],
        kind: 'custom-command' as const,
        artifact: { path: 'source.js', change: 'touch' as const },
        command: `run-${id}-fact`,
      })),
    },
  };
  return { result: await createLocalValidationEngine(cm).validate(config), commands };
}

describe('artifact buffered execution requires positive termination', () => {
  it.each([
    ['facts', 'run-first-fact'],
    ['facts', 'test -e'],
    ['facts', 'sha256sum'],
    ['facts', 'find '],
    ['lint', 'lint-original'],
    ['sast', 'sast-original'],
    ['setup', 'setup-original'],
    ['build', 'build-original'],
    ['build', '-empty -print'],
    ['build', 'npm rebuild'],
    ['build', 'chmod a+rx'],
    ['test', 'test-original'],
  ] as const)('retains an unverified %s command (%s) without dispatching later Facts', async (phase, marker) => {
    const { result, commands } = await run(marker, phase);
    expect(result.infrastructureFailure).toMatchObject({
      phase,
      code: 'EXEC_EXIT_UNVERIFIED',
      retryable: false,
    });
    expect(result.overall).toBe('fail');
    expect(requiresValidationSettlement({ lastValidationResult: result })).toBe(true);
    expect(commands.some((command) => command.includes('run-second-fact'))).toBe(false);
    expect(result.factValidation?.results.some((fact) => fact.exitCode === 124)).not.toBe(true);
  });

  it('treats buffered transport loss as unknown, not a fabricated command exit', async () => {
    const { result, commands } = await run(
      'run-first-fact',
      'facts',
      false,
      'Docker transport closed',
    );
    expect(result.infrastructureFailure?.code).toBe('EXEC_EXIT_UNVERIFIED');
    expect(commands.some((command) => command.includes('run-second-fact'))).toBe(false);
  });

  it('does not confuse an observed exit 124 with unverified transport termination', async () => {
    const { result, commands } = await run('run-first-fact', 'facts', true);
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.factValidation?.results[0]?.exitCode).toBe(124);
    expect(result.factValidation?.results[0]?.passed).toBe(false);
    expect(requiresValidationSettlement({ lastValidationResult: result })).toBe(false);
    expect(commands.some((command) => command.includes('run-second-fact'))).toBe(true);
  });
});
