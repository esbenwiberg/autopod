import type { MemoryCandidate, MemoryEntry, MemoryKind, MemorySourceEvidence, Pod, QualitySignals } from '@autopod/shared';
import { generateId, processContent } from '@autopod/shared';
import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';

export const LESSON_POTENTIAL_THRESHOLD = 0.2;

const DEFAULT_REVIEWER_MODEL = 'claude-haiku-4-5';
const MAX_EXCERPT_CHARS = 400;
const API_TIMEOUT_MS = 20_000;
const VALID_KINDS: MemoryKind[] = [
  'convention',
  'gotcha',
  'workflow',
  'dependency',
  'review_feedback',
  'other',
];

export interface LessonPotentialResult {
  score: number;
  signals: string[];
}

/**
 * Deterministic score [0, 1] deciding whether a pod outcome is worth sending
 * to the reviewer model for candidate extraction.
 *
 * High-priority signals (validation failures, PR fixes, rework, tells/churn,
 * escalations) drive the score up fast. Ordinary green pods stay below the
 * threshold and are skipped without an LLM call.
 */
export function computeLessonPotential(pod: Pod, signals: QualitySignals): LessonPotentialResult {
  let score = 0;
  const found: string[] = [];

  if (signals.validationPassed === false) {
    score += 0.4;
    found.push('validation_failed');
  }
  if ((pod.prFixAttempts ?? 0) > 0) {
    score += 0.3;
    found.push(`pr_fix_attempts:${pod.prFixAttempts}`);
  }
  if (pod.reworkCount > 0) {
    score += 0.25;
    found.push(`rework:${pod.reworkCount}`);
  }
  if (signals.tellsCount > 0) {
    score += Math.min(0.3, signals.tellsCount * 0.15);
    found.push(`tells:${signals.tellsCount}`);
  }
  if (signals.editChurnCount >= 2) {
    score += 0.2;
    found.push(`edit_churn:${signals.editChurnCount}`);
  }
  if (signals.userInterrupts >= 2) {
    score += 0.15;
    found.push(`user_interrupts:${signals.userInterrupts}`);
  }
  if (pod.status === 'killed') {
    score += 0.2;
    found.push('killed');
  }
  if (signals.score !== null && signals.score < 40) {
    score += 0.2;
    found.push(`low_quality_score:${signals.score}`);
  }
  if ((pod.costUsd ?? 0) > 1) {
    score += 0.1;
    found.push(`high_cost:${pod.costUsd?.toFixed(2) ?? '?'}`);
  }

  // Medium priority: unusually successful pods are worth a look too.
  // Only fires when no pain signals triggered (score === 0).
  if (
    score === 0 &&
    signals.score !== null &&
    signals.score >= 80 &&
    signals.userInterrupts === 0 &&
    signals.tellsCount === 0
  ) {
    score += 0.1;
    found.push(`high_quality_success:${signals.score}`);
  }

  return { score: Math.min(1, score), signals: found };
}

export interface ExtractionEvidence {
  taskSummary?: string;
  how?: string;
  blockerMessages: string[];
  validationErrors?: string;
}

export type ExtractionResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'no_candidate'; reason: string }
  | { kind: 'candidate'; input: Omit<MemoryCandidate, 'status' | 'createdAt' | 'updatedAt'> };

interface ReviewerResponseJson {
  create: boolean;
  path?: string;
  content?: string;
  rationale?: string;
  kind?: string;
  tags?: unknown[];
  appliesWhen?: string | null;
  avoidWhen?: string | null;
  confidence?: number;
  impactSummary?: string;
  updateTargetPath?: string | null;
}

/** Model name used when neither profile nor pod provides a reviewer model. */
export { DEFAULT_REVIEWER_MODEL };

const REVIEWER_SYSTEM_PROMPT =
  'You extract durable lessons from AI coding pod outcomes to improve future pods on the same profile.\n' +
  'Return ONLY valid JSON — no markdown fence, no explanation:\n' +
  '{\n' +
  '  "create": true or false,\n' +
  '  "path": "/kind/short-slug.md",\n' +
  '  "content": "One to three sentences. The lesson itself — what to do or avoid.",\n' +
  '  "rationale": "One sentence. Why this matters for future pods.",\n' +
  '  "kind": "convention" | "gotcha" | "workflow" | "dependency" | "review_feedback" | "other",\n' +
  '  "tags": ["tag1"],\n' +
  '  "appliesWhen": "Condition string or null",\n' +
  '  "avoidWhen": "Condition string or null",\n' +
  '  "confidence": 0.0 to 1.0,\n' +
  '  "impactSummary": "One sentence. What pain this memory prevents.",\n' +
  '  "updateTargetPath": "/existing/path.md or null"\n' +
  '}\n\n' +
  'Set "create": false if no durable lesson is worth extracting (ordinary green pod, no surprises).\n' +
  'Set "updateTargetPath" to an existing memory path if updating is more appropriate than creating.\n' +
  'Keep content under 400 characters. Path: kebab-case under /conventions/, /gotchas/, /workflow/, /dependencies/, or /review-feedback/.';

function sanitize(text: string): string {
  return processContent(text, { sanitization: { preset: 'standard' } }).text;
}

/**
 * Call the reviewer model to extract a durable profile memory candidate from
 * a pod's outcome evidence. Returns `skipped` on LLM/parse failure (never
 * throws), `no_candidate` when the model decides there is nothing to record,
 * and `candidate` with a ready-to-insert input otherwise.
 */
export async function extractCandidate(opts: {
  pod: Pod;
  lessonSignals: string[];
  evidence: ExtractionEvidence;
  existingMemories: MemoryEntry[];
  anthropicClient: Anthropic;
  reviewerModel: string;
  logger: Logger;
}): Promise<ExtractionResult> {
  const { pod, lessonSignals, evidence, existingMemories, anthropicClient, reviewerModel, logger } =
    opts;

  const sanitizedTask = sanitize(pod.task.slice(0, 500));
  const sanitizedSummary = evidence.taskSummary
    ? sanitize(evidence.taskSummary.slice(0, MAX_EXCERPT_CHARS))
    : null;
  const sanitizedHow = evidence.how ? sanitize(evidence.how.slice(0, MAX_EXCERPT_CHARS)) : null;
  const sanitizedBlockers = evidence.blockerMessages
    .slice(0, 3)
    .map((m) => sanitize(m.slice(0, 200)));
  const sanitizedValidation = evidence.validationErrors
    ? sanitize(evidence.validationErrors.slice(0, 300))
    : null;
  const existingPaths = existingMemories.map((m) => m.path).join('\n');

  const userParts: string[] = [
    `Profile: ${pod.profileName}`,
    `Task: ${sanitizedTask}`,
    `Final status: ${pod.status}`,
    `Quality signals: ${lessonSignals.join(', ')}`,
  ];
  if (sanitizedSummary) userParts.push(`Task summary: ${sanitizedSummary}`);
  if (sanitizedHow) userParts.push(`How it was done: ${sanitizedHow}`);
  if (sanitizedBlockers.length > 0) userParts.push(`Blockers: ${sanitizedBlockers.join(' | ')}`);
  if (sanitizedValidation) userParts.push(`Validation errors: ${sanitizedValidation}`);
  if (existingPaths) userParts.push(`Existing memory paths (update if overlapping):\n${existingPaths}`);

  const userMessage = userParts.join('\n');

  let rawResponse: string;
  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('reviewer_model_timeout')), API_TIMEOUT_MS);
    });
    const result = await Promise.race<Anthropic.Message>([
      anthropicClient.messages.create({
        model: reviewerModel,
        max_tokens: 512,
        system: REVIEWER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
      timeoutPromise,
    ]);
    clearTimeout(timeoutId);
    const textBlock = result.content.find(
      (b): b is { type: 'text'; text: string } => b.type === 'text',
    );
    rawResponse = textBlock?.text ?? '';
  } catch (err) {
    const reason = `reviewer_model_failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ podId: pod.id, reason }, 'Reviewer model call failed for memory extraction');
    return { kind: 'skipped', reason };
  }

  let parsed: ReviewerResponseJson;
  try {
    const jsonText = rawResponse
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
    parsed = JSON.parse(jsonText) as ReviewerResponseJson;
  } catch (err) {
    const reason = `json_parse_failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ podId: pod.id, reason, rawResponse }, 'Failed to parse reviewer model JSON');
    return { kind: 'skipped', reason };
  }

  if (!parsed.create) {
    return { kind: 'no_candidate', reason: 'reviewer_decided_no_lesson' };
  }

  if (!parsed.path || !parsed.content || !parsed.rationale || !parsed.kind || !parsed.impactSummary) {
    return { kind: 'skipped', reason: 'output_invalid: missing required fields' };
  }

  const kind = parsed.kind as MemoryKind;
  if (!VALID_KINDS.includes(kind)) {
    return { kind: 'skipped', reason: `output_invalid: unknown kind "${parsed.kind}"` };
  }

  // Sanitize all LLM-produced text before storing.
  const content = sanitize(parsed.content);
  const rationale = sanitize(parsed.rationale);
  const impactSummary = sanitize(parsed.impactSummary);

  // Determine create vs update by matching the suggested path to an existing entry.
  let action: 'create' | 'update' = 'create';
  let targetMemoryId: string | null = null;
  if (parsed.updateTargetPath) {
    const target = existingMemories.find((m) => m.path === parsed.updateTargetPath);
    if (target) {
      action = 'update';
      targetMemoryId = target.id;
    }
  }

  const now = new Date().toISOString();
  const severity: MemorySourceEvidence['severity'] =
    lessonSignals.some((s) => s.startsWith('validation_failed') || s.startsWith('pr_fix'))
      ? 'high'
      : lessonSignals.length > 2
        ? 'medium'
        : 'low';

  const sourceEvidence: MemorySourceEvidence[] = [
    {
      podId: pod.id,
      signal: lessonSignals.join(', '),
      excerpt: sanitize((sanitizedSummary ?? sanitizedTask).slice(0, MAX_EXCERPT_CHARS)),
      severity,
      createdAt: now,
    },
  ];

  return {
    kind: 'candidate',
    input: {
      id: generateId(8),
      action,
      targetMemoryId,
      scope: 'profile',
      scopeId: pod.profileName,
      path: parsed.path,
      content,
      rationale,
      kind,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      appliesWhen: parsed.appliesWhen ?? null,
      avoidWhen: parsed.avoidWhen ?? null,
      confidence:
        typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      sourceEvidence,
      impactSummary,
      createdByPodId: pod.id,
      fallbackReason: null,
    },
  };
}
