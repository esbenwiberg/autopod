import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostResumedEvent, SystemEvent } from '@autopod/shared';
import pino from 'pino';
import type { EventBus } from './event-bus.js';
import { startSleepDetector } from './sleep-detector.js';

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
