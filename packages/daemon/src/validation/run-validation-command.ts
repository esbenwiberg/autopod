import type { ContainerManager, ExecOptions } from '../interfaces/container-manager.js';

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
  let stdout = '';
  let stderr = '';
  const readStdout = (async () => {
    for await (const chunk of handle.stdout) stdout = (stdout + String(chunk)).slice(-50_000);
  })();
  const readStderr = (async () => {
    for await (const chunk of handle.stderr) stderr = (stderr + String(chunk)).slice(-50_000);
  })();
  try {
    const [, , exitCode] = await Promise.all([readStdout, readStderr, handle.exitCode]);
    return { stdout, stderr, exitCode };
  } catch (err) {
    // Native exec finalizes both streams before settling the exit promise. Drain
    // their buffered bytes even when Promise.all rejects on an unverified exit.
    await Promise.allSettled([readStdout, readStderr]);
    if (err instanceof Error) {
      Object.assign(err, { partialOutput: `${stdout}\n${stderr}`.slice(-50_000) });
    }
    throw err;
  }
}
