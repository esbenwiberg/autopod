import type {
  AgentActivityEvent,
  AgentCompleteEvent,
  AgentFileChangeEvent,
  AgentTaskSummaryEvent,
  AgentToolUseEvent,
  QualityGrade,
  QualitySignals,
} from '@autopod/shared';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventRepository } from './event-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { QualityScoreRepository } from './quality-score-repository.js';
import type { ValidationRepository } from './validation-repository.js';

export interface QualitySignalsDeps {
  podRepo: PodRepository;
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  /** Optional — when wired, pulls the persisted numeric score + model tag. */
  qualityScoreRepo?: QualityScoreRepository;
  /** Optional — when wired, determines whether smoke validation passed. */
  validationRepo?: ValidationRepository;
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

export function computeQualitySignals(podId: string, deps: QualitySignalsDeps): QualitySignals {
  // Throws PodNotFoundError if the id is unknown — let routes/callers surface it.
  const pod = deps.podRepo.getOrThrow(podId);
  const events = deps.eventRepo.getForSession(podId);

  let readCount = 0;
  let editCount = 0;
  let editsWithoutPriorRead = 0;
  const readPaths = new Set<string>();
  const fileModifyCounts = new Map<string, number>();
  const textSamples: string[] = [];

  for (const stored of events) {
    if (stored.type !== 'pod.agent_activity') continue;
    const activity = stored.payload as AgentActivityEvent;
    const event = activity.event;

    if (event.type === 'tool_use') {
      const tool = event as AgentToolUseEvent;
      if (tool.tool === 'Read') {
        readCount += 1;
        const p = extractPath(tool.input);
        if (p) readPaths.add(p);
      }
      if (tool.output) textSamples.push(tool.output);
    } else if (event.type === 'file_change') {
      const change = event as AgentFileChangeEvent;
      if (change.action === 'create' || change.action === 'modify') {
        editCount += 1;
        // Only `modify` on a file with no prior Read counts as blind.
        // `create` is inherently unread (the file didn't exist); that's fine.
        if (change.action === 'modify' && !readPaths.has(change.path)) {
          editsWithoutPriorRead += 1;
        }
      }
      if (change.action === 'modify') {
        fileModifyCounts.set(change.path, (fileModifyCounts.get(change.path) ?? 0) + 1);
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

  // Files edited 3+ times indicate thrashing / rework.
  let editChurnCount = 0;
  for (const count of fileModifyCounts.values()) {
    if (count >= 3) editChurnCount += 1;
  }

  const askHumanCount = deps.escalationRepo.countBySessionAndType(podId, 'ask_human');
  const killed = pod.status === 'killed' ? 1 : 0;
  const userInterrupts = askHumanCount + killed;

  const readEditRatio = editCount > 0 ? readCount / editCount : readCount;

  const tellsCount = detectTells(textSamples);
  const prFixAttempts = pod.prFixAttempts ?? 0;

  // Validation outcome: pass if any attempt's overall result is 'pass'.
  let validationPassed: boolean | null = null;
  if (deps.validationRepo) {
    const validations = deps.validationRepo.getForSession(podId);
    if (validations.length > 0) {
      validationPassed = validations.some((v) => v.result.overall === 'pass');
    }
  }

  // Surface the persisted score + model string when available. Both are null
  // until the recorder writes a row on PodCompletedEvent.
  const persisted = deps.qualityScoreRepo?.get(podId) ?? null;

  return {
    podId,
    readCount,
    editCount,
    readEditRatio,
    editsWithoutPriorRead,
    userInterrupts,
    editChurnCount,
    tellsCount,
    prFixAttempts,
    validationPassed,
    tokens: {
      input: pod.inputTokens,
      output: pod.outputTokens,
      costUsd: pod.costUsd,
    },
    grade: grade({ readEditRatio, editCount, editsWithoutPriorRead, userInterrupts }),
    score: persisted?.score ?? null,
    model: persisted?.model ?? pod.model,
  };
}

function extractPath(input: Record<string, unknown>): string | null {
  // Claude's Read tool uses `file_path`; be defensive about shape drift.
  const fp = input.file_path;
  if (typeof fp === 'string' && fp.length > 0) return fp;
  const p = input.path;
  if (typeof p === 'string' && p.length > 0) return p;
  return null;
}

function grade(s: {
  readEditRatio: number;
  editCount: number;
  editsWithoutPriorRead: number;
  userInterrupts: number;
}): QualityGrade {
  // A pod that never edited anything isn't sketchy — it's either queued,
  // validating, or a read-only research run. Don't punish it.
  if (s.editCount === 0) return 'green';
  if (s.readEditRatio < 1 || s.editsWithoutPriorRead >= 3) return 'red';
  if (s.readEditRatio >= 3 && s.editsWithoutPriorRead === 0 && s.userInterrupts <= 1) {
    return 'green';
  }
  return 'yellow';
}
