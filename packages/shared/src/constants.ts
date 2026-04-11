import type { SessionStatus } from './types/session.js';

export const SESSION_ID_LENGTH = 8;
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;
export const DEFAULT_MAX_PR_FIX_ATTEMPTS = 3;
export const DEFAULT_HEALTH_TIMEOUT = 120;
export const DEFAULT_HUMAN_RESPONSE_TIMEOUT = 3600;
export const DEFAULT_MAX_AI_ESCALATIONS = 5;
export const DEFAULT_AUTO_PAUSE_AFTER = 3;
export const MAX_BUILD_LOG_LENGTH = 10_000;
export const MAX_DIFF_LENGTH = 50_000;
export const SCREENSHOT_QUALITY = 80;
export const EVENT_LOG_RETENTION_DAYS = 30;
export const DEFAULT_CONTAINER_MEMORY_GB = 10;

/**
 * Container user identity — all agent containers run as this non-root user.
 * Dockerfiles create this user at uid/gid 1000.
 */
export const CONTAINER_USER = 'autopod';
export const CONTAINER_HOME_DIR = '/home/autopod';

/**
 * Path inside the container where autopod writes its generated system instructions.
 * Deliberately outside `/workspace` so it never overwrites the repo's own CLAUDE.md.
 * Claude CLI reads this via `--append-system-prompt-file`; Copilot via `customInstructions`.
 */
export const AUTOPOD_INSTRUCTIONS_PATH = '/home/autopod/.autopod/system-instructions.md';

export const VALID_STATUS_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  queued: ['provisioning', 'killing'],
  provisioning: ['running', 'killing'],
  running: ['awaiting_input', 'validating', 'paused', 'killing', 'complete', 'failed'],
  awaiting_input: ['running', 'killing'],
  paused: ['running', 'killing'],
  validating: ['validated', 'running', 'failed', 'review_required', 'killing', 'awaiting_input'],
  validated: ['approved', 'running', 'validating', 'killing', 'queued'],
  failed: ['running', 'validating', 'killing', 'queued'],
  review_required: ['running', 'validating', 'killing'],
  approved: ['merging'],
  merging: ['complete', 'merge_pending'],
  merge_pending: ['complete', 'failed', 'killing'],
  complete: [],
  killing: ['killed'],
  killed: ['validating'],
};
