import type { Logger } from 'pino';

/**
 * Per-operation timeout defaults (ms). Tuned to "long enough that a healthy
 * daemon would have responded, short enough that a wedged daemon doesn't pin
 * pod-manager forever".
 *
 * `stop` and `remove` get extra headroom because Docker's own grace timer
 * (`{ t: 10 }`) eats the first 10s on stop. `start` is bigger because
 * starting a fresh container can pull layers off ACR. `getArchive` /
 * `putArchive` accommodate larger payloads (skill bundles, Playwright
 * artefacts).
 */
export const DOCKER_CALL_TIMEOUTS = {
  stop: 20_000,
  start: 60_000,
  remove: 15_000,
  inspect: 5_000,
  exec: 10_000,
  execStart: 10_000,
  execInspect: 5_000,
  putArchive: 30_000,
  getArchive: 30_000,
  createContainer: 60_000,
} as const;

export type DockerCallLabel = keyof typeof DOCKER_CALL_TIMEOUTS | (string & {});

export class DockerCallTimeoutError extends Error {
  readonly label: DockerCallLabel;
  readonly timeoutMs: number;
  readonly containerId?: string;

  constructor(label: DockerCallLabel, timeoutMs: number, containerId?: string) {
    super(
      `Docker call '${String(label)}' timed out after ${timeoutMs}ms${
        containerId ? ` (container=${containerId})` : ''
      }`,
    );
    this.name = 'DockerCallTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.containerId = containerId;
  }
}

export interface BoundedDockerCallOptions {
  /** Short tag for log lines and the timeout error message. */
  label: DockerCallLabel;
  /** Per-call timeout. Overridden by AUTOPOD_DOCKER_CALL_TIMEOUT_MS env if set. */
  timeoutMs: number;
  logger?: Logger;
  containerId?: string;
}

/**
 * Race a Dockerode promise against a hard timeout.
 *
 * Why we need this: Dockerode talks straight to the docker daemon socket, and
 * a wedged dockerd will never respond. Without a ceiling, even cleanup paths
 * (kill, stop, remove, inspect) can hang forever and pin pod-manager — which
 * is exactly the failure mode the present-orca pod hit. Layer 1 closes the
 * stream consumer; Layer 2 detects mid-run wedges; Layer 3 (this) makes sure
 * the wrap-up syscalls themselves can never block indefinitely.
 *
 * On timeout, throws `DockerCallTimeoutError`. The underlying promise gets a
 * no-op rejection handler attached so it can never become an unhandled
 * rejection if it eventually settles after we've already given up.
 */
export async function boundedDockerCall<T>(
  promise: Promise<T>,
  options: BoundedDockerCallOptions,
): Promise<T> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);

  // Defensive: ensure the inner promise never becomes an unhandled rejection
  // if our race observer drops it (we may resolve/reject from the timeout
  // branch first). `.then` registers handlers that swallow the rejection.
  promise.then(
    () => {},
    () => {},
  );

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new DockerCallTimeoutError(options.label, timeoutMs, options.containerId);
      options.logger?.warn(
        {
          component: 'docker-bounds',
          label: options.label,
          containerId: options.containerId,
          timeoutMs,
        },
        'Docker call timed out — daemon or container may be wedged',
      );
      reject(err);
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function resolveTimeoutMs(perCall: number): number {
  const envRaw = process.env.AUTOPOD_DOCKER_CALL_TIMEOUT_MS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return perCall;
}
