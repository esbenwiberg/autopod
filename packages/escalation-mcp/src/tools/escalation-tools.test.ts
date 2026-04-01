import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingRequests } from '../pending-requests.js';
import type { SessionBridge } from '../session-bridge.js';
import { askAi } from './ask-ai.js';
import { askHuman } from './ask-human.js';
import { checkMessages } from './check-messages.js';
import { reportBlocker } from './report-blocker.js';
import { reportPlan } from './report-plan.js';
import { reportProgress } from './report-progress.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBridge(overrides: Partial<SessionBridge> = {}): SessionBridge {
  return {
    createEscalation: vi.fn(),
    resolveEscalation: vi.fn(),
    getAiEscalationCount: vi.fn().mockReturnValue(0),
    getMaxAiCalls: vi.fn().mockReturnValue(5),
    getAutoPauseThreshold: vi.fn().mockReturnValue(3),
    getHumanResponseTimeout: vi.fn().mockReturnValue(5), // 5 seconds
    getReviewerModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    callReviewerModel: vi.fn().mockResolvedValue('The AI says: proceed'),
    incrementEscalationCount: vi.fn(),
    reportPlan: vi.fn(),
    reportProgress: vi.fn(),
    consumeMessages: vi.fn().mockReturnValue({ hasMessage: false }),
    executeAction: vi.fn(),
    getAvailableActions: vi.fn().mockReturnValue([]),
    writeFileInContainer: vi.fn(),
    execInContainer: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ask-ai
// ---------------------------------------------------------------------------

describe('askAi', () => {
  it('returns the AI response', async () => {
    const bridge = makeBridge({
      callReviewerModel: vi.fn().mockResolvedValue('Use dependency injection'),
    });

    const result = await askAi('sess-1', { question: 'How should I structure this?' }, bridge);

    expect(result).toBe('Use dependency injection');
  });

  it('creates and resolves an escalation record', async () => {
    const bridge = makeBridge();

    await askAi('sess-1', { question: 'Help me', context: 'some context', domain: 'backend' }, bridge);

    expect(bridge.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        type: 'ask_ai',
        payload: expect.objectContaining({
          question: 'Help me',
          context: 'some context',
          domain: 'backend',
        }),
      }),
    );
    expect(bridge.resolveEscalation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ respondedBy: 'ai' }),
    );
  });

  it('increments the AI escalation count', async () => {
    const bridge = makeBridge();

    await askAi('sess-1', { question: 'question' }, bridge);

    expect(bridge.incrementEscalationCount).toHaveBeenCalledWith('sess-1');
  });

  it('passes question and context to callReviewerModel', async () => {
    const bridge = makeBridge();

    await askAi('sess-1', { question: 'Why?', context: 'the context' }, bridge);

    expect(bridge.callReviewerModel).toHaveBeenCalledWith('sess-1', 'Why?', 'the context');
  });

  it('throws when AI escalation limit is reached', async () => {
    const bridge = makeBridge({
      getAiEscalationCount: vi.fn().mockReturnValue(5),
      getMaxAiCalls: vi.fn().mockReturnValue(5),
    });

    await expect(askAi('sess-1', { question: 'one more?' }, bridge)).rejects.toThrow(
      'AI escalation limit reached (5)',
    );

    expect(bridge.callReviewerModel).not.toHaveBeenCalled();
  });

  it('does not throw when count is exactly one below the limit', async () => {
    const bridge = makeBridge({
      getAiEscalationCount: vi.fn().mockReturnValue(4),
      getMaxAiCalls: vi.fn().mockReturnValue(5),
    });

    await expect(askAi('sess-1', { question: 'edge case?' }, bridge)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ask-human
// ---------------------------------------------------------------------------

describe('askHuman', () => {
  let pendingRequests: PendingRequests;

  beforeEach(() => {
    vi.useFakeTimers();
    pendingRequests = new PendingRequests();
  });

  afterEach(() => {
    pendingRequests.cancelAll();
    vi.useRealTimers();
  });

  it('returns the human response when resolved', async () => {
    const bridge = makeBridge();

    const promise = askHuman(
      'sess-1',
      { question: 'Should I proceed?' },
      bridge,
      pendingRequests,
    );

    // Simulate human responding — find the escalation ID that was created
    const createCall = (bridge.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    pendingRequests.resolve(createCall.id, 'Yes, proceed!');

    const result = await promise;
    expect(result).toBe('Yes, proceed!');
  });

  it('creates an escalation with the correct payload', async () => {
    const bridge = makeBridge();

    const promise = askHuman(
      'sess-1',
      { question: 'What next?', context: 'ctx', options: ['a', 'b'] },
      bridge,
      pendingRequests,
    );

    const createCall = (bridge.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    pendingRequests.resolve(createCall.id, 'a');
    await promise;

    expect(bridge.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        type: 'ask_human',
        payload: expect.objectContaining({
          question: 'What next?',
          context: 'ctx',
          options: ['a', 'b'],
        }),
      }),
    );
  });

  it('increments escalation count regardless of response', async () => {
    const bridge = makeBridge();

    const promise = askHuman('sess-1', { question: 'Foo?' }, bridge, pendingRequests);
    const createCall = (bridge.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    pendingRequests.resolve(createCall.id, 'ok');
    await promise;

    expect(bridge.incrementEscalationCount).toHaveBeenCalledWith('sess-1');
  });

  it('returns a timeout fallback message when the request times out', async () => {
    const bridge = makeBridge({
      getHumanResponseTimeout: vi.fn().mockReturnValue(10), // 10 seconds
    });

    const promise = askHuman('sess-1', { question: 'Slow?' }, bridge, pendingRequests);

    // Advance past the timeout
    vi.advanceTimersByTime(11_000);

    const result = await promise;
    expect(result).toContain('No response received');
    expect(result).toContain('best judgement');
  });

  it('returns a cancellation message when the request is rejected', async () => {
    const bridge = makeBridge();

    const promise = askHuman('sess-1', { question: 'Foo?' }, bridge, pendingRequests);
    const createCall = (bridge.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    pendingRequests.reject(createCall.id, new Error('Daemon shutting down'));
    await promise;

    const result = await Promise.resolve(promise);
    expect(result).toContain('Escalation cancelled');
    expect(result).toContain('Daemon shutting down');
  });
});

// ---------------------------------------------------------------------------
// report-plan
// ---------------------------------------------------------------------------

describe('reportPlan', () => {
  it('calls bridge.reportPlan with the correct args', async () => {
    const bridge = makeBridge();

    await reportPlan(
      'sess-1',
      { summary: 'Refactor auth module', steps: ['Extract interface', 'Add tests', 'Deploy'] },
      bridge,
    );

    expect(bridge.reportPlan).toHaveBeenCalledWith(
      'sess-1',
      'Refactor auth module',
      ['Extract interface', 'Add tests', 'Deploy'],
    );
  });

  it('returns a confirmation message with step count', async () => {
    const bridge = makeBridge();

    const result = await reportPlan(
      'sess-1',
      { summary: 'Do stuff', steps: ['step1', 'step2'] },
      bridge,
    );

    expect(result).toContain('2');
    expect(result).toContain('step');
  });
});

// ---------------------------------------------------------------------------
// report-blocker
// ---------------------------------------------------------------------------

describe('reportBlocker', () => {
  let pendingRequests: PendingRequests;

  beforeEach(() => {
    vi.useFakeTimers();
    pendingRequests = new PendingRequests();
  });

  afterEach(() => {
    pendingRequests.cancelAll();
    vi.useRealTimers();
  });

  it('returns a non-blocking message when below autopause threshold', async () => {
    const bridge = makeBridge({
      getAiEscalationCount: vi.fn().mockReturnValue(0),
      getAutoPauseThreshold: vi.fn().mockReturnValue(3),
    });

    const result = await reportBlocker(
      'sess-1',
      { description: 'Cannot connect to DB', attempted: ['retry', 'restart'], needs: 'help' },
      bridge,
      pendingRequests,
    );

    expect(result).toContain('Cannot connect to DB');
    expect(result).toContain('Continuing');
  });

  it('creates an escalation record', async () => {
    const bridge = makeBridge({
      getAiEscalationCount: vi.fn().mockReturnValue(0),
      getAutoPauseThreshold: vi.fn().mockReturnValue(10),
    });

    await reportBlocker(
      'sess-1',
      { description: 'Stuck', attempted: ['tried this'], needs: 'guidance' },
      bridge,
      pendingRequests,
    );

    expect(bridge.createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        type: 'report_blocker',
        payload: expect.objectContaining({ description: 'Stuck' }),
      }),
    );
  });

  it('blocks and waits for human response when autopause threshold is reached', async () => {
    const bridge = makeBridge({
      getAiEscalationCount: vi.fn().mockReturnValue(2),
      getAutoPauseThreshold: vi.fn().mockReturnValue(3), // 2 + 1 = 3 >= threshold
      getHumanResponseTimeout: vi.fn().mockReturnValue(10),
    });

    const promise = reportBlocker(
      'sess-1',
      { description: 'Blocked again', attempted: [], needs: 'human help' },
      bridge,
      pendingRequests,
    );

    const createCall = (bridge.createEscalation as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    pendingRequests.resolve(createCall.id, 'Try a different approach');

    const result = await promise;
    expect(result).toBe('Try a different approach');
  });

  it('increments escalation count', async () => {
    const bridge = makeBridge({
      getAiEscalationCount: vi.fn().mockReturnValue(0),
      getAutoPauseThreshold: vi.fn().mockReturnValue(10),
    });

    await reportBlocker(
      'sess-1',
      { description: 'blocker', attempted: [], needs: 'help' },
      bridge,
      pendingRequests,
    );

    expect(bridge.incrementEscalationCount).toHaveBeenCalledWith('sess-1');
  });
});

// ---------------------------------------------------------------------------
// report-progress
// ---------------------------------------------------------------------------

describe('reportProgress', () => {
  it('calls bridge.reportProgress with the correct args', async () => {
    const bridge = makeBridge();

    await reportProgress(
      'sess-1',
      { phase: 'testing', description: 'Running unit tests', currentPhase: 2, totalPhases: 5 },
      bridge,
    );

    expect(bridge.reportProgress).toHaveBeenCalledWith(
      'sess-1',
      'testing',
      'Running unit tests',
      2,
      5,
    );
  });

  it('returns a message with phase info', async () => {
    const bridge = makeBridge();

    const result = await reportProgress(
      'sess-1',
      { phase: 'build', description: 'Compiling', currentPhase: 1, totalPhases: 3 },
      bridge,
    );

    expect(result).toContain('1/3');
    expect(result).toContain('build');
  });
});

// ---------------------------------------------------------------------------
// check-messages
// ---------------------------------------------------------------------------

describe('checkMessages', () => {
  it('returns JSON with hasMessage false when no message queued', async () => {
    const bridge = makeBridge({
      consumeMessages: vi.fn().mockReturnValue({ hasMessage: false }),
    });

    const result = await checkMessages('sess-1', bridge);
    const parsed = JSON.parse(result);

    expect(parsed.hasMessage).toBe(false);
    expect(parsed.message).toBeUndefined();
  });

  it('returns JSON with hasMessage true and message content when queued', async () => {
    const bridge = makeBridge({
      consumeMessages: vi.fn().mockReturnValue({ hasMessage: true, message: 'please stop' }),
    });

    const result = await checkMessages('sess-1', bridge);
    const parsed = JSON.parse(result);

    expect(parsed.hasMessage).toBe(true);
    expect(parsed.message).toBe('please stop');
  });

  it('calls consumeMessages with the session ID', async () => {
    const bridge = makeBridge();

    await checkMessages('my-session', bridge);

    expect(bridge.consumeMessages).toHaveBeenCalledWith('my-session');
  });
});
