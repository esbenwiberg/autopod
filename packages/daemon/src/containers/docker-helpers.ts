import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import { DOCKER_CALL_TIMEOUTS, boundedDockerCall } from './docker-bounds.js';

/**
 * Check whether a Dockerode error matches one of the expected HTTP status
 * codes. Dockerode throws `{statusCode: number, ...}` for API errors; this
 * lets callers swallow "already stopped" (304) or "not found" (404) without
 * masking real failures.
 */
export function isExpectedDockerError(err: unknown, statusCodes: number[]): boolean {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    return statusCodes.includes((err as { statusCode: number }).statusCode);
  }
  return false;
}

/**
 * Docker requires the `Memory` field to be a multiple of the system page size
 * (4096 bytes). Round up so the effective cap is ≥ the requested value.
 */
export function alignMemoryToPageSize(bytes: number): number {
  return Math.ceil(bytes / 4096) * 4096;
}

/**
 * Create a container, handling the case where a container with the same name
 * already exists (409) — typically a stale container from a crashed daemon
 * leaving debris. Force-remove and retry once.
 */
export async function createContainerWithStaleRetry(
  docker: Dockerode,
  opts: Dockerode.ContainerCreateOptions,
  logger: Logger,
): Promise<Dockerode.Container> {
  try {
    return await boundedDockerCall(docker.createContainer(opts), {
      label: 'docker.createContainer',
      timeoutMs: DOCKER_CALL_TIMEOUTS.createContainer,
      logger,
    });
  } catch (err: unknown) {
    if (!isExpectedDockerError(err, [409])) throw err;
    if (!opts.name) throw err;
    logger.warn(
      { name: opts.name },
      'Stale container with same name exists — removing and retrying',
    );
    const stale = docker.getContainer(opts.name);
    try {
      await boundedDockerCall(stale.stop({ t: 5 }), {
        label: 'container.stop (stale-cleanup)',
        timeoutMs: DOCKER_CALL_TIMEOUTS.stop,
        logger,
      });
    } catch {
      // Already stopped, daemon wedged, or expected error — continue to remove
      // anyway. force-remove is what actually clears the name conflict.
    }
    await boundedDockerCall(stale.remove({ force: true }), {
      label: 'container.remove (stale-cleanup)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.remove,
      logger,
    });
    return boundedDockerCall(docker.createContainer(opts), {
      label: 'docker.createContainer (post-stale-retry)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.createContainer,
      logger,
    });
  }
}
