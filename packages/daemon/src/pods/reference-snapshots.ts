import { AutopodError, type EffectiveLaunchConfig } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';

export function frozenReferenceBindings(config: EffectiveLaunchConfig) {
  return config.references.map((reference, index) => ({
    url: reference.remote,
    mountPath: `${index + 1}-${reference.id}`,
  }));
}
/** Complete authenticated fetches before main-container allocation; never consult mutable branches. */
export async function stageReferenceSnapshots(
  config: EffectiveLaunchConfig,
  worktrees: WorktreeManager,
  assertAllowed: () => Promise<void>,
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  if (!config.references.length) return result;
  if (!worktrees.readSnapshotArchive)
    throw new AutopodError(
      'Frozen reference checkout is unavailable',
      'REFERENCE_UNAVAILABLE',
      503,
    );
  const bindings = frozenReferenceBindings(config);
  let bytes = 0;
  for (const [index, reference] of config.references.entries()) {
    const binding = bindings[index];
    if (!binding || !/^[a-zA-Z0-9_.-]+$/.test(binding.mountPath))
      throw new AutopodError('Reference mount identity is invalid', 'REFERENCE_INVALID', 400);
    await assertAllowed();
    const archive = await worktrees.readSnapshotArchive({
      repoUrl: reference.remote,
      revision: reference.revision,
    });
    bytes += archive.length;
    if (bytes > 256 * 1024 * 1024)
      throw new AutopodError(
        'Combined reference archives exceed 256 MiB',
        'REFERENCE_TOO_LARGE',
        400,
      );
    await assertAllowed();
    result.set(binding.mountPath, archive);
  }
  return result;
}

/** No .git or source token is sent. Root-owned source remains readable by the unprivileged agent. */
export async function installReferenceSnapshots(
  archives: Map<string, Buffer>,
  manager: ContainerManager,
  containerId: string,
): Promise<void> {
  const run = async (args: string[]) => {
    const result = await manager.execInContainer(containerId, args, {
      user: 'root',
      timeout: 120_000,
    });
    if (result.exitCode !== 0)
      throw new AutopodError(
        'Could not install a read-only reference snapshot',
        'REFERENCE_INSTALL_FAILED',
        409,
      );
  };
  try {
    for (const [mount, archive] of archives) {
      const file = `/tmp/.autopod-reference-${mount}.tgz`;
      const destination = `/repos/${mount}`;
      try {
        await manager.writeFile(containerId, file, archive);
        await run(['mkdir', '-p', destination]);
        await run(['tar', '--no-same-owner', '-xzf', file, '-C', destination]);
        await run(['chown', '-R', '0:0', destination]);
        await run(['chmod', '-R', 'a-w', destination]);
        await run(['chown', '0:0', '/repos']);
        await run(['chmod', '755', '/repos']);
      } finally {
        await run(['rm', '-f', file]);
      }
    }
  } finally {
    archives.clear();
  }
}
