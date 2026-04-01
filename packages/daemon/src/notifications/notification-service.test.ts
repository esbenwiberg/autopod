import type {
  EscalationCreatedEvent,
  Session,
  SessionStatusChangedEvent,
  SystemEvent,
  ValidationCompletedEvent,
} from '@autopod/shared';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../sessions/event-bus.js';
import type { SessionLookup } from './notification-service.js';
import { createNotificationService } from './notification-service.js';
import type { RateLimiter } from './rate-limiter.js';
import type { TeamsAdapter } from './teams-adapter.js';
import type { NotificationConfig } from './types.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createMockEventBus(): EventBus & { emit: (event: SystemEvent) => number } {
  const subscribers = new Set<(event: SystemEvent) => void>();
  return {
    emit(event: SystemEvent): number {
      for (const sub of subscribers) {
        sub(event);
      }
      return 1;
    },
    subscribe(subscriber: (event: SystemEvent) => void): () => void {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    subscribeToSession(_sessionId: string, subscriber: (event: SystemEvent) => void): () => void {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}

function createMockSession(overrides?: Partial<Session>): Session {
  return {
    id: 'sess-123',
    profileName: 'my-app',
    task: 'Add button',
    status: 'running',
    model: 'claude-sonnet',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'feature/add-button',
    containerId: null,
    worktreePath: null,
    validationAttempts: 0,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    completedAt: null,
    updatedAt: '2026-01-01T00:00:01.000Z',
    userId: 'user-1',
    filesChanged: 3,
    linesAdded: 50,
    linesRemoved: 10,
    previewUrl: 'https://preview.example.com/sess-123',
    ...overrides,
  };
}

describe('NotificationService', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let teamsAdapter: TeamsAdapter;
  let rateLimiter: RateLimiter;
  let sessionLookup: SessionLookup;
  let logger: Logger;
  let config: NotificationConfig;

  beforeEach(() => {
    eventBus = createMockEventBus();
    teamsAdapter = { send: vi.fn().mockResolvedValue(true) };
    rateLimiter = {
      canSend: vi.fn().mockReturnValue({ allowed: true }),
      recordSent: vi.fn(),
      reset: vi.fn(),
    };
    sessionLookup = { getSession: vi.fn().mockReturnValue(createMockSession()) };
    logger = createMockLogger();
    config = {
      teams: {
        webhookUrl: 'https://webhook.example.com',
        enabledEvents: [
          'session_validated',
          'session_failed',
          'session_needs_input',
          'session_error',
        ],
      },
    };
  });

  function createService() {
    return createNotificationService({
      eventBus,
      config,
      teamsAdapter,
      rateLimiter,
      sessionLookup,
      logger,
    });
  }

  describe('start/stop', () => {
    it('subscribes to event bus on start', () => {
      const service = createService();
      service.start();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ enabledEvents: expect.any(Array) }),
        expect.stringContaining('started'),
      );
    });

    it('logs when no Teams config', () => {
      config = {};
      const service = createService();
      service.start();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    });

    it('unsubscribes on stop', () => {
      const service = createService();
      service.start();
      service.stop();

      // Emitting after stop should not send
      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        result: {
          sessionId: 'sess-123',
          attempt: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'pass',
          duration: 1100,
        },
      };
      eventBus.emit(event);
      expect(teamsAdapter.send).not.toHaveBeenCalled();
    });
  });

  describe('validation_completed events', () => {
    it('sends validated card on pass', async () => {
      const service = createService();
      service.start();

      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        result: {
          sessionId: 'sess-123',
          attempt: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'pass',
          duration: 1100,
        },
      };
      eventBus.emit(event);

      // Wait for async fire-and-forget
      await vi.waitFor(() => {
        expect(teamsAdapter.send).toHaveBeenCalledTimes(1);
      });

      const card = vi.mocked(teamsAdapter.send).mock.calls[0]?.[0];
      expect(card?.body[0]?.text).toContain('Validated');
    });

    it('sends failed card on fail', async () => {
      const service = createService();
      service.start();

      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        result: {
          sessionId: 'sess-123',
          attempt: 2,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'fail',
            build: { status: 'fail', output: 'Error', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'fail',
          duration: 1100,
        },
      };
      eventBus.emit(event);

      await vi.waitFor(() => {
        expect(teamsAdapter.send).toHaveBeenCalledTimes(1);
      });

      const card = vi.mocked(teamsAdapter.send).mock.calls[0]?.[0];
      expect(card?.body[0]?.text).toContain('Failed');
    });
  });

  describe('escalation_created events', () => {
    it('sends needs_input card for ask_human escalation', async () => {
      const service = createService();
      service.start();

      const event: EscalationCreatedEvent = {
        type: 'session.escalation_created',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        escalation: {
          id: 'esc-1',
          sessionId: 'sess-123',
          type: 'ask_human',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { question: 'Which approach?' },
          response: null,
        },
      };
      eventBus.emit(event);

      await vi.waitFor(() => {
        expect(teamsAdapter.send).toHaveBeenCalledTimes(1);
      });

      const card = vi.mocked(teamsAdapter.send).mock.calls[0]?.[0];
      expect(card?.body[0]?.text).toContain('Input');
    });

    it('does NOT send for ask_ai escalation', async () => {
      const service = createService();
      service.start();

      const event: EscalationCreatedEvent = {
        type: 'session.escalation_created',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        escalation: {
          id: 'esc-1',
          sessionId: 'sess-123',
          type: 'ask_ai',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { question: 'What is the pattern?', domain: 'react' },
          response: null,
        },
      };
      eventBus.emit(event);

      // Give it a tick to process
      await new Promise((r) => setTimeout(r, 50));
      expect(teamsAdapter.send).not.toHaveBeenCalled();
    });

    it('sends for report_blocker escalation', async () => {
      const service = createService();
      service.start();

      const event: EscalationCreatedEvent = {
        type: 'session.escalation_created',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        escalation: {
          id: 'esc-2',
          sessionId: 'sess-123',
          type: 'report_blocker',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { description: 'Blocked', attempted: [], needs: 'Access' },
          response: null,
        },
      };
      eventBus.emit(event);

      await vi.waitFor(() => {
        expect(teamsAdapter.send).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('status_changed events', () => {
    it('sends error card when status changes to failed', async () => {
      const service = createService();
      service.start();

      const event: SessionStatusChangedEvent = {
        type: 'session.status_changed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        previousStatus: 'running',
        newStatus: 'failed',
      };
      eventBus.emit(event);

      await vi.waitFor(() => {
        expect(teamsAdapter.send).toHaveBeenCalledTimes(1);
      });

      const card = vi.mocked(teamsAdapter.send).mock.calls[0]?.[0];
      expect(card?.body[0]?.text).toContain('Error');
    });

    it('does not send for non-failed status changes', async () => {
      const service = createService();
      service.start();

      const event: SessionStatusChangedEvent = {
        type: 'session.status_changed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        previousStatus: 'queued',
        newStatus: 'running',
      };
      eventBus.emit(event);

      await new Promise((r) => setTimeout(r, 50));
      expect(teamsAdapter.send).not.toHaveBeenCalled();
    });
  });

  describe('filtering', () => {
    it('does not send when event type is not enabled', async () => {
      config = {
        teams: {
          webhookUrl: 'https://webhook.example.com',
          enabledEvents: ['session_validated'], // only validated
        },
      };

      const service = createService();
      service.start();

      // Emit a status_changed → failed, which maps to session_error (not enabled)
      const event: SessionStatusChangedEvent = {
        type: 'session.status_changed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        previousStatus: 'running',
        newStatus: 'failed',
      };
      eventBus.emit(event);

      await new Promise((r) => setTimeout(r, 50));
      expect(teamsAdapter.send).not.toHaveBeenCalled();
    });

    it('respects profile override disabling', async () => {
      config = {
        teams: {
          webhookUrl: 'https://webhook.example.com',
          enabledEvents: ['session_validated'],
          profileOverrides: {
            'my-app': { enabled: false },
          },
        },
      };

      const service = createService();
      service.start();

      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        result: {
          sessionId: 'sess-123',
          attempt: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'pass',
          duration: 1100,
        },
      };
      eventBus.emit(event);

      await new Promise((r) => setTimeout(r, 50));
      expect(teamsAdapter.send).not.toHaveBeenCalled();
    });

    it('respects profile override with specific events', async () => {
      config = {
        teams: {
          webhookUrl: 'https://webhook.example.com',
          enabledEvents: ['session_validated', 'session_error'],
          profileOverrides: {
            'my-app': { enabled: true, events: ['session_error'] }, // only errors for this profile
          },
        },
      };

      const service = createService();
      service.start();

      // Emit validated — should NOT send because profile override only allows session_error
      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        result: {
          sessionId: 'sess-123',
          attempt: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'pass',
          duration: 1100,
        },
      };
      eventBus.emit(event);

      await new Promise((r) => setTimeout(r, 50));
      expect(teamsAdapter.send).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('does not send when rate limited', async () => {
      vi.mocked(rateLimiter.canSend).mockReturnValue({
        allowed: false,
        reason: 'Rate limit exceeded',
      });

      const service = createService();
      service.start();

      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        result: {
          sessionId: 'sess-123',
          attempt: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'pass',
          duration: 1100,
        },
      };
      eventBus.emit(event);

      await new Promise((r) => setTimeout(r, 50));
      expect(teamsAdapter.send).not.toHaveBeenCalled();
    });

    it('records sent after successful send', async () => {
      const service = createService();
      service.start();

      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        result: {
          sessionId: 'sess-123',
          attempt: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'pass',
          duration: 1100,
        },
      };
      eventBus.emit(event);

      await vi.waitFor(() => {
        expect(rateLimiter.recordSent).toHaveBeenCalledWith('sess-123');
      });
    });
  });

  describe('error handling', () => {
    it('never lets adapter errors propagate', async () => {
      vi.mocked(teamsAdapter.send).mockRejectedValue(new Error('Boom'));

      const service = createService();
      service.start();

      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-123',
        result: {
          sessionId: 'sess-123',
          attempt: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'pass',
          duration: 1100,
        },
      };

      // This should not throw
      eventBus.emit(event);

      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error) }),
          expect.stringContaining('failed'),
        );
      });
    });

    it('handles session lookup failure gracefully', async () => {
      vi.mocked(sessionLookup.getSession).mockImplementation(() => {
        throw new Error('Session not found');
      });

      const service = createService();
      service.start();

      const event: ValidationCompletedEvent = {
        type: 'session.validation_completed',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 'sess-missing',
        result: {
          sessionId: 'sess-missing',
          attempt: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 1000 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'pass',
          duration: 1100,
        },
      };

      // Should not throw
      eventBus.emit(event);

      await new Promise((r) => setTimeout(r, 50));
      expect(teamsAdapter.send).not.toHaveBeenCalled();
    });
  });
});
