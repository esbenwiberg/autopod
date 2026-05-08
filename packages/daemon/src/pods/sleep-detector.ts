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

const WAKE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} Wake/;
const SLEEP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} Sleep/;

// pmset emits timestamps like `2024-01-01 12:00:00 +0000`. That is NOT ISO 8601
// (space between date and time, no colon in the offset) and V8's `Date(string)` is
// not guaranteed to parse it across Node versions / locales — silent NaN. We
// canonicalise to `2024-01-01T12:00:00+00:00` before handing it to Date so the
// pmset adjunct keeps its precision advantage instead of falling back to tick-gap.
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
  // `pmset -g log` is a one-shot dump of the historical power log, not a live
  // tail. Recording the start moment lets us drop any wake entries that
  // pre-date the daemon — without this, a Mac that slept since boot would
  // emit one spurious host.resumed event on every restart.
  const startedAt = Date.now();

  let proc: ReturnType<typeof spawn> | null = null;
  try {
    proc = spawn('pmset', ['-g', 'log'], { stdio: ['ignore', 'pipe', 'ignore'] });

    proc.on('error', (err) => {
      if (!warned) {
        warned = true;
        logger.warn({ err }, 'macOS pmset adjunct failed — tick-gap heuristic only');
      }
    });

    // pmset always exits after the dump finishes. Surface that once so it's
    // visible the adjunct is no longer detecting wakes; tick-gap remains the
    // source of truth.
    proc.on('close', () => {
      if (!warned) {
        warned = true;
        logger.warn(
          'macOS pmset child exited (one-shot log) — sleep adjunct now idle, tick-gap remains source of truth',
        );
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
        if (SLEEP_PATTERN.test(line)) {
          lastSleepAt = parsePmsetTimestamp(line);
        } else if (WAKE_PATTERN.test(line)) {
          const wakeAt = parsePmsetTimestamp(line);
          // Skip historical wake entries from pmset's startup dump — only
          // wakes that happened after this adjunct started count.
          if (Number.isFinite(wakeAt) && wakeAt < startedAt) {
            lastSleepAt = null;
            continue;
          }
          const sleptMs =
            lastSleepAt !== null && Number.isFinite(lastSleepAt) && Number.isFinite(wakeAt)
              ? wakeAt - lastSleepAt
              : Date.now() - getLastTickAt();
          lastSleepAt = null;
          onWake(sleptMs, 'pmset');
        }
      }
    });

    logger.debug('macOS power monitor: parsing pmset log (one-shot snapshot, not a live tail)');
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
