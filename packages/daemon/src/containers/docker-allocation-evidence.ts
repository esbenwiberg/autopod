import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import { boundedDockerCall, DOCKER_CALL_TIMEOUTS } from './docker-bounds.js';

// Correlates a single create request and the exact-ID inspection; never used
// to discover or adopt historical resources. Not an ownership/authorization label.
export const ALLOCATION_LABEL = 'com.autopod.allocation-attempt';

export async function observeDockerEngine(
  docker: Dockerode,
  logger: Logger,
): Promise<string | null> {
  try {
    const info = (await boundedDockerCall(docker.info(), {
      label: 'docker.info (allocation namespace)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.inspect,
      logger,
    })) as { ID?: unknown };
    return typeof info.ID === 'string' && info.ID.trim() ? info.ID : null;
  } catch {
    return null;
  }
}
