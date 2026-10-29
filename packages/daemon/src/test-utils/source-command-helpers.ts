import { Readable } from 'node:stream';
import type { NativeGoalProcessIdentity } from '@autopod/shared';
import { vi } from 'vitest';
import { runSourceCommand } from '../pods/source-command-runner.js';
import { createAdoptedSourceValidationFixture } from './adopted-source-validation-helpers.js';

export function createSourceCommandFixture(disk = false) {
  const source = createAdoptedSourceValidationFixture(disk);
  const containerId = source.f.pod().containerId;
  if (!containerId) throw new Error('No original fixture resource');
  const identity: NativeGoalProcessIdentity = {
    backend: 'docker',
    containerId,
    execId: 'fixture-original-exec',
    pidPath: '/tmp/fixture-original.pid',
  };
  const handle = {
    stdout: Readable.from(['source output']),
    stderr: Readable.from([]),
    exitCode: Promise.resolve(0),
    kill: vi.fn(async () => {}),
  };
  const cm = {
    ...source.f.ctx.containerManager,
    supportsExecRecovery: true,
    supportsStreamingExec: true,
    terminateRecordedExec: vi.fn(async () => 137),
  };
  vi.mocked(cm.execStreaming).mockImplementation(async (_id, _command, options) => {
    options?.onProcessCreated?.(identity);
    options?.onProcessStarted?.(identity);
    return handle;
  });
  const options: Parameters<typeof runSourceCommand>[0] = {
    journal: source.journal.commands,
    adoptionId: 'source-checks',
    step: 'apply',
    backend: 'docker',
    containerId,
    containerManager: cm,
    command: ['git', 'merge', '--ff-only', 'b'.repeat(40)],
    assertCurrent: () => {},
    timeoutMs: 2000,
  };
  return { source, identity, handle, cm, options, run: () => runSourceCommand(options) };
}
