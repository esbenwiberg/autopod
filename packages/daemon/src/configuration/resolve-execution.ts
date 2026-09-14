import type {
  EnvironmentPreset,
  ExecutionCapabilities,
  ExecutionSettings,
  ResolvedAllocation,
  ResolvedExecution,
} from '@autopod/shared';
import { configurationError } from './configuration-store.js';

/** Validate against current backend limits and freeze every default before admission. */
export function resolveExecution(input: {
  environment: EnvironmentPreset;
  execution: ExecutionSettings;
  requiredSidecarIds: string[];
  trustedRepository: boolean;
  capabilities: ExecutionCapabilities;
}): ResolvedExecution {
  const { environment, execution, capabilities: caps } = input;
  if (!caps.available || caps.target !== execution.target) {
    configurationError(
      caps.unavailableReason ?? 'Execution target is unavailable',
      'EXECUTION_UNAVAILABLE',
    );
  }
  const selected = new Set(input.requiredSidecarIds);
  for (const id of selected) {
    const sidecar = environment.sidecars.find((s) => s.id === id);
    if (!sidecar || sidecar.startup === 'disabled')
      configurationError(`Sidecar ${id} is absent or disabled`, 'SIDECAR_UNAVAILABLE');
  }
  for (const sidecar of environment.sidecars) {
    if (sidecar.startup === 'always') selected.add(sidecar.id);
  }
  if (selected.size && !caps.sidecars)
    configurationError('This execution target does not support sidecars', 'SIDECAR_UNAVAILABLE');

  function allocation(
    requested: ExecutionSettings['main'] | undefined,
    defaults: ResolvedAllocation,
    sidecar: boolean,
  ): ResolvedAllocation {
    const resolved = {
      memoryGb: requested?.memoryGb ?? defaults.memoryGb,
      cpus: requested?.cpus ?? defaults.cpus,
      storageGb: requested?.storageGb ?? defaults.storageGb,
    };
    if (requested?.cpus != null && caps.maxCpus === null)
      configurationError(
        'This target does not support independent CPU allocation',
        'ALLOCATION_UNSUPPORTED',
      );
    if (
      resolved.storageGb !== null &&
      (sidecar ? !caps.sidecarStorageLimit : caps.maxStorageGb === null)
    )
      configurationError(
        'This target cannot enforce the requested storage limit',
        'ALLOCATION_UNSUPPORTED',
      );
    if (resolved.memoryGb > caps.maxMemoryGb || resolved.memoryGb <= 0)
      configurationError(
        `Memory allocation exceeds the target limit of ${caps.maxMemoryGb} GB`,
        'ALLOCATION_UNSUPPORTED',
      );
    if (!sidecar && caps.memoryTiersGb && !caps.memoryTiersGb.includes(resolved.memoryGb))
      configurationError(
        'Select an advertised memory tier for this target',
        'ALLOCATION_UNSUPPORTED',
      );
    if (
      resolved.cpus !== null &&
      (resolved.cpus <= 0 || (caps.maxCpus !== null && resolved.cpus > caps.maxCpus))
    )
      configurationError('CPU allocation exceeds target limits', 'ALLOCATION_UNSUPPORTED');
    if (
      resolved.storageGb !== null &&
      (resolved.storageGb <= 0 ||
        (caps.maxStorageGb !== null && resolved.storageGb > caps.maxStorageGb))
    )
      configurationError('Storage allocation exceeds target limits', 'ALLOCATION_UNSUPPORTED');
    return resolved;
  }
  const main = allocation(execution.main, caps.defaults, false);
  const sidecars: Record<string, ResolvedAllocation> = {};
  for (const sidecar of environment.sidecars) {
    if (!selected.has(sidecar.id)) continue;
    if (sidecar.type === 'dagger-engine' && (!input.trustedRepository || !caps.privilegedSidecars))
      configurationError(
        'Dagger requires both trusted repository setup and host permission',
        'PRIVILEGED_SIDECAR_DENIED',
      );
    sidecars[sidecar.id] = allocation(
      execution.sidecars[sidecar.id],
      caps.sidecarDefaults[sidecar.type],
      true,
    );
  }
  const allocations = [main, ...Object.values(sidecars)];
  const totalMemoryGb = allocations.reduce((total, a) => total + a.memoryGb, 0);
  const totalCpus = allocations.some((a) => a.cpus === null)
    ? null
    : allocations.reduce((total, a) => total + (a.cpus ?? 0), 0);
  if (
    totalMemoryGb > caps.maxTotalMemoryGb ||
    (totalCpus !== null && caps.maxTotalCpus !== null && totalCpus > caps.maxTotalCpus)
  )
    configurationError(
      'Main pod and sidecars exceed the combined resource limit',
      'ALLOCATION_UNSUPPORTED',
    );
  return { target: execution.target, main, sidecars, totalMemoryGb, totalCpus };
}
