import { AutopodError } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';

/** Docker's maintained identity includes the engine, not just a reusable endpoint/name. */
export function isDockerValidationResourceKey(
  value: string | undefined,
  containerId: string,
): value is string {
  if (!value || value.length > 1024 || !/^[a-f0-9]{64}$/.test(containerId)) return false;
  try {
    const key: unknown = JSON.parse(value);
    return (
      Array.isArray(key) &&
      key.length === 3 &&
      key[0] === 'docker' &&
      typeof key[1] === 'string' &&
      key[1].length > 0 &&
      key[1].length <= 256 &&
      /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(key[1]) &&
      key[2] === containerId &&
      value === JSON.stringify(key)
    );
  } catch {
    return false;
  }
}

export async function captureDockerValidationResourceScope(
  manager: ContainerManager,
  containerId: string,
): Promise<string> {
  const key = await manager.getResourceKey?.(containerId);
  if (!isDockerValidationResourceKey(key, containerId))
    throw new AutopodError(
      'Fresh Docker rewrite checks require an observed exact Docker engine/container identity before execution.',
      'VALIDATION_RESOURCE_IDENTITY_UNAVAILABLE',
      409,
    );
  return key;
}
