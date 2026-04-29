import type { PodStatus } from './types/pod.js';

export const POD_ID_LENGTH = 8;
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;
export const DEFAULT_MAX_PR_FIX_ATTEMPTS = 2;
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
 * Maximum number of memory entries to include in the system instructions index.
 * Only paths and IDs are rendered — agents use `memory_read` for full content.
 */
export const MAX_MEMORY_INDEX_ENTRIES = 100;

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

export const VALID_STATUS_TRANSITIONS: Record<PodStatus, PodStatus[]> = {
  queued: ['provisioning', 'killing'],
  provisioning: ['running', 'killing', 'failed'],
  running: ['awaiting_input', 'validating', 'paused', 'handoff', 'killing', 'complete', 'failed'],
  awaiting_input: ['running', 'killing', 'failed'],
  paused: ['running', 'killing', 'failed'],
  validating: ['validated', 'running', 'failed', 'review_required', 'killing', 'awaiting_input'],
  validated: ['approved', 'running', 'validating', 'killing', 'queued'],
  failed: ['running', 'validating', 'validated', 'killing', 'queued', 'merge_pending'],
  review_required: ['running', 'validating', 'validated', 'killing', 'queued'],
  approved: ['merging'],
  merging: ['complete', 'merge_pending'],
  merge_pending: ['complete', 'failed', 'killing'],
  // `complete → queued` is reachable only via the long-lived fix-pod path
  // (`profile.reuseFixPod = true`): when a parent PR receives new CI / review
  // feedback after the fix pod already completed, the daemon re-enqueues the
  // same pod entity with a fresh task and container instead of spawning a
  // new child pod.
  complete: ['queued'],
  // handoff re-enters orchestration: interactive pod has been stopped and
  // is being provisioned again with a new pod options (agentMode: 'auto').
  handoff: ['provisioning', 'killing'],
  killing: ['killed'],
  killed: ['validating', 'queued'],
};
