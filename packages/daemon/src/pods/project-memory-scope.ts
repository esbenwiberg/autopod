import type { EffectiveLaunchConfig, MemoryEntry, MemoryScope, Pod } from '@autopod/shared';
import { configurationError } from '../configuration/configuration-store.js';

export type ProjectMemoryScope = {
  scope: 'repository' | 'profile';
  id: string;
  setupId?: string;
} | null;
export function projectMemoryScope(
  pod: Pod,
  launch?: EffectiveLaunchConfig | null,
): ProjectMemoryScope {
  if (!pod.launchConfigDigest) return { scope: 'profile', id: pod.profileName };
  if (!launch || launch.digest !== pod.launchConfigDigest)
    configurationError(
      'Repository memory scope requires the frozen launch configuration',
      'CONFIG_SNAPSHOT_UNAVAILABLE',
      503,
    );
  return launch.repository
    ? { scope: 'repository', id: launch.repository.id, setupId: launch.repository.setup.id }
    : null;
}

/** General repository memories remain shared; setup-bound memories stay with that setup. */
export function memoryMatchesProjectSetup(
  entry: MemoryEntry,
  project: ProjectMemoryScope,
): boolean {
  return (
    !entry.repositorySetupId ||
    (entry.scope === 'repository' &&
      project?.scope === 'repository' &&
      entry.scopeId === project.id &&
      entry.repositorySetupId === project.setupId)
  );
}

/** Resolve only the requested scope; a shared profile never widens repository memory access. */
export function memoryScopeId(
  pod: Pod,
  scope: MemoryScope,
  project: ProjectMemoryScope,
): string | null {
  if (scope === 'global') return null;
  if (scope === 'pod') return pod.id;
  if (!project || project.scope !== scope)
    configurationError(
      'This pod does not have access to that memory scope',
      'MEMORY_SCOPE_DENIED',
      403,
    );
  return project.id;
}
