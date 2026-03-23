import type { SessionStatus } from './types/session.js';

export const SESSION_ID_LENGTH = 8;
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;
export const DEFAULT_HEALTH_TIMEOUT = 120;
export const DEFAULT_HUMAN_RESPONSE_TIMEOUT = 3600;
export const DEFAULT_MAX_AI_ESCALATIONS = 5;
export const DEFAULT_AUTO_PAUSE_AFTER = 3;
export const MAX_BUILD_LOG_LENGTH = 10_000;
export const MAX_DIFF_LENGTH = 50_000;
export const SCREENSHOT_QUALITY = 80;
export const EVENT_LOG_RETENTION_DAYS = 30;

export const VALID_STATUS_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  queued: ['provisioning', 'killing'],
  provisioning: ['running', 'killing'],
  running: ['awaiting_input', 'validating', 'paused', 'killing'],
  awaiting_input: ['running', 'killing'],
  paused: ['running', 'killing'],
  validating: ['validated', 'running', 'failed', 'killing'],
  validated: ['approved', 'running', 'killing'],
  failed: ['running', 'killing'],
  approved: ['merging'],
  merging: ['complete'],
  complete: [],
  killing: ['killed'],
  killed: [],
};
