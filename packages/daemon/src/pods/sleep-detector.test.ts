import { spawn as childSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostResumedEvent, SystemEvent } from '@autopod/shared';
import pino from 'pino';
import type { EventBus } from './event-bus.js';
import { _internals, startSleepDetector } from './sleep-detector.js';

// Mock spawn so the macOS adjunct's pmset child-process can be driven in tests.
// Existing linux-platform tests never reach this code path, so the mock is a
// no-op for them.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(childSpawn);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: 'silent' });

function makeMockBus(): { bus: EventBus; events: HostResumedEvent[] } {
  const events: HostResumedEvent[] = [];
  const bus: EventBus = {
    emit(event: SystemEvent) {
      if (event.type === 'host.resumed') events.push(event);
      return 0;
    },
    subscribe: vi.fn(() => () => {}),
    subscribeToSession: vi.fn(() => () => {}),
  };
  return { bus, events };
}

const HOUR = 60 * 60 * 1_000;
const TICK = 30_000; // hard-coded interval

// Start well above epoch so that `lastPublishedAt = 0` sentinel never false-trips the dedupe check.
const EPOCH_OFFSET = 1_000_000_000;

// ---------------------------------------------------------------------------
// Test setup helpers
//
// With vi.useFakeTimers(), both Date.now() and setInterval share the same
// fake clock. Advancing by 4h fires the interval ~480 times at normal 30s
// gaps — no sleep gap appears.
//
// The fix: spy on Date.now() independently from the timer clock. We advance
// the wall-clock variable (mockNow) by the desired gap BEFORE firing a single
// timer tick. The setInterval callback reads Date.now() → mockNow and sees
// the large gap.
// ---------------------------------------------------------------------------

let mockNow = EPOCH_OFFSET;

/** Simulate a normal 30 s wall-clock tick (no sleep). */
async function normalTick(): Promise<void> {
  mockNow += TICK;
  await vi.advanceTimersByTimeAsync(TICK);
}

/**
 * Simulate a host sleep of `ms` ms followed by the first post-wake tick.
 * The setInterval fires once (one TICK of fake-timer time), but Date.now()
 * returns a value `ms` ms ahead of the last recorded tick.
 */
async function sleepThen(ms: number): Promise<void> {
  mockNow += ms; // jump wall clock (no timers fire)
  await vi.advanceTimersByTimeAsync(TICK); // fire one timer tick
}

// ---------------------------------------------------------------------------
// Tick-gap happy path
// ---------------------------------------------------------------------------

describe('tick-gap — happy path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNow = EPOCH_OFFSET;
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    delete process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS;
    delete process.env.AUTOPOD_DISABLE_SLEEP_DETECT;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fires no event after a normal 30 s tick', async () => {
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    await normalTick();
    stop();
    expect(events).toHaveLength(0);
  });

  it('publishes tick-gap event after 4 h suspension', async () => {
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);

    await normalTick(); // first tick — gap = TICK, no event
    expect(events).toHaveLength(0);

    await sleepThen(4 * HOUR); // gap = 4h > threshold → event
    expect(events).toHaveLength(1);

    const ev = events[0]!;
    expect(ev.detector).toBe('tick-gap');
    expect(ev.sleptMs).toBeGreaterThanOrEqual(4 * HOUR);
    expect(ev.reconciledPodIds).toEqual([]);
    stop();
  });
});

// ---------------------------------------------------------------------------
// Threshold behaviour
// ---------------------------------------------------------------------------

describe('threshold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNow = EPOCH_OFFSET;
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    delete process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS;
    delete process.env.AUTOPOD_DISABLE_SLEEP_DETECT;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('gap of 90 s does not trigger event with default 180 s threshold', async () => {
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    await normalTick();
    await sleepThen(90_000); // 90 s gap < 180 s threshold
    stop();
    expect(events).toHaveLength(0);
  });

  it('gap of 200 s triggers event with default 180 s threshold', async () => {
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    await normalTick();
    await sleepThen(200_000); // 200 s gap > 180 s threshold
    stop();
    expect(events).toHaveLength(1);
    expect(events[0]!.detector).toBe('tick-gap');
  });

  it('gap of 90 s triggers event when threshold overridden to 60 s', async () => {
    process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS = '60000';
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    await normalTick();
    await sleepThen(90_000); // 90 s > 60 s threshold
    stop();
    expect(events).toHaveLength(1);
    delete process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS;
  });
});

// ---------------------------------------------------------------------------
// Disable
// ---------------------------------------------------------------------------

describe('disable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNow = EPOCH_OFFSET;
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    delete process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.AUTOPOD_DISABLE_SLEEP_DETECT;
  });

  it('AUTOPOD_DISABLE_SLEEP_DETECT=1 suppresses all events', async () => {
    process.env.AUTOPOD_DISABLE_SLEEP_DETECT = '1';
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    await normalTick();
    await sleepThen(4 * HOUR);
    stop();
    expect(events).toHaveLength(0);
  });

  it('AUTOPOD_DISABLE_SLEEP_DETECT=1 returns a callable no-op stop function', () => {
    process.env.AUTOPOD_DISABLE_SLEEP_DETECT = '1';
    const { bus } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    expect(() => stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Dedupe
//
// With the default 180 s threshold, gap > threshold always implies
// now - lastPublishedAt > threshold >> DEDUPE_WINDOW (5 s), so the dedupe
// window can never be tested via tick-gap alone. We lower the threshold to
// 1 ms so that any tick gap > 1 ms triggers tryPublish, letting us control
// the time-since-last-publish independently.
// ---------------------------------------------------------------------------

describe('dedupe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNow = EPOCH_OFFSET;
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS = '1'; // every tick exceeds threshold
    delete process.env.AUTOPOD_DISABLE_SLEEP_DETECT;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS;
  });

  it('second wake signal within 5 s is suppressed', async () => {
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);

    // First tick: gap = TICK = 30 s > 1 ms → event fires
    mockNow += TICK;
    await vi.advanceTimersByTimeAsync(TICK);
    expect(events).toHaveLength(1);

    // 3 s later: gap = 3 s > 1 ms → tryPublish, but within 5 s dedupe window
    mockNow += 3_000;
    await vi.advanceTimersByTimeAsync(TICK);
    expect(events).toHaveLength(1); // still 1

    stop();
  });

  it('wake signal after dedupe window elapsed publishes a second event', async () => {
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);

    // First tick: event fires
    mockNow += TICK;
    await vi.advanceTimersByTimeAsync(TICK);
    expect(events).toHaveLength(1);

    // 6 s later: past the 5 s dedupe window → second event fires
    mockNow += 6_000;
    await vi.advanceTimersByTimeAsync(TICK);
    expect(events).toHaveLength(2);

    stop();
  });
});

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

describe('platform: linux', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNow = EPOCH_OFFSET;
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    delete process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS;
    delete process.env.AUTOPOD_DISABLE_SLEEP_DETECT;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('tick-gap alone works on linux (no macOS adjunct)', async () => {
    // process.platform is 'linux' inside the CI container — macOS adjunct never starts.
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    await normalTick();
    await sleepThen(4 * HOUR);
    expect(events).toHaveLength(1);
    expect(events[0]!.detector).toBe('tick-gap');
    stop();
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNow = EPOCH_OFFSET;
    vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
    delete process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS;
    delete process.env.AUTOPOD_DISABLE_SLEEP_DETECT;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stopFn clears the interval — no events fire after stop', async () => {
    const { bus, events } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    await normalTick();
    stop();
    // Jump time and fire ticks — nothing should fire since interval is cleared
    await sleepThen(4 * HOUR);
    await sleepThen(4 * HOUR);
    expect(events).toHaveLength(0);
  });

  it('stopFn is safe to call multiple times', () => {
    const { bus } = makeMockBus();
    const stop = startSleepDetector(bus, logger);
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pmset timestamp parser
// ---------------------------------------------------------------------------

describe('parsePmsetTimestamp', () => {
  it('parses a UTC pmset timestamp into a stable epoch value', () => {
    // pmset emits `2024-01-01 12:00:00 +0000`. The parser must normalise it to
    // ISO 8601 internally so V8's Date constructor parses it deterministically
    // across Node versions / locales.
    const t = _internals.parsePmsetTimestamp('2024-01-01 12:00:00 +0000 Wake from Normal Sleep');
    expect(t).toBe(Date.UTC(2024, 0, 1, 12, 0, 0));
  });

  it('parses a non-UTC offset', () => {
    const t = _internals.parsePmsetTimestamp('2024-06-15 09:30:45 -0700 Wake from Normal Sleep');
    // 09:30:45 -07:00 == 16:30:45 UTC
    expect(t).toBe(Date.UTC(2024, 5, 15, 16, 30, 45));
  });

  it('returns NaN for unrecognised lines', () => {
    expect(_internals.parsePmsetTimestamp('garbage')).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// macOS adjunct — pmset path
//
// We can't directly trigger the platform === 'darwin' branch inside
// startSleepDetector from a linux test runner, but we CAN exercise the adjunct
// itself via _internals.startPmsetAdjunct with a mocked spawn. That covers:
//
//  1. The threshold-guard wrapper that startSleepDetector wraps around
//     onWake — we mirror it in the test and verify a sub-threshold pmset
//     wake does NOT trigger publish.
//  2. The fallback cascade — when spawn throws, the warn logger fires
//     exactly once and tick-gap remains the source of truth.
// ---------------------------------------------------------------------------

interface FakePmsetProc extends EventEmitter {
  stdout: Readable;
  kill: () => void;
}

function makeFakePmsetProc(): FakePmsetProc {
  const proc = new EventEmitter() as FakePmsetProc;
  proc.stdout = new Readable({ read() {} });
  proc.kill = vi.fn();
  return proc;
}

function makeWarnCapturingLogger(): { logger: typeof logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const captured = { ...logger, warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  return { logger: captured as unknown as typeof logger, warn };
}

describe('macOS adjunct — threshold guard', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('macOS adjunct fires below threshold → not published (tick-gap is source of truth)', async () => {
    const proc = makeFakePmsetProc();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof childSpawn>);

    const lastTickAt = Date.now();
    const tryPublish = vi.fn();
    const thresholdMs = 180_000;
    // Mirror the threshold guard from startSleepDetector exactly: only forward to
    // tryPublish when sleptMs > thresholdMs.
    const guarded = (sleptMs: number, detector: HostResumedEvent['detector']) => {
      if (sleptMs > thresholdMs) tryPublish(sleptMs, detector);
    };

    const stop = _internals.startPmsetAdjunct(logger, () => lastTickAt, guarded);

    // Push a sleep+wake pair with a 1 s gap — well below the 180 s threshold.
    proc.stdout.push('2024-01-01 12:00:00 +0000 Sleep due to lid close\n');
    proc.stdout.push('2024-01-01 12:00:01 +0000 Wake from Normal Sleep\n');
    await new Promise((r) => setImmediate(r));

    expect(tryPublish).not.toHaveBeenCalled();

    // Now push a sleep+wake with a 10 min gap — must publish.
    proc.stdout.push('2024-01-01 13:00:00 +0000 Sleep due to lid close\n');
    proc.stdout.push('2024-01-01 13:10:00 +0000 Wake from Normal Sleep\n');
    await new Promise((r) => setImmediate(r));

    expect(tryPublish).toHaveBeenCalledTimes(1);
    expect(tryPublish).toHaveBeenCalledWith(10 * 60 * 1000, 'pmset');

    stop();
  });
});

describe('darwin failure cascade', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pmset spawn throws → warn logged exactly once, no events emitted', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT: pmset not found');
    });
    const { logger: capturing, warn } = makeWarnCapturingLogger();
    const tryPublish = vi.fn();

    const stop = _internals.startPmsetAdjunct(capturing, () => Date.now(), tryPublish);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(tryPublish).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('pmset child errors out → warn logged exactly once even across multiple error events', () => {
    const proc = makeFakePmsetProc();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof childSpawn>);
    const { logger: capturing, warn } = makeWarnCapturingLogger();

    const stop = _internals.startPmsetAdjunct(capturing, () => Date.now(), vi.fn());
    proc.emit('error', new Error('first error'));
    proc.emit('error', new Error('second error'));

    expect(warn).toHaveBeenCalledTimes(1);
    stop();
  });
});
