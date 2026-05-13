import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { HAPROXY_LOG_PORT } from './haproxy-config.js';
import { parseHaproxyLogLine } from './haproxy-deny-parser.js';

export interface HaproxyDenyStreamHandle {
  /** Stop the receiver. Idempotent. */
  stop(): Promise<void>;
}

export interface DeniedConnection {
  sni: string;
  src: string;
}

/**
 * Open a long-running `socat` exec in the container that drains the HAProxy
 * syslog UDP socket on loopback. Each `action=DENY` line is parsed and
 * delivered to `onDeny`; `action=ALLOW` lines are discarded. Bad lines are
 * ignored (the parser returns null).
 *
 * Run this once per restricted-mode pod after the firewall script has
 * started HAProxy. The returned handle's `stop()` kills the underlying
 * exec; call it from the pod's cleanup path.
 *
 * Failure modes:
 * - If the container exits, the exec stream ends naturally; nothing further
 *   to do — the next pod spawn will start a fresh receiver.
 * - If `socat` is missing from the image, the exec exits non-zero and we
 *   log once. Image-level invariant (base Dockerfiles install socat); the
 *   error log lets us catch a regression instead of silently losing
 *   denial visibility.
 */
export async function streamHaproxyDenials(
  containerManager: ContainerManager,
  containerId: string,
  onDeny: (event: DeniedConnection) => void,
  logger: Logger,
): Promise<HaproxyDenyStreamHandle> {
  const stream = await containerManager.execStreaming(
    containerId,
    ['socat', '-u', `UDP-RECV:${HAPROXY_LOG_PORT},reuseaddr`, '-'],
    { user: 'root' },
  );

  let stopped = false;
  let buffer = '';

  stream.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      newlineIdx = buffer.indexOf('\n');
      const entry = parseHaproxyLogLine(line);
      if (!entry) continue;
      if (entry.action !== 'DENY') continue;
      try {
        onDeny({ sni: entry.sni, src: entry.src });
      } catch (err) {
        logger.warn({ err, containerId }, 'firewall.denied handler threw');
      }
    }
  });

  stream.exitCode.then((code) => {
    if (stopped) return;
    if (code !== 0) {
      logger.warn(
        { containerId, exitCode: code },
        'haproxy deny receiver exited unexpectedly — denial visibility lost for this pod',
      );
    }
  });

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await stream.kill();
    },
  };
}
