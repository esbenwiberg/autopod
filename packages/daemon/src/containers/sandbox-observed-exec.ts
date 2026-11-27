import { randomUUID } from 'node:crypto';
import type { ExecOptions, ExecResult } from '../interfaces/container-manager.js';
import { ExecInterruptedError } from './exec-exit-evidence.js';
import type { SandboxApiClient } from './sandbox-api-client.js';
import {
  SANDBOX_GOAL_SUPERVISOR_ENV,
  sandboxGoalExit,
  sandboxGoalProcess,
  sandboxGoalRoot,
  sandboxGoalSupervisor,
} from './sandbox-goal-process.js';

const STAGE = `import os,sys
root=sys.argv[1];os.mkdir(root,0o700)
with open(root+'/supervisor.py','x') as f:f.write(sys.argv[2])
os.chmod(root+'/supervisor.py',0o700)
`;
const OBSERVE = `import pathlib,sys
p=pathlib.Path(sys.argv[1])
print(p.read_text() if p.exists() else 'null')
`;
const STOP = `import pathlib,sys
pathlib.Path(sys.argv[1]).touch(mode=0o600)
`;

/** A launch acknowledgment is never an exit. Only the exact private receipt
 * settles the command; uncertainty never submits another start.
 */
export async function runSandboxObservedExec(
  client: SandboxApiClient,
  containerId: string,
  command: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = options.timeout ?? 300_000;
  const maxOutputBytes = options.maxOutputBytes ?? 65536;
  if (
    client.supportsBoundedExec !== true ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 4 ||
    maxOutputBytes > 65536 ||
    options.user ||
    options.stdin ||
    options.onProcessCreated ||
    options.onProcessStarted
  )
    throw new Error('Unsupported observed Sandbox execution options');
  const identity = sandboxGoalProcess(containerId, randomUUID());
  const root = sandboxGoalRoot(identity);
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    options.assertCurrent?.();
    if (Date.now() >= deadline)
      throw new ExecInterruptedError({ cause: 'timeout', cleanup: 'unverified', timeoutMs });
  };
  const rpc = async (argv: string[], cleanup = false) => {
    if (!cleanup) check();
    const result = await client.exec(containerId, argv, {
      user: 'root',
      env: SANDBOX_GOAL_SUPERVISOR_ENV,
      timeoutMs: cleanup ? 1000 : Math.max(1, Math.min(5000, deadline - Date.now())),
      maxOutputBytes: 100_000,
      singleAttempt: true,
      beforeSend: cleanup ? undefined : check,
    });
    if (result.exitCode !== 0) throw new Error('Sandbox supervisor request failed');
    return result;
  };
  const observe = async (cleanup = false) => {
    const result = await rpc(['python3', '-I', '-c', OBSERVE, identity.pidPath], cleanup);
    const value = JSON.parse(result.stdout);
    const code = value === null ? null : sandboxGoalExit(identity, result.stdout);
    return { value, code };
  };
  let launchAttempted = false;
  try {
    check();
    await rpc([
      'python3',
      '-I',
      '-c',
      STAGE,
      root,
      sandboxGoalSupervisor(identity, command, options.cwd, options.env, false, {
        maxOutputBytes,
        deadlineMs: deadline,
      }),
    ]);
    check();
    // Never replay this request, including when its response is lost.
    launchAttempted = true;
    await rpc(['python3', '-I', `${root}/supervisor.py`, '--detach']);
    for (;;) {
      check();
      const { value, code } = await observe();
      check();
      if (code !== null) {
        if (value.timedOut === true)
          throw new ExecInterruptedError({
            cause: 'timeout',
            cleanup: 'confirmed',
            timeoutMs,
            observedExitCode: code,
          });
        if (typeof value.output?.stdout !== 'string' || typeof value.output?.stderr !== 'string')
          throw new Error('Sandbox supervisor output unverified');
        const stdout = Buffer.from(value.output.stdout, 'base64');
        const stderr = Buffer.from(value.output.stderr, 'base64');
        if (stdout.length + stderr.length > maxOutputBytes)
          throw new Error('Sandbox supervisor output exceeds bound');
        return { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: code };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))),
      );
    }
  } catch (error) {
    // Revoke a late detached start using the same supervisor; never launch another.
    let observedExitCode: number | undefined;
    if (launchAttempted) {
      try {
        await rpc(['python3', '-I', '-c', STOP, `${root}/stop`], true);
        const cleanupDeadline = Date.now() + 5000;
        do {
          const { code } = await observe(true);
          if (code !== null) {
            observedExitCode = code;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < cleanupDeadline);
      } catch {
        /* Lost or rebound evidence remains unverified. */
      }
    }
    throw new ExecInterruptedError({
      cause:
        error instanceof ExecInterruptedError && error.execution?.cause === 'timeout'
          ? 'timeout'
          : 'cancelled',
      timeoutMs,
      cleanup: observedExitCode === undefined ? 'unverified' : 'confirmed',
      ...(observedExitCode === undefined ? {} : { observedExitCode }),
    });
  }
}
