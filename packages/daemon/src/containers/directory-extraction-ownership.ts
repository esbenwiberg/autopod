import type { DirectoryExtractionOptions } from '../interfaces/container-manager.js';

/** The check is synchronous: no async gap between this fence and filesystem publication. */
export function assertDirectoryExtractionCurrent(options?: DirectoryExtractionOptions): void {
  options?.signal?.throwIfAborted();
  options?.assertCurrent?.();
  options?.signal?.throwIfAborted();
}
