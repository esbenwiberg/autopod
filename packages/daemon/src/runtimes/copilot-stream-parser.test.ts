import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { CopilotStreamParser } from './copilot-stream-parser.js';

const logger = pino({ level: 'silent' });

async function collect(lines: string[]) {
  const stream = new PassThrough();
  const events = [];

  const parsePromise = (async () => {
    for await (const event of CopilotStreamParser.parse(stream, 'test-session', logger)) {
      events.push(event);
    }
  })();

  for (const line of lines) {
    stream.write(`${line}\n`);
  }
  stream.end();

  await parsePromise;
  return events;
}

describe('CopilotStreamParser', () => {
  it('emits a status event per non-empty line', async () => {
    const events = await collect(['Starting task...', 'Reading files...', 'Done.']);

    const statusEvents = events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(3);
    expect(statusEvents[0]).toMatchObject({ type: 'status', message: 'Starting task...' });
    expect(statusEvents[1]).toMatchObject({ type: 'status', message: 'Reading files...' });
    expect(statusEvents[2]).toMatchObject({ type: 'status', message: 'Done.' });
  });

  it('skips empty lines', async () => {
    const events = await collect(['Line one', '', '   ', 'Line two']);

    const statusEvents = events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(2);
  });

  it('synthesizes a complete event when stream ends', async () => {
    const events = await collect(['Some output']);

    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
    expect((completeEvent as { type: string; result: string }).result).toBe(
      'Copilot agent completed',
    );
  });

  it('synthesizes complete event with no-output message when stream is empty', async () => {
    const events = await collect([]);

    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
    expect((completeEvent as { type: string; result: string }).result).toBe(
      'Copilot agent completed (no output)',
    );
  });

  it('truncates lines longer than 2000 characters', async () => {
    const longLine = 'x'.repeat(3000);
    const events = await collect([longLine]);

    const statusEvent = events.find((e) => e.type === 'status') as
      | { type: string; message: string }
      | undefined;
    expect(statusEvent?.message).toHaveLength(2000);
  });

  it('includes timestamps on all events', async () => {
    const events = await collect(['hello']);
    for (const event of events) {
      expect((event as { timestamp: string }).timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
