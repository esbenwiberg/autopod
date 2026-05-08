import { spawn } from 'node:child_process';
import type { HostResumedEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import type { EventBus } from './event-bus.js';

const TICK_INTERVAL_MS = 30_000;
const DEDUPE_WINDOW_MS = 5_000;
const PMSET_BUF_LIMIT = 100_000;

function readThresholdMs(): number {
  const env = Number(process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS);
  return Number.isFinite(env) && env > 0 ? env : 180_000;
}

export function startSleepDetector(eventBus: EventBus, logger: Logger): () => void {
  if (process.env.AUTOPOD_DISABLE_SLEEP_DETECT === '1') {
    return () => {};
  }

  const thresholdMs = readThresholdMs();
  let lastTickAt = Date.now();
  let lastPublishedAt = 0;

  function tryPublish(sleptMs: number, detector: HostResumedEvent['detector']): void {
    const now = Date.now();
    if (now - lastPublishedAt < DEDUPE_WINDOW_MS) return;
    lastPublishedAt = now;
    eventBus.emit({
      type: 'host.resumed',
      timestamp: new Date(now).toISOString(),
      sleptMs,
      detector,
      reconciledPodIds: [],
    });
    logger.info({ sleptMs, detector }, 'Host sleep detected — wake event published');
  }

  const handle = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    if (gap > thresholdMs) {
      tryPublish(gap, 'tick-gap');
    }
  }, TICK_INTERVAL_MS);
  handle.unref();

  // The adjunct reads lastTickAt (via getter) to enforce the same threshold as the
  // tick-gap path — keeps tick-gap as the source of truth.
  let stopped = false;
  let stopMacOs: (() => void) | null = null;

  if (process.platform === 'darwin') {
    void startMacOsAdjunct(
      logger,
      () => lastTickAt,
      (sleptMs, detector) => {
        if (sleptMs > thresholdMs) tryPublish(sleptMs, detector);
      },
    ).then((stop) => {
      if (stopped) {
        stop(); // adjunct started after stop() was already called — tear it down immediately
      } else {
        stopMacOs = stop;
      }
    });
  }

  return () => {
    stopped = true;
    clearInterval(handle);
    stopMacOs?.();
  };
}

type WakeCallback = (sleptMs: number, detector: HostResumedEvent['detector']) => void;

async function startMacOsAdjunct(
  logger: Logger,
  getLastTickAt: () => number,
  onWake: WakeCallback,
): Promise<() => void> {
  try {
    const mod = await import('node-mac-power-monitor').catch(() => null);
    if (mod) {
      const monitor = new mod.PowerMonitor();
      monitor.on('resume', () => {
        onWake(Date.now() - getLastTickAt(), 'native');
      });
      monitor.start();
      logger.debug('macOS power monitor: using native module');
      return () => monitor.stop();
    }
  } catch {
    // native module unavailable — fall through to pmset
  }

  return startPmsetAdjunct(logger, getLastTickAt, onWake);
}

// Matches Sleep and Wake lines, capturing timestamp parts and event type in one pass.
// pmset format: `2024-01-01 12:00:00 +0000 Sleep/Wake ...` — NOT ISO 8601. V8's
// Date(string) is not guaranteed to parse `+0000` (no colon) across Node versions;
// we canonicalise to `2024-01-01T12:00:00+00:00` in parsePmsetTimestamp.
const PMSET_EVENT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2}) (Sleep|Wake)/;

function parsePmsetTimestamp(line: string): number {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})/);
  if (!match) return Number.NaN;
  const [, date, time, sign, hh, mm] = match;
  return new Date(`${date}T${time}${sign}${hh}:${mm}`).getTime();
}

function startPmsetAdjunct(
  logger: Logger,
  getLastTickAt: () => number,
  onWake: WakeCallback,
): () => void {
  let lastSleepAt: number | null = null;
  let warned = false;

  let proc: ReturnType<typeof spawn> | null = null;
  try {
    proc = spawn('pmset', ['-g', 'log'], { stdio: ['ignore', 'pipe', 'ignore'] });

    proc.on('error', (err) => {
      if (!warned) {
        warned = true;
        logger.warn({ err }, 'macOS pmset adjunct failed — tick-gap heuristic only');
      }
    });

    let buf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.length > PMSET_BUF_LIMIT) {
        buf = '';
        return;
      }
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const m = PMSET_EVENT_PATTERN.exec(line);
        if (!m) continue;
        const [, date, time, sign, hh, mm, eventType] = m;
        const ts = new Date(`${date}T${time}${sign}${hh}:${mm}`).getTime();
        if (eventType === 'Sleep') {
          lastSleepAt = ts;
        } else {
          const sleptMs =
            lastSleepAt !== null && Number.isFinite(lastSleepAt) && Number.isFinite(ts)
              ? ts - lastSleepAt
              : Date.now() - getLastTickAt();
          lastSleepAt = null;
          onWake(sleptMs, 'pmset');
        }
      }
    });

    logger.debug('macOS power monitor: using pmset log tail');
  } catch (err) {
    if (!warned) {
      warned = true;
      logger.warn({ err }, 'macOS pmset adjunct failed — tick-gap heuristic only');
    }
  }

  return () => {
    proc?.kill();
    proc = null;
  };
}

export const _internals = {
  startMacOsAdjunct,
  startPmsetAdjunct,
  parsePmsetTimestamp,
};
