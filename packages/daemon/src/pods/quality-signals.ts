import type {
  AgentActivityEvent,
  AgentCompleteEvent,
  AgentTaskSummaryEvent,
  AgentToolUseEvent,
  EscalationType,
  QualityGrade,
  QualitySignals,
} from '@autopod/shared';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventRepository } from './event-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import { type QualityActivity, normalizeQualityActivityEvidence } from './quality-activity.js';
import {
  QUALITY_SCORE_ALGORITHM_VERSION,
  type QualityScoreRepository,
} from './quality-score-repository.js';
import { computeProcessHealthScore } from './quality-score.js';
import type { ValidationRepository } from './validation-repository.js';

export interface QualitySignalsDeps {
  podRepo: PodRepository;
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  /** Optional — when wired, pulls the persisted numeric score + model tag. */
  qualityScoreRepo?: QualityScoreRepository;
  /** Optional — when wired, determines whether smoke validation passed. */
  validationRepo?: ValidationRepository;
  /** Optional — immutable attempt accounting replaces mutable pod totals when present. */
  providerAttemptRepo?: ProviderAttemptRepository;
}

// Patterns derived from real low-scoring pod sessions via history scan pod.
const TELL_PATTERNS: RegExp[] = [
  /\birreconcilable\b/i,
  /Having both .{5,60} is impossible/i,
  /Unable\s*[—\-–]\s*needs real/i,
  /(?:previous|prior) (?:attempt|pod|run) (?:already|also) confirmed/i,
  /\bI apologize\b/i,
  /\bI(?:'m| am) sorry I (?:was unable|wasn't able|couldn't|cannot|can't)\b/i,
  /Unfortunately.{0,40}(?:unable|cannot|couldn't|was not able)/i,
  /\bI(?:'m| am) not sure (?:how|what|whether) to proceed\b/i,
  /\bit(?:'s| is) unclear (?:how|what|whether) (?:I should|to)\b/i,
  /(?:no viable|no clear) (?:path|option|way) forward/i,
];

function detectTells(texts: string[]): number {
  // Count distinct patterns triggered across all text — one pattern can only
  // fire once regardless of how many times it appears (avoid inflating the count).
  let count = 0;
  for (const pattern of TELL_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) count += 1;
  }
  return count;
}

// Escalation types that pull a human into the loop. `ask_ai` is agent-to-agent
// and intentionally excluded.
const HUMAN_INTERRUPT_TYPES: EscalationType[] = [
  'ask_human',
  'report_blocker',
  'action_approval',
  'validation_override',
];

export function computeQualitySignals(podId: string, deps: QualitySignalsDeps): QualitySignals {
  // Throws PodNotFoundError if the id is unknown — let routes/callers surface it.
  const pod = deps.podRepo.getOrThrow(podId);
  const events = deps.eventRepo.getForSession(podId);

  const qualityActivities: QualityActivity[] = [];
  const textSamples: string[] = [];
  let browserCalls = 0;
  let browserTotalChecks = 0;
  let browserPassedChecks = 0;
  let ambiguousInspectionCount = 0;

  for (const stored of events) {
    if (stored.type !== 'pod.agent_activity') continue;
    const activity = stored.payload as AgentActivityEvent;
    const event = activity.event;

    const activityEvidence = normalizeQualityActivityEvidence(event);
    qualityActivities.push(...activityEvidence.activities);
    if (activityEvidence.ambiguousInspection) ambiguousInspectionCount += 1;

    if (event.type === 'tool_use') {
      const tool = event as AgentToolUseEvent;
      if (toolBaseName(tool.tool) === 'validate_in_browser' && tool.output) {
        browserCalls += 1;
        try {
          const parsed = JSON.parse(tool.output) as {
            passed?: boolean;
            results?: { passed?: boolean }[];
          };
          const results = parsed.results ?? [];
          browserTotalChecks += results.length;
          browserPassedChecks += results.filter((r) => r.passed === true).length;
        } catch {
          // Tool output may be a raw error string instead of JSON — count the
          // call but don't increment check counts.
        }
      }
    } else if (event.type === 'complete') {
      const complete = event as AgentCompleteEvent;
      textSamples.push(complete.result);
    } else if (event.type === 'task_summary') {
      const summary = event as AgentTaskSummaryEvent;
      textSamples.push(summary.actualSummary);
      if (summary.how) textSamples.push(summary.how);
    }
  }

  let readCount = 0;
  let editCount = 0;
  let inspectionEvidenceComplete = true;
  const readPaths = new Set<string>();
  const blindPaths = new Set<string>();
  const fileModifyCounts = new Map<string, number>();
  const correlatedActivities = correlateMutationRepresentations(qualityActivities);
  for (const normalized of correlatedActivities) {
    if (normalized.kind === 'inspection') {
      readCount += 1;
      readPaths.add(normalized.path);
      continue;
    }

    if (normalized.action === 'write') {
      editCount += 1;
      inspectionEvidenceComplete = false;
      continue;
    }
    if (normalized.action === 'create' || normalized.action === 'modify') {
      editCount += 1;
    }
    if (normalized.action === 'modify') {
      if (!readPaths.has(normalized.path)) blindPaths.add(normalized.path);
      fileModifyCounts.set(normalized.path, (fileModifyCounts.get(normalized.path) ?? 0) + 1);
    }
  }

  // Files edited 3+ times indicate thrashing / rework.
  let editChurnCount = 0;
  for (const count of fileModifyCounts.values()) {
    if (count >= 3) editChurnCount += 1;
  }

  const userInterrupts = deps.escalationRepo.countBySessionAndTypes(podId, HUMAN_INTERRUPT_TYPES);
  const modifiedFileCount = fileModifyCounts.size;
  const hasVerifiedInspection = correlatedActivities.some(
    (activity) => activity.kind === 'inspection',
  );
  // Ambiguous shell activity remains diagnostic, but it must not erase independent reads and
  // resolved file changes. Keep failing closed when ambiguity is the only inspection evidence.
  const inspectionUnavailableReason = !inspectionEvidenceComplete
    ? 'unresolved_write'
    : ambiguousInspectionCount > 0 && !hasVerifiedInspection
      ? 'ambiguous_inspection'
      : correlatedActivities.length === 0
        ? 'no_activity'
        : null;
  const inspectionAvailability = inspectionUnavailableReason === null ? 'available' : 'unavailable';
  const availableReadCount = inspectionAvailability === 'available' ? readCount : null;
  const readEditRatio =
    inspectionAvailability === 'available'
      ? editCount > 0
        ? readCount / editCount
        : readCount
      : null;
  const editsWithoutPriorRead = inspectionAvailability === 'available' ? blindPaths.size : null;

  const tellsCount = detectTells(textSamples);
  const prFixAttempts = pod.prFixAttempts ?? 0;

  // Compatibility/display field: report the latest attempt, never "any pass ever".
  let validationPassed: boolean | null = null;
  if (deps.validationRepo) {
    const latestValidation = deps.validationRepo.getForSession(podId).at(-1);
    if (latestValidation) validationPassed = latestValidation.result.overall === 'pass';
  }

  // Surface the persisted score + model string when available. Both are null
  // until the recorder writes a row on PodCompletedEvent.
  const persisted = deps.qualityScoreRepo?.get(podId) ?? null;
  const attemptTotals = deps.providerAttemptRepo?.totals(podId);
  const hasAttempts = (deps.providerAttemptRepo?.list(podId).length ?? 0) > 0;

  const browserChecks =
    browserCalls === 0
      ? null
      : {
          calls: browserCalls,
          totalChecks: browserTotalChecks,
          passedChecks: browserPassedChecks,
        };

  return {
    podId,
    inspectionAvailability,
    inspectionUnavailableReason,
    ambiguousInspectionCount,
    readCount: availableReadCount,
    editCount,
    modifiedFileCount,
    readEditRatio,
    editsWithoutPriorRead,
    userInterrupts,
    editChurnCount,
    tellsCount,
    prFixAttempts,
    validationPassed,
    browserChecks,
    tokens: {
      input: hasAttempts ? (attemptTotals?.inputTokens ?? 0) : pod.inputTokens,
      output: hasAttempts ? (attemptTotals?.outputTokens ?? 0) : pod.outputTokens,
      costUsd: hasAttempts ? (attemptTotals?.costUsd ?? 0) : pod.costUsd,
    },
    grade: grade(
      inspectionAvailability === 'available'
        ? computeProcessHealthScore({
            readEditRatio,
            editCount,
            modifiedFileCount,
            editsWithoutPriorRead,
            userInterrupts,
            editChurnCount,
            tellsCount,
          })
        : null,
    ),
    score: persisted?.algorithmVersion === QUALITY_SCORE_ALGORITHM_VERSION ? persisted.score : null,
    model: persisted?.model ?? pod.model,
  };
}

function correlateMutationRepresentations(activities: QualityActivity[]): QualityActivity[] {
  const correlated: QualityActivity[] = [];
  for (const activity of activities) {
    const previous = correlated.at(-1);
    if (
      activity.kind === 'mutation' &&
      previous?.kind === 'mutation' &&
      activity.path === previous.path &&
      previous.source === 'native-tool' &&
      activity.source === 'file-change'
    ) {
      // Some runtimes retain both the native edit/write call and the resulting
      // file_change. They are adjacent representations of one operation. Keep
      // the file_change because it carries the resolved create/modify action.
      correlated[correlated.length - 1] = activity;
      continue;
    }
    correlated.push(activity);
  }
  return correlated;
}

function toolBaseName(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const separator = toolName.indexOf('__', 'mcp__'.length);
  return separator === -1 ? toolName : toolName.slice(separator + 2);
}

function grade(score: number | null): QualityGrade {
  if (score === null) return 'green';
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}
