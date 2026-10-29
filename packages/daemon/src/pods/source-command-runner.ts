import type { Readable } from 'node:stream';
import { AutopodError } from '@autopod/shared';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { sourceAdoptionError } from './source-adoption-identity.js';
import type { SourceCommandJournal } from './source-command-journal.js';

async function collect(stream: Readable) {
  const limit = 64 * 1024;
  let bytes = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (head.length < limit) head = Buffer.concat([head, chunk.subarray(0, limit - head.length)]);
    tail = Buffer.concat([tail, chunk]).subarray(-limit);
  }
  return {
    text:
      bytes <= limit
        ? head.toString()
        : `${head.toString()}\n[bounded source-command output]\n${tail.toString()}`,
    truncated: bytes > limit,
  };
}
/** Never use buffered exec's fallback exit code as source-mutation termination proof. */
export async function runSourceCommand(options: {
  journal: SourceCommandJournal;
  adoptionId: string;
  step: string;
  backend: 'docker' | 'sandbox';
  containerId: string;
  containerManager: ContainerManager;
  command: string[];
  timeoutMs?: number;
  assertCurrent(): void;
}) {
  const { journal, adoptionId, step, containerManager: cm } = options;
  if (cm.supportsExecRecovery !== true || cm.supportsStreamingExec === false)
    sourceAdoptionError(
      'Source mutation requires recoverable native exec identities',
      'SOURCE_EXEC_RECOVERY_UNAVAILABLE',
    );
  const timeout = options.timeoutMs ?? 120_000;
  const expires = Date.now() + timeout;
  let expired = false;
  let handle: StreamingExecResult | undefined;
  const check = () => {
    options.assertCurrent();
    if (expired || Date.now() >= expires)
      throw new AutopodError(
        'Source command deadline expired; dispatched work requires exact-exec reconciliation, not replay.',
        'SOURCE_COMMAND_TIMEOUT',
        504,
      );
  };
  journal.claim(adoptionId, step, options.command, options.backend, check);
  if (journal.get(adoptionId, step)?.containerId !== options.containerId) {
    journal.revokeUnsent(adoptionId, step);
    sourceAdoptionError(
      'Source command targets a different original resource',
      'SOURCE_COMMAND_RESOURCE_MISMATCH',
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // This CAS only revokes a command not yet admitted by the adapter hook.
      // A late callback cannot start it. Admitted identities remain held.
      try {
        journal.revokeUnsent(adoptionId, step);
      } catch {
        /* The local expired gate still refuses a late start. */
      }
      if (handle) void handle.kill().catch(() => {});
      reject(
        new AutopodError(
          'Source command outcome requires observation; no retry was submitted.',
          'SOURCE_COMMAND_TIMEOUT',
          504,
        ),
      );
    }, timeout);
  });
  const work = Promise.resolve().then(async () => {
    check();
    let markAdmitted = () => {};
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    handle = await cm.execStreaming(options.containerId, options.command, {
      cwd: '/workspace',
      timeout,
      onProcessCreated(identity) {
        journal.admit(adoptionId, step, identity, check);
        markAdmitted();
      },
      onProcessStarted(identity) {
        journal.started(adoptionId, step, identity);
      },
    });
    // Sandbox streams expose their handle before asynchronous supervisor setup
    // admits an identity. Wait for that actual journal admission, not the handle.
    // An exited/failed stream or the outer deadline still refuses missing proof;
    // a late callback must pass the same revocation/ownership gate before start.
    await Promise.race([
      admitted,
      handle.exitCode.then(() => {
        if (!journal.get(adoptionId, step)?.identity) {
          void handle?.kill().catch(() => {});
          sourceAdoptionError(
            'Adapter started no recoverable source exec identity',
            'SOURCE_EXEC_IDENTITY_MISSING',
          );
        }
      }),
    ]);
    if (expired) void handle.kill().catch(() => {});
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(handle.stdout),
      collect(handle.stderr),
      handle.exitCode,
    ]);
    const output = {
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    };
    // Even a late/stale observed exit belongs to this immutable original exec.
    journal.exited(adoptionId, step, exitCode, output);
    check();
    if (output.truncated)
      sourceAdoptionError(
        'Source command output exceeds bounded inspection limits',
        'SOURCE_COMMAND_OUTPUT_TRUNCATED',
      );
    if (exitCode !== 0)
      sourceAdoptionError(
        'Source command failed; inspect its original receipt and preserve custody.',
        'SOURCE_COMMAND_FAILED',
      );
    return { ...output, exitCode };
  });
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    journal.revokeUnsent(adoptionId, step);
    journal.error(
      adoptionId,
      step,
      error instanceof AutopodError ? error.code : 'SOURCE_COMMAND_FAILED',
    );
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    // Attach a rejection observer; an uncancellable late adapter cannot publish
    // a result or start through a revoked hook after this caller has timed out.
    void work.catch(() => {});
  }
}

/** Deliberate exact-original termination/observation, never a repeated Git command. */
export async function reconcileSourceCommand(options: {
  journal: SourceCommandJournal;
  adoptionId: string;
  step: string;
  containerManager: ContainerManager;
  assertCurrent(): void;
}) {
  options.assertCurrent();
  const state = options.journal.get(options.adoptionId, options.step);
  if (!state?.identity || state.revoked)
    sourceAdoptionError('No admitted original source exec identity exists');
  if (state.exitCode !== null) return state.exitCode;
  if (
    options.containerManager.supportsExecRecovery !== true ||
    !options.containerManager.terminateRecordedExec
  )
    sourceAdoptionError('Exact source exec termination unavailable');
  const exitCode = await options.containerManager.terminateRecordedExec(state.identity);
  // Record this original exec receipt even if ownership changed during the await.
  options.journal.exited(options.adoptionId, options.step, exitCode);
  options.assertCurrent();
  return exitCode;
}
