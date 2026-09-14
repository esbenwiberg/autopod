import { AutopodError, type EffectiveLaunchConfig } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';

/** Source-dependent preparation runs only in this pod after checkout and scoped feed setup. */
export async function prepareLaunchRepository(
  config: EffectiveLaunchConfig,
  containerManager: ContainerManager,
  containerId: string,
  env: Record<string, string>,
): Promise<void> {
  const setup = config.repository?.setup;
  if (!setup?.prepareCommand) return;
  const result = await containerManager.execInContainer(
    containerId,
    ['sh', '-e', '-c', setup.prepareCommand],
    {
      cwd: setup.buildWorkDir ? `/workspace/${setup.buildWorkDir}` : '/workspace',
      timeout: (setup.buildTimeout ?? 300) * 1000,
      env,
    },
  );
  if (result.exitCode !== 0)
    throw new AutopodError(
      `Repository preparation failed with exit code ${result.exitCode}. Check the repository setup command.`,
      'REPOSITORY_PREPARATION_FAILED',
      409,
    );
}
