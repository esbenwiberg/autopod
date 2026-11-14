import type { ContainerManager, ExecOptions } from '../interfaces/container-manager.js';
import { BoundedOutputCollector, boundOutput } from '../util/bounded-output.js';

export async function runValidationCommand(
  containerManager: ContainerManager,
  executionTarget: 'local' | 'sandbox' | undefined,
  containerId: string,
  command: string[],
  options: ExecOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (executionTarget !== 'sandbox') {
    return containerManager.execInContainer(containerId, command, options);
  }

  const handle = await containerManager.execStreaming(containerId, command, options);
  // Bounded memory that keeps both the beginning and the final diagnostics of each stream.
  const stdout = new BoundedOutputCollector();
  const stderr = new BoundedOutputCollector();
  const readStdout = (async () => {
    for await (const chunk of handle.stdout) stdout.push(String(chunk));
  })();
  const readStderr = (async () => {
    for await (const chunk of handle.stderr) stderr.push(String(chunk));
  })();
  try {
    const [, , exitCode] = await Promise.all([readStdout, readStderr, handle.exitCode]);
    return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode };
  } catch (err) {
    // Native exec finalizes both streams before settling the exit promise. Drain
    // their buffered bytes even when Promise.all rejects on an unverified exit.
    await Promise.allSettled([readStdout, readStderr]);
    if (err instanceof Error) {
      Object.assign(err, { partialOutput: boundOutput(`${stdout}\n${stderr}`) });
    }
    throw err;
  }
}
