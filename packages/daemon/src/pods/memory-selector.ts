import type { MemoryEntry, Pod, Profile } from '@autopod/shared';
import { generateId, processContent } from '@autopod/shared';
import type { Logger } from 'pino';
import type { MemoryReviewer } from '../providers/memory-reviewer.js';
import type { MemoryRepository } from './memory-repository.js';
import type { MemoryUsageRepository } from './memory-usage-repository.js';

export const MAX_RELEVANT_MEMORY_ENTRIES = 5;
const PREFILTER_LIMIT = 20;
const API_TIMEOUT_MS = 20_000;

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'you',
  'are',
  'but',
  'not',
  'when',
  'where',
  'what',
  'why',
  'how',
  'all',
  'old',
  'new',
  'task',
  'pod',
]);

export interface RelevantMemory {
  memory: MemoryEntry;
  relevanceReason: string;
}

export interface MemorySelectionResult {
  selected: RelevantMemory[];
  unavailableReason: string | null;
}

export interface MemorySelectorDeps {
  memoryRepo: MemoryRepository;
  usageRepo?: MemoryUsageRepository;
  reviewer?: MemoryReviewer;
  reviewerModel?: string;
  reviewerUnavailableReason?: string;
  logger: Logger;
}

export async function selectRelevantMemories(opts: {
  pod: Pod;
  profile: Profile;
  deps: MemorySelectorDeps;
}): Promise<MemorySelectionResult> {
  const { pod, deps } = opts;

  if (pod.options.agentMode !== 'auto') {
    return { selected: [], unavailableReason: null };
  }

  const candidates = prefilterMemories({
    pod,
    memories: [
      ...podMemoryScopeIds(pod).flatMap((podId) => deps.memoryRepo.list('pod', podId, true)),
      ...deps.memoryRepo.list('profile', pod.profileName, true),
      ...deps.memoryRepo.list('global', null, true),
    ],
  });

  if (candidates.length === 0) {
    return { selected: [], unavailableReason: null };
  }

  if (!deps.reviewer) {
    const reason = deps.reviewerUnavailableReason ?? 'reviewer_model_unavailable';
    deps.logger.warn({ podId: pod.id, reason }, 'Memory ranking unavailable');
    return fallbackSelection(pod, deps.usageRepo, candidates, reason);
  }

  const ranked = await rankWithReviewer({
    pod,
    candidates,
    reviewer: deps.reviewer,
    logger: deps.logger,
  });

  if (ranked.kind === 'failed') {
    return fallbackSelection(pod, deps.usageRepo, candidates, ranked.reason);
  }

  for (const entry of ranked.selected) {
    recordUsage(deps.usageRepo, pod.id, entry.memory.id, 'selected', entry.relevanceReason);
    recordUsage(deps.usageRepo, pod.id, entry.memory.id, 'injected', entry.relevanceReason);
  }

  return { selected: ranked.selected, unavailableReason: null };
}

export function prefilterMemories(opts: { pod: Pod; memories: MemoryEntry[] }): MemoryEntry[] {
  const taskTerms = termsForPod(opts.pod);
  const scored = opts.memories
    .map((memory) => ({ memory, score: scoreMemory(memory, taskTerms) }))
    .filter(({ memory, score }) => score > 0 && (memory.scope !== 'global' || score >= 2))
    .sort((a, b) => {
      const scopeDiff = scopeRank(a.memory.scope) - scopeRank(b.memory.scope);
      if (scopeDiff !== 0) return scopeDiff;
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return b.memory.updatedAt.localeCompare(a.memory.updatedAt);
    });

  return scored.slice(0, PREFILTER_LIMIT).map(({ memory }) => memory);
}

function termsForPod(pod: Pod): Set<string> {
  return tokenize(
    [
      pod.task,
      pod.seriesDescription ?? '',
      pod.seriesDesign ?? '',
      pod.contract?.title ?? '',
      pod.touches?.join(' ') ?? '',
    ].join(' '),
  );
}

function podMemoryScopeIds(pod: Pod): string[] {
  return Array.from(new Set([pod.id, ...(pod.dependsOnPodIds ?? [])]));
}

function scoreMemory(memory: MemoryEntry, taskTerms: Set<string>): number {
  const haystackTerms = tokenize(
    [
      memory.path,
      memory.content,
      memory.rationale ?? '',
      memory.kind ?? '',
      memory.tags.join(' '),
      memory.appliesWhen ?? '',
      memory.impactSummary ?? '',
    ].join(' '),
  );

  let score = 0;
  for (const term of taskTerms) {
    if (haystackTerms.has(term)) score += 1;
  }
  if (memory.scope === 'pod') score += 0.25;
  if (memory.scope === 'profile') score += 0.1;
  return score;
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

async function rankWithReviewer(opts: {
  pod: Pod;
  candidates: MemoryEntry[];
  reviewer: MemoryReviewer;
  logger: Logger;
}): Promise<{ kind: 'ranked'; selected: RelevantMemory[] } | { kind: 'failed'; reason: string }> {
  const { pod, candidates, reviewer, logger } = opts;
  const memoryById = new Map(candidates.map((memory) => [memory.id, memory]));
  const prompt = buildRankingPrompt(pod, candidates);

  let rawResponse = '';
  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('reviewer_model_timeout')), API_TIMEOUT_MS);
    });
    rawResponse = await Promise.race<string>([
      reviewer.generateText({
        maxTokens: 1024,
        systemPrompt:
          'Rank approved Autopod memories for immediate relevance to the next coding pod. ' +
          'Return ONLY JSON: {"selected":[{"id":"memory-id","reason":"why this matters now"}]}. ' +
          'Select at most five. Include global memories only when strongly relevant. Do not invent IDs.',
        userMessage: prompt,
      }),
      timeoutPromise,
    ]);
    clearTimeout(timeoutId);
  } catch (err) {
    const reason = `reviewer_model_failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ podId: pod.id, reason }, 'Reviewer model failed to rank memories');
    return { kind: 'failed', reason };
  }

  try {
    const parsed = JSON.parse(stripJsonFence(rawResponse)) as {
      selected?: Array<{ id?: string; reason?: string }>;
    };
    const selected: RelevantMemory[] = [];
    const seen = new Set<string>();
    for (const item of parsed.selected ?? []) {
      if (!item.id || seen.has(item.id)) continue;
      const memory = memoryById.get(item.id);
      if (!memory) continue;
      seen.add(item.id);
      selected.push({
        memory,
        relevanceReason: sanitizeReason(item.reason || 'Reviewer ranked this memory as relevant.'),
      });
      if (selected.length >= MAX_RELEVANT_MEMORY_ENTRIES) break;
    }
    return { kind: 'ranked', selected };
  } catch (err) {
    const reason = `json_parse_failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ podId: pod.id, reason, rawResponse }, 'Failed to parse memory ranking JSON');
    return { kind: 'failed', reason };
  }
}

function buildRankingPrompt(pod: Pod, memories: MemoryEntry[]): string {
  const task = sanitizeReason(pod.task.slice(0, 1200));
  const entries = memories.map((memory) => ({
    id: memory.id,
    scope: memory.scope,
    path: memory.path,
    content: memory.content.slice(0, 1000),
    rationale: memory.rationale,
    appliesWhen: memory.appliesWhen,
    avoidWhen: memory.avoidWhen,
    tags: memory.tags,
  }));

  return JSON.stringify({
    pod: {
      id: pod.id,
      profile: pod.profileName,
      task,
      touches: pod.touches ?? [],
    },
    candidateMemories: entries,
  });
}

function fallbackSelection(
  pod: Pod,
  usageRepo: MemoryUsageRepository | undefined,
  candidates: MemoryEntry[],
  reason: string,
): MemorySelectionResult {
  const selected = candidates.slice(0, MAX_RELEVANT_MEMORY_ENTRIES).map((memory) => ({
    memory,
    relevanceReason: `Reviewer ranking unavailable (${reason}); selected by deterministic keyword prefilter.`,
  }));

  for (const entry of selected) {
    recordUsage(usageRepo, pod.id, entry.memory.id, 'selected', entry.relevanceReason);
    recordUsage(usageRepo, pod.id, entry.memory.id, 'injected', entry.relevanceReason);
  }

  return { selected, unavailableReason: reason };
}

function recordUsage(
  usageRepo: MemoryUsageRepository | undefined,
  podId: string,
  memoryId: string,
  kind: 'selected' | 'injected',
  relevanceReason: string,
): void {
  usageRepo?.record({
    id: generateId(8),
    memoryId,
    podId,
    kind,
    outcome: null,
    reason: null,
    relevanceReason,
  });
}

function scopeRank(scope: MemoryEntry['scope']): number {
  if (scope === 'pod') return 0;
  if (scope === 'profile') return 1;
  return 2;
}

function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function sanitizeReason(text: string): string {
  return processContent(text, { sanitization: { preset: 'standard' } }).text.trim();
}
