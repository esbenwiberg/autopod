import type {
  AskHumanPayload,
  NotificationPayload,
  ReportBlockerPayload,
  SessionErrorNotification,
  SessionFailedNotification,
  SessionNeedsInputNotification,
  SessionValidatedNotification,
} from '@autopod/shared';

export interface AdaptiveCardElement {
  type: string;
  [key: string]: unknown;
}

export interface AdaptiveCardAction {
  type: string;
  title: string;
  [key: string]: unknown;
}

export interface AdaptiveCard {
  $schema: string;
  type: 'AdaptiveCard';
  version: '1.5';
  body: AdaptiveCardElement[];
  actions?: AdaptiveCardAction[];
}

// --- Helpers ---

function headerBlock(text: string, color: 'good' | 'attention' | 'warning'): AdaptiveCardElement {
  return {
    type: 'TextBlock',
    text,
    size: 'Medium',
    weight: 'Bolder',
    color,
  };
}

function taskTitle(notification: NotificationPayload): AdaptiveCardElement {
  return {
    type: 'TextBlock',
    text: notification.task,
    wrap: true,
    size: 'Small',
  };
}

function sessionFacts(facts: Array<{ title: string; value: string }>): AdaptiveCardElement {
  return {
    type: 'FactSet',
    facts: facts.map((f) => ({ title: f.title, value: f.value })),
  };
}

function cliHint(command: string): AdaptiveCardElement {
  return {
    type: 'TextBlock',
    text: `\`${command}\``,
    fontType: 'Monospace',
    size: 'Small',
    color: 'Accent',
    spacing: 'Small',
  };
}

function previewAction(url: string): AdaptiveCardAction {
  return {
    type: 'Action.OpenUrl',
    title: 'Open Preview',
    url,
  };
}

function prAction(url: string): AdaptiveCardAction {
  return {
    type: 'Action.OpenUrl',
    title: 'View Pull Request',
    url,
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function baseCard(body: AdaptiveCardElement[], actions?: AdaptiveCardAction[]): AdaptiveCard {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
    ...(actions && actions.length > 0 ? { actions } : {}),
  };
}

// --- Card Builders ---

export function buildValidatedCard(notification: SessionValidatedNotification): AdaptiveCard {
  const facts = [
    { title: 'Profile', value: notification.profileName },
    { title: 'Duration', value: formatDuration(notification.duration) },
    { title: 'Files Changed', value: String(notification.filesChanged) },
    { title: 'Lines', value: `+${notification.linesAdded} / -${notification.linesRemoved}` },
    { title: 'Session', value: notification.sessionId },
  ];

  const body: AdaptiveCardElement[] = [
    headerBlock('Session Validated', 'good'),
    taskTitle(notification),
    sessionFacts(facts),
  ];

  // Inline screenshots (base64 PNGs)
  if (notification.screenshots && notification.screenshots.length > 0) {
    for (const ss of notification.screenshots) {
      body.push({
        type: 'TextBlock',
        text: `Page: ${ss.pagePath}`,
        size: 'Small',
        weight: 'Bolder',
        spacing: 'Medium',
      });
      body.push({
        type: 'Image',
        url: `data:image/png;base64,${ss.base64}`,
        size: 'Large',
        altText: `Screenshot of ${ss.pagePath}`,
      });
    }
  }

  body.push(cliHint(`ap diff ${notification.sessionId}`));
  body.push(cliHint(`ap approve ${notification.sessionId}`));

  const actions: AdaptiveCardAction[] = [];
  if (notification.prUrl) {
    actions.push(prAction(notification.prUrl));
  }
  if (notification.previewUrl) {
    actions.push(previewAction(notification.previewUrl));
  }

  return baseCard(body, actions);
}

export function buildFailedCard(notification: SessionFailedNotification): AdaptiveCard {
  const body: AdaptiveCardElement[] = [
    headerBlock('Validation Failed', 'attention'),
    taskTitle(notification),
    {
      type: 'TextBlock',
      text: notification.reason,
      wrap: true,
      color: 'Attention',
    },
  ];

  if (notification.validationResult) {
    body.push(
      sessionFacts([
        { title: 'Attempt', value: String(notification.validationResult.attempt) },
        { title: 'Profile', value: notification.profileName },
        { title: 'Session', value: notification.sessionId },
      ]),
    );
  }

  body.push(cliHint(`ap reject ${notification.sessionId}`));

  return baseCard(body);
}

export function buildNeedsInputCard(notification: SessionNeedsInputNotification): AdaptiveCard {
  const escalation = notification.escalation;
  const body: AdaptiveCardElement[] = [
    headerBlock('Human Input Needed', 'warning'),
    taskTitle(notification),
  ];

  // Extract question/description from payload based on type
  if (escalation.type === 'ask_human') {
    const payload = escalation.payload as AskHumanPayload;
    body.push({
      type: 'TextBlock',
      text: payload.question,
      wrap: true,
    });
    if (payload.options && payload.options.length > 0) {
      body.push({
        type: 'TextBlock',
        text: `Options: ${payload.options.join(', ')}`,
        wrap: true,
        size: 'Small',
        isSubtle: true,
      });
    }
  } else if (escalation.type === 'report_blocker') {
    const payload = escalation.payload as ReportBlockerPayload;
    body.push({
      type: 'TextBlock',
      text: payload.description,
      wrap: true,
    });
    body.push({
      type: 'TextBlock',
      text: `Needs: ${payload.needs}`,
      wrap: true,
      size: 'Small',
      isSubtle: true,
    });
  }

  body.push(
    sessionFacts([
      { title: 'Profile', value: notification.profileName },
      { title: 'Session', value: notification.sessionId },
      { title: 'Type', value: escalation.type },
    ]),
  );

  body.push(cliHint(`ap tell ${notification.sessionId} "<response>"`));

  return baseCard(body);
}

export function buildErrorCard(notification: SessionErrorNotification): AdaptiveCard {
  const body: AdaptiveCardElement[] = [
    headerBlock(notification.fatal ? 'Fatal Error' : 'Session Error', 'attention'),
    taskTitle(notification),
    {
      type: 'TextBlock',
      text: notification.error,
      wrap: true,
      color: 'Attention',
    },
    sessionFacts([
      { title: 'Profile', value: notification.profileName },
      { title: 'Session', value: notification.sessionId },
      { title: 'Fatal', value: notification.fatal ? 'Yes' : 'No' },
    ]),
  ];

  return baseCard(body);
}
