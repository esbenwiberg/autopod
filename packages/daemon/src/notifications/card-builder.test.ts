import { describe, it, expect } from 'vitest';
import type {
  SessionValidatedNotification,
  SessionFailedNotification,
  SessionNeedsInputNotification,
  SessionErrorNotification,
} from '@autopod/shared';
import { buildValidatedCard, buildFailedCard, buildNeedsInputCard, buildErrorCard } from './card-builder.js';

describe('Card Builder', () => {
  const basePayload = {
    sessionId: 'sess-abc123',
    profileName: 'my-app',
    task: 'Add dark mode toggle',
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  describe('buildValidatedCard', () => {
    const notification: SessionValidatedNotification = {
      ...basePayload,
      type: 'session_validated',
      previewUrl: 'https://preview.example.com/sess-abc123',
      prUrl: 'https://github.com/org/repo/pull/42',
      filesChanged: 5,
      linesAdded: 120,
      linesRemoved: 30,
      duration: 95000,
    };

    it('produces valid AdaptiveCard structure', () => {
      const card = buildValidatedCard(notification);
      expect(card.$schema).toBe('http://adaptivecards.io/schemas/adaptive-card.json');
      expect(card.type).toBe('AdaptiveCard');
      expect(card.version).toBe('1.5');
      expect(card.body.length).toBeGreaterThan(0);
    });

    it('includes green header', () => {
      const card = buildValidatedCard(notification);
      const header = card.body[0]!;
      expect(header.text).toContain('Validated');
      expect(header.color).toBe('good');
    });

    it('includes session facts', () => {
      const card = buildValidatedCard(notification);
      const factSet = card.body.find((b) => b.type === 'FactSet');
      expect(factSet).toBeDefined();
      const facts = factSet!.facts as Array<{ title: string; value: string }>;
      expect(facts.find((f) => f.title === 'Profile')?.value).toBe('my-app');
      expect(facts.find((f) => f.title === 'Files Changed')?.value).toBe('5');
      expect(facts.find((f) => f.title === 'Session')?.value).toBe('sess-abc123');
    });

    it('includes PR and preview URL actions when present', () => {
      const card = buildValidatedCard(notification);
      expect(card.actions).toBeDefined();
      expect(card.actions!.length).toBe(2);
      expect(card.actions![0]!.title).toBe('View Pull Request');
      expect(card.actions![0]!.url).toBe('https://github.com/org/repo/pull/42');
      expect(card.actions![1]!.title).toBe('Open Preview');
      expect(card.actions![1]!.url).toBe('https://preview.example.com/sess-abc123');
    });

    it('omits actions when no PR URL and no preview URL', () => {
      const card = buildValidatedCard({ ...notification, previewUrl: null, prUrl: null });
      expect(card.actions).toBeUndefined();
    });

    it('includes only PR action when no preview URL', () => {
      const card = buildValidatedCard({ ...notification, previewUrl: null });
      expect(card.actions).toBeDefined();
      expect(card.actions!.length).toBe(1);
      expect(card.actions![0]!.title).toBe('View Pull Request');
    });

    it('includes CLI hints', () => {
      const card = buildValidatedCard(notification);
      const cliHints = card.body.filter((b) => b.fontType === 'Monospace');
      expect(cliHints.length).toBe(2);
      expect(cliHints[0]!.text).toContain('ap diff');
      expect(cliHints[1]!.text).toContain('ap approve');
    });

    it('matches snapshot', () => {
      const card = buildValidatedCard(notification);
      expect(card).toMatchSnapshot();
    });
  });

  describe('buildFailedCard', () => {
    const notification: SessionFailedNotification = {
      ...basePayload,
      type: 'session_failed',
      reason: 'Build failed with exit code 1',
      validationResult: {
        sessionId: 'sess-abc123',
        attempt: 2,
        timestamp: '2026-01-01T00:01:00.000Z',
        smoke: {
          status: 'fail',
          build: { status: 'fail', output: 'Error: Module not found', duration: 5000 },
          health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 500 },
          pages: [],
        },
        taskReview: null,
        overall: 'fail',
        duration: 5500,
      },
      screenshotUrl: null,
    };

    it('produces valid card with attention color', () => {
      const card = buildFailedCard(notification);
      expect(card.type).toBe('AdaptiveCard');
      const header = card.body[0]!;
      expect(header.color).toBe('attention');
      expect(header.text).toContain('Failed');
    });

    it('includes failure reason', () => {
      const card = buildFailedCard(notification);
      const reasonBlock = card.body.find((b) => b.text === 'Build failed with exit code 1');
      expect(reasonBlock).toBeDefined();
    });

    it('includes attempt count in facts', () => {
      const card = buildFailedCard(notification);
      const factSet = card.body.find((b) => b.type === 'FactSet');
      expect(factSet).toBeDefined();
      const facts = factSet!.facts as Array<{ title: string; value: string }>;
      expect(facts.find((f) => f.title === 'Attempt')?.value).toBe('2');
    });

    it('includes reject CLI hint', () => {
      const card = buildFailedCard(notification);
      const cliHints = card.body.filter((b) => b.fontType === 'Monospace');
      expect(cliHints.some((h) => (h.text as string).includes('ap reject'))).toBe(true);
    });

    it('matches snapshot', () => {
      const card = buildFailedCard(notification);
      expect(card).toMatchSnapshot();
    });
  });

  describe('buildNeedsInputCard', () => {
    it('builds card for ask_human escalation', () => {
      const notification: SessionNeedsInputNotification = {
        ...basePayload,
        type: 'session_needs_input',
        escalation: {
          id: 'esc-1',
          sessionId: 'sess-abc123',
          type: 'ask_human',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: {
            question: 'Should I use CSS modules or Tailwind?',
            options: ['CSS Modules', 'Tailwind CSS'],
          },
          response: null,
        },
      };

      const card = buildNeedsInputCard(notification);
      expect(card.type).toBe('AdaptiveCard');

      const header = card.body[0]!;
      expect(header.color).toBe('warning');
      expect(header.text).toContain('Input');

      // Question should appear
      const questionBlock = card.body.find((b) => b.text === 'Should I use CSS modules or Tailwind?');
      expect(questionBlock).toBeDefined();

      // Options should appear
      const optionsBlock = card.body.find((b) => (b.text as string)?.includes('CSS Modules'));
      expect(optionsBlock).toBeDefined();

      // CLI hint
      const cliHints = card.body.filter((b) => b.fontType === 'Monospace');
      expect(cliHints.some((h) => (h.text as string).includes('ap tell'))).toBe(true);
    });

    it('builds card for report_blocker escalation', () => {
      const notification: SessionNeedsInputNotification = {
        ...basePayload,
        type: 'session_needs_input',
        escalation: {
          id: 'esc-2',
          sessionId: 'sess-abc123',
          type: 'report_blocker',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: {
            description: 'Cannot access database',
            attempted: ['checked connection string', 'verified network'],
            needs: 'Database credentials',
          },
          response: null,
        },
      };

      const card = buildNeedsInputCard(notification);
      const descBlock = card.body.find((b) => b.text === 'Cannot access database');
      expect(descBlock).toBeDefined();

      const needsBlock = card.body.find((b) => (b.text as string)?.includes('Database credentials'));
      expect(needsBlock).toBeDefined();
    });

    it('matches snapshot', () => {
      const notification: SessionNeedsInputNotification = {
        ...basePayload,
        type: 'session_needs_input',
        escalation: {
          id: 'esc-1',
          sessionId: 'sess-abc123',
          type: 'ask_human',
          timestamp: '2026-01-01T00:00:00.000Z',
          payload: { question: 'Pick a color' },
          response: null,
        },
      };
      const card = buildNeedsInputCard(notification);
      expect(card).toMatchSnapshot();
    });
  });

  describe('buildErrorCard', () => {
    const notification: SessionErrorNotification = {
      ...basePayload,
      type: 'session_error',
      error: 'Container OOM killed',
      fatal: true,
    };

    it('produces valid card with attention color', () => {
      const card = buildErrorCard(notification);
      expect(card.type).toBe('AdaptiveCard');
      const header = card.body[0]!;
      expect(header.color).toBe('attention');
    });

    it('shows Fatal Error for fatal errors', () => {
      const card = buildErrorCard(notification);
      expect(card.body[0]!.text).toContain('Fatal');
    });

    it('shows Session Error for non-fatal errors', () => {
      const card = buildErrorCard({ ...notification, fatal: false });
      expect(card.body[0]!.text).toBe('Session Error');
    });

    it('includes error message and fatal flag', () => {
      const card = buildErrorCard(notification);
      const errorBlock = card.body.find((b) => b.text === 'Container OOM killed');
      expect(errorBlock).toBeDefined();

      const factSet = card.body.find((b) => b.type === 'FactSet');
      const facts = factSet!.facts as Array<{ title: string; value: string }>;
      expect(facts.find((f) => f.title === 'Fatal')?.value).toBe('Yes');
    });

    it('matches snapshot', () => {
      const card = buildErrorCard(notification);
      expect(card).toMatchSnapshot();
    });
  });
});
