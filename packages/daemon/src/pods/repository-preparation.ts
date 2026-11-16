import { AutopodError, type EffectiveLaunchConfig } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { wrapValidationExecCommand } from './registry-injector.js';

/** Source-dependent preparation runs only in this pod after checkout and scoped feed setup. */
export async function prepareLaunchRepository(
  config: EffectiveLaunchConfig,
  containerManager: ContainerManager,
  containerId: string,
  env: Record<string, string>,
): Promise<void> {
  const setup = config.repository?.setup;
  if (!setup?.prepareCommand) return;
  const literals = Object.fromEntries(
    Object.entries(setup.buildEnv).flatMap(([key, binding]) =>
      'value' in binding ? [[key, binding.value]] : [],
    ),
  );
  let result: Awaited<ReturnType<ContainerManager['execInContainer']>>;
  try {
    result = await containerManager.execInContainer(
      containerId,
      wrapValidationExecCommand(`set -e\n${setup.prepareCommand}`, env, literals),
      {
        cwd: setup.buildWorkDir ? `/workspace/${setup.buildWorkDir}` : '/workspace',
        timeout: (setup.buildTimeout ?? 300) * 1000,
        env,
      },
    );
  } catch {
    // Transport exceptions can contain the command, environment, and output.
    throw new AutopodError(
      'Repository preparation did not complete with a verified exit. Check the repository setup and execution environment.',
      'REPOSITORY_PREPARATION_FAILED',
      409,
    );
  }
  if (result.exitCode !== 0)
    throw new AutopodError(
      `Repository preparation failed with ${Number.isInteger(result.exitCode) ? `exit code ${result.exitCode}` : 'an unverified exit'}. Check the repository setup command.`,
      'REPOSITORY_PREPARATION_FAILED',
      409,
    );
}
