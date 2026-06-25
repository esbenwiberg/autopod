import type { PodStatus } from './types/pod.js';

export const POD_ID_LENGTH = 8;
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;
export const DEFAULT_MAX_PR_FIX_ATTEMPTS = 5;
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
 * Default per-pod CPU cap, in fractional cores. Agent pods spawn unbounded by
 * default, so a single `npm install` / build can saturate every host core —
 * and with `MAX_CONCURRENCY` pods running at once the host melts. This caps
 * each pod so concurrent pods stay civil. Override with the `CONTAINER_CPUS`
 * env var; set it to `0` (or negative) for unbounded (the old behaviour).
 */
export const DEFAULT_CONTAINER_CPUS = 2;

/**
 * Resolve the per-pod CPU cap (in NanoCpus — billionths of a core, the unit
 * Docker's `HostConfig.NanoCpus` expects) from a raw `CONTAINER_CPUS` env value.
 *
 * - unset / empty / unparseable → {@link DEFAULT_CONTAINER_CPUS}
 * - `<= 0` → `undefined` (no cap; container may use all host cores)
 * - otherwise → the value in cores, converted to NanoCpus
 */
export function resolveContainerNanoCpus(
  rawEnvValue: string | undefined,
  defaultCpus: number = DEFAULT_CONTAINER_CPUS,
): number | undefined {
  let cpus = defaultCpus;
  if (rawEnvValue !== undefined && rawEnvValue.trim() !== '') {
    const parsed = Number.parseFloat(rawEnvValue);
    if (Number.isFinite(parsed)) {
      cpus = parsed;
    }
  }
  if (cpus <= 0) {
    return undefined;
  }
  return Math.floor(cpus * 1e9);
}

/**
 * Chromium launch flags for Playwright runs inside agent containers.
 *
 * The `--*-sandbox` / `--disable-dev-shm-usage` flags are container hygiene.
 * The remainder disable Chrome's startup background networking — without them
 * Chromium phones home to `www.google.com` (variations/connectivity check) and
 * `accounts.google.com` (GAIA/sync probe) on every launch, which a `restricted`
 * network policy denies and surfaces as noisy firewall-denial findings.
 */
export const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--no-default-browser-check',
  '--metrics-recording-only',
] as const;

/**
 * Container user identity — all agent containers run as this non-root user.
 * Dockerfiles create this user at uid/gid 1000.
 */
export const CONTAINER_USER = 'autopod';
export const CONTAINER_HOME_DIR = '/home/autopod';

/**
 * Path inside the container where autopod writes its generated system instructions.
 * Deliberately outside `/workspace` so it never overwrites the repo's own CLAUDE.md.
 * Claude CLI reads this via `--append-system-prompt-file`; Codex/Copilot via
 * runtime-specific `customInstructions` handling.
 */
export const AUTOPOD_INSTRUCTIONS_PATH = '/home/autopod/.autopod/system-instructions.md';

export const VALID_STATUS_TRANSITIONS: Record<PodStatus, PodStatus[]> = {
  queued: ['provisioning', 'killing'],
  provisioning: ['running', 'killing', 'failed'],
  running: ['awaiting_input', 'validating', 'paused', 'handoff', 'killing', 'complete', 'failed'],
  // `validating` covers the case where the daemon parked the pod after a
  // post-validation push failed on missing/invalid credentials — once the
  // operator updates the profile PAT, the daemon retries the push from the
  // validating state without re-running the agent.
  // `validated` is the human-override path: setSkipValidation/forceApprove on
  // a pod parked here (e.g. on a validation_override escalation) jumps straight
  // to validated without re-running the agent or validation.
  awaiting_input: ['running', 'validating', 'validated', 'killing', 'failed'],
  paused: ['running', 'killing', 'failed'],
  validating: ['validated', 'running', 'failed', 'review_required', 'killing', 'awaiting_input'],
  // `awaiting_input` covers post-validation delivery failures (for example a
  // fix pod validated, then the daemon could not push its branch). Park rather
  // than spending another agent run.
  validated: ['approved', 'running', 'validating', 'awaiting_input', 'killing', 'queued'],
  failed: [
    'running',
    'validating',
    'validated',
    'killing',
    'queued',
    'merge_pending',
    // Operator force-complete: escape hatch for failed pods where the agent's
    // work is fine but a downstream step (push/PR/merge) failed and re-running
    // the agent would burn tokens. Only set via `forceComplete()` in PodManager.
    'complete',
  ],
  review_required: ['running', 'validating', 'validated', 'killing', 'queued'],
  approved: ['merging'],
  merging: ['complete', 'merge_pending', 'validated'],
  // A fix pod that pushed a non-working fix sits in merge_pending; new failure
  // signals or a manual spawn recycle it back to `queued` to take another shot.
  merge_pending: ['complete', 'failed', 'killing', 'queued'],
  // Re-enqueueing a completed pod resets its container and task and runs it
  // again — used when the same pod entity needs to handle a follow-up round
  // of work without losing its identity in the UI.
  complete: ['queued'],
  // handoff re-enters orchestration: interactive pod has been stopped and
  // is being provisioned again with a new pod options (agentMode: 'auto').
  // A handoff persistence failure parks in failed while preserving the live
  // workspace container for recovery.
  handoff: ['provisioning', 'killing', 'failed'],
  killing: ['killed'],
  killed: ['validating', 'queued'],
};
