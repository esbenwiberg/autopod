import type { EscalationRequest } from './escalation.js';
import type { ValidationResult } from './validation.js';

export type NotificationType =
  | 'session_validated'
  | 'session_failed'
  | 'session_needs_input'
  | 'session_error';

export interface NotificationPayload {
  type: NotificationType;
  sessionId: string;
  profileName: string;
  task: string;
  timestamp: string;
}

export interface SessionValidatedNotification extends NotificationPayload {
  type: 'session_validated';
  previewUrl: string | null;
  prUrl: string | null;
  /** Validation screenshots as base64 PNGs (page path → base64 data) */
  screenshots: Array<{ pagePath: string; base64: string }>;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  duration: number;
}

export interface SessionFailedNotification extends NotificationPayload {
  type: 'session_failed';
  reason: string;
  validationResult: ValidationResult | null;
  screenshotUrl: string | null;
}

export interface SessionNeedsInputNotification extends NotificationPayload {
  type: 'session_needs_input';
  escalation: EscalationRequest;
}

export interface SessionErrorNotification extends NotificationPayload {
  type: 'session_error';
  error: string;
  fatal: boolean;
}
