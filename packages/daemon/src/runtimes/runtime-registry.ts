import type { Runtime, RuntimeType } from '@autopod/shared';
import { RuntimeError } from '@autopod/shared';
import type { RuntimeRegistry } from '../interfaces/runtime-registry.js';

export function createRuntimeRegistry(runtimes: Runtime[]): RuntimeRegistry {
  const map = new Map<RuntimeType, Runtime>();

  for (const runtime of runtimes) {
    map.set(runtime.type, runtime);
  }

  return {
    get(type: RuntimeType): Runtime {
      const runtime = map.get(type);
      if (!runtime) {
        throw new RuntimeError(`No runtime registered for type: ${type}`, type);
      }
      return runtime;
    },
  };
}
