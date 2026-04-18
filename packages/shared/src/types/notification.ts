import type { EscalationRequest } from './escalation.js';
import type { ValidationResult } from './validation.js';

export type NotificationType = 'pod_validated' | 'pod_failed' | 'pod_needs_input' | 'pod_error';

export interface NotificationPayload {
  type: NotificationType;
  podId: string;
  profileName: string;
  task: string;
  timestamp: string;
}

export interface PodValidatedNotification extends NotificationPayload {
  type: 'pod_validated';
  previewUrl: string | null;
  prUrl: string | null;
  /** Validation screenshots as base64 PNGs (page path → base64 data) */
  screenshots: Array<{ pagePath: string; base64: string }>;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  duration: number;
}

export interface PodFailedNotification extends NotificationPayload {
  type: 'pod_failed';
  reason: string;
  validationResult: ValidationResult | null;
  screenshotUrl: string | null;
}

export interface PodNeedsInputNotification extends NotificationPayload {
  type: 'pod_needs_input';
  escalation: EscalationRequest;
}

export interface PodErrorNotification extends NotificationPayload {
  type: 'pod_error';
  error: string;
  fatal: boolean;
}
