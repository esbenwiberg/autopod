import type { Runtime, RuntimeType } from '@autopod/shared';

export interface RuntimeRegistry {
  get(type: RuntimeType): Runtime;
}
