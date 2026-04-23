import type {
  AgentActivityEvent,
  AgentFileChangeEvent,
  AgentToolUseEvent,
  QualityGrade,
  QualitySignals,
} from '@autopod/shared';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventRepository } from './event-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { QualityScoreRepository } from './quality-score-repository.js';

export interface QualitySignalsDeps {
  podRepo: PodRepository;
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  /** Optional — when wired, pulls the persisted numeric score + model tag. */
  qualityScoreRepo?: QualityScoreRepository;
}

/**
 * Computes per-pod behavioural signals on demand from the event log + pod
 * state. No persistence; cheap enough to call per-request.
 *
 * The score is deliberately a traffic light rather than a number — without
 * real historical data to anchor thresholds on, any scalar we pick is vibes.
 * A future `pod_quality_scores` table (see plan Phase 3) will carry the
 * numeric score alongside these inputs.
 */
export function computeQualitySignals(podId: string, deps: QualitySignalsDeps): QualitySignals {
  // Throws PodNotFoundError if the id is unknown — let routes/callers surface it.
  const pod = deps.podRepo.getOrThrow(podId);
  const events = deps.eventRepo.getForSession(podId);

  let readCount = 0;
  let editCount = 0;
  let editsWithoutPriorRead = 0;
  const readPaths = new Set<string>();

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
    }
  }

  const askHumanCount = deps.escalationRepo.countBySessionAndType(podId, 'ask_human');
  const killed = pod.status === 'killed' ? 1 : 0;
  const userInterrupts = askHumanCount + killed;

  const readEditRatio = editCount > 0 ? readCount / editCount : readCount;

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
