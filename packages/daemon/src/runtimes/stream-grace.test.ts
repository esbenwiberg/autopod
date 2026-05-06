import { PassThrough } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LivenessProbe,
  awaitExitCodeBounded,
  withIdleLivenessProbe,
  withPostCompleteGrace,
} from './stream-grace.js';

const logger = pino({ level: 'silent' });

function makeEvent(partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
  return {
    timestamp: new Date().toISOString(),
    ...partial,
  } as AgentEvent;
}

/**
 * Build a source that yields the given events then waits on `releasePromise`,
 * yielding nothing more after that. This lets us simulate "agent emitted
 * complete and then hangs" without leaking a forever-hung promise into the
 * test runner.
 */
function buildSource(
  events: AgentEvent[],
  releasePromise: Promise<void>,
): AsyncIterable<AgentEvent> {
  return (async function* () {
    for (const e of events) yield e;
    await releasePromise;
  })();
}

describe('withPostCompleteGrace', () => {
  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
    delete process.env.AUTOPOD_POST_COMPLETE_GRACE_MS;
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
    delete process.env.AUTOPOD_POST_COMPLETE_GRACE_MS;
  });

  it('passes events through and ends naturally when source closes', async () => {
    async function* source(): AsyncIterable<AgentEvent> {
      yield makeEvent({ type: 'status', message: 'a' } as AgentEvent);
      yield makeEvent({ type: 'status', message: 'b' } as AgentEvent);
    }
    const stdout = new PassThrough();

    const events: AgentEvent[] = [];
    for await (const e of withPostCompleteGrace(source(), {
      streams: [stdout],
      runtimeName: 'test',
      podId: 'p1',
      logger,
    })) {
      events.push(e);
    }

    expect(events.map((e) => e.type)).toEqual(['status', 'status']);
    expect(stdout.writableEnded).toBe(false);
  });

  it('arms timer on complete and destroys streams when source hangs', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });

    const source = buildSource(
      [
        makeEvent({ type: 'status', message: 'before complete' } as AgentEvent),
        makeEvent({
          type: 'complete',
          totalInputTokens: 1,
          totalOutputTokens: 2,
          costUsd: 0.01,
        } as AgentEvent),
      ],
      released,
    );

    const consume = (async () => {
      for await (const _ of withPostCompleteGrace(source, {
        streams: [stdout, stderr],
        runtimeName: 'test',
        podId: 'p2',
        logger,
        gracePeriodMs: 30,
      })) {
        /* drain */
      }
    })();

    // Wait for grace timer to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(stdout.writableEnded).toBe(true);
    expect(stderr.writableEnded).toBe(true);

    // Now release the source so the consumer can finish and we don't leak.
    release();
    await consume;
  });

  it('arms timer on fatal error too', async () => {
    const stdout = new PassThrough();
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });

    const source = buildSource(
      [
        makeEvent({
          type: 'error',
          message: 'boom',
          fatal: true,
        } as AgentEvent),
      ],
      released,
    );

    const consume = (async () => {
      for await (const _ of withPostCompleteGrace(source, {
        streams: [stdout],
        runtimeName: 'test',
        podId: 'p3',
        logger,
        gracePeriodMs: 30,
      })) {
        /* drain */
      }
    })();

    await new Promise((r) => setTimeout(r, 100));
    expect(stdout.writableEnded).toBe(true);
    release();
    await consume;
  });

  it('does not arm timer on non-fatal error', async () => {
    const stdout = new PassThrough();
    async function* source(): AsyncIterable<AgentEvent> {
      yield makeEvent({
        type: 'error',
        message: 'transient',
        fatal: false,
      } as AgentEvent);
    }

    for await (const _ of withPostCompleteGrace(source(), {
      streams: [stdout],
      runtimeName: 'test',
      podId: 'p4',
      logger,
      gracePeriodMs: 30,
    })) {
      /* drain */
    }

    // No complete or fatal error → timer never armed → wait past it
    // and confirm stdout is still alive.
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout.writableEnded).toBe(false);
  });

  it('reads grace period from AUTOPOD_POST_COMPLETE_GRACE_MS env when no override', async () => {
    process.env.AUTOPOD_POST_COMPLETE_GRACE_MS = '30';
    const stdout = new PassThrough();
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });

    const source = buildSource(
      [
        makeEvent({
          type: 'complete',
          totalInputTokens: 0,
          totalOutputTokens: 0,
        } as AgentEvent),
      ],
      released,
    );

    const consume = (async () => {
      for await (const _ of withPostCompleteGrace(source, {
        streams: [stdout],
        runtimeName: 'test',
        podId: 'p5',
        logger,
      })) {
        /* drain */
      }
    })();

    await new Promise((r) => setTimeout(r, 100));
    expect(stdout.writableEnded).toBe(true);
    release();
    await consume;
  });

  it('clears the timer when source closes naturally before it fires', async () => {
    const stdout = new PassThrough();
    async function* source(): AsyncIterable<AgentEvent> {
      yield makeEvent({
        type: 'complete',
        totalInputTokens: 0,
        totalOutputTokens: 0,
      } as AgentEvent);
      // Closes immediately — finally must clear the timer.
    }

    for await (const _ of withPostCompleteGrace(source(), {
      streams: [stdout],
      runtimeName: 'test',
      podId: 'p6',
      logger,
      gracePeriodMs: 30,
    })) {
      /* drain */
    }

    // Wait well past the grace window — if the timer wasn't cleared, stdout
    // would be destroyed.
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout.writableEnded).toBe(false);
  });
});

describe('awaitExitCodeBounded', () => {
  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
    delete process.env.AUTOPOD_EXIT_CODE_TIMEOUT_MS;
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
    delete process.env.AUTOPOD_EXIT_CODE_TIMEOUT_MS;
  });

  it('returns the resolved exit code when it arrives in time', async () => {
    const result = await awaitExitCodeBounded(Promise.resolve(0), {
      runtimeName: 'test',
      podId: 'p',
      logger,
      timeoutMs: 50,
    });
    expect(result).toEqual({ code: 0, timedOut: false });
  });

  it('returns timedOut=true when the promise never resolves', async () => {
    const never = new Promise<number>(() => {});
    const result = await awaitExitCodeBounded(never, {
      runtimeName: 'test',
      podId: 'p',
      logger,
      timeoutMs: 30,
    });
    expect(result).toEqual({ code: null, timedOut: true });
  });

  it('reads timeout from AUTOPOD_EXIT_CODE_TIMEOUT_MS env when no override', async () => {
    process.env.AUTOPOD_EXIT_CODE_TIMEOUT_MS = '30';
    const never = new Promise<number>(() => {});
    const result = await awaitExitCodeBounded(never, {
      runtimeName: 'test',
      podId: 'p',
      logger,
    });
    expect(result.timedOut).toBe(true);
  });
});

describe('withIdleLivenessProbe', () => {
  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
    delete process.env.AUTOPOD_IDLE_PROBE_MS;
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
    delete process.env.AUTOPOD_IDLE_PROBE_TIMEOUT_MS;
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
    delete process.env.AUTOPOD_IDLE_PROBE_MS;
    // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
    delete process.env.AUTOPOD_IDLE_PROBE_TIMEOUT_MS;
  });

  it('passes events through and never probes when source emits steadily', async () => {
    const probe: LivenessProbe = vi.fn(async () => true);
    async function* source(): AsyncIterable<AgentEvent> {
      yield makeEvent({ type: 'status', message: 'a' } as AgentEvent);
      yield makeEvent({ type: 'status', message: 'b' } as AgentEvent);
    }
    const stdout = new PassThrough();

    const events: AgentEvent[] = [];
    for await (const e of withIdleLivenessProbe(source(), {
      streams: [stdout],
      runtimeName: 'test',
      podId: 'idle-p1',
      logger,
      idleTimeoutMs: 1_000,
      probe,
    })) {
      events.push(e);
    }

    expect(events.map((e) => e.type)).toEqual(['status', 'status']);
    expect(probe).not.toHaveBeenCalled();
    expect(stdout.writableEnded).toBe(false);
  });

  it('runs probe on idle and continues when probe says alive', async () => {
    let probeCalls = 0;
    const probe: LivenessProbe = vi.fn(async () => {
      probeCalls++;
      return true;
    });

    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });

    const source = (async function* () {
      yield makeEvent({ type: 'status', message: 'a' } as AgentEvent);
      // Wait long enough for the idle timer to fire at least once.
      await new Promise((r) => setTimeout(r, 80));
      yield makeEvent({ type: 'status', message: 'b' } as AgentEvent);
      // Then hang until released so the test can cleanly tear down.
      await released;
    })();

    const stdout = new PassThrough();
    const events: AgentEvent[] = [];

    const consume = (async () => {
      for await (const e of withIdleLivenessProbe(source, {
        streams: [stdout],
        runtimeName: 'test',
        podId: 'idle-p2',
        logger,
        idleTimeoutMs: 30,
        probe,
      })) {
        events.push(e);
        if (events.length === 2) {
          // Got both events — release the source so the for-await ends.
          release();
        }
      }
    })();

    await consume;

    expect(events.map((e) => e.type)).toEqual(['status', 'status']);
    expect(probeCalls).toBeGreaterThanOrEqual(1);
    // Probe said alive — streams must NOT have been ended.
    expect(stdout.writableEnded).toBe(false);
  });

  it('destroys streams and emits fatal error when probe fails', async () => {
    const probe: LivenessProbe = vi.fn(async () => false);

    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });

    const source = (async function* () {
      yield makeEvent({ type: 'status', message: 'go' } as AgentEvent);
      // Hang — probe should fire and tear us down.
      await released;
    })();

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events: AgentEvent[] = [];

    for await (const e of withIdleLivenessProbe(source, {
      streams: [stdout, stderr],
      runtimeName: 'test',
      podId: 'idle-p3',
      logger,
      idleTimeoutMs: 30,
      probe,
    })) {
      events.push(e);
    }

    expect(stdout.writableEnded).toBe(true);
    expect(stderr.writableEnded).toBe(true);

    const fatalError = events.find((e) => e.type === 'error');
    expect(fatalError).toBeDefined();
    expect((fatalError as { fatal: boolean }).fatal).toBe(true);
    expect((fatalError as { message: string }).message).toContain('liveness probe failed');

    // Release so source generator can clean up.
    release();
  });

  it('reads idle timeout from AUTOPOD_IDLE_PROBE_MS env when no override', async () => {
    process.env.AUTOPOD_IDLE_PROBE_MS = '30';
    const probe: LivenessProbe = vi.fn(async () => false);

    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });

    const source = (async function* () {
      yield makeEvent({ type: 'status', message: 'go' } as AgentEvent);
      await released;
    })();

    const stdout = new PassThrough();
    const events: AgentEvent[] = [];

    for await (const e of withIdleLivenessProbe(source, {
      streams: [stdout],
      runtimeName: 'test',
      podId: 'idle-p4',
      logger,
      probe,
    })) {
      events.push(e);
    }

    expect(probe).toHaveBeenCalled();
    expect(events.find((e) => e.type === 'error')).toBeDefined();
    release();
  });

  it('throws if neither probe nor containerManager+containerId provided', async () => {
    async function* source(): AsyncIterable<AgentEvent> {
      yield makeEvent({ type: 'status', message: 'a' } as AgentEvent);
      // Pause so the idle timer trips and the probe is built.
      await new Promise((r) => setTimeout(r, 50));
    }

    await expect(async () => {
      for await (const _ of withIdleLivenessProbe(source(), {
        streams: [new PassThrough()],
        runtimeName: 'test',
        podId: 'idle-p5',
        logger,
        idleTimeoutMs: 20,
      })) {
        /* drain */
      }
    }).rejects.toThrow(/probe.*containerManager/);
  });
});
