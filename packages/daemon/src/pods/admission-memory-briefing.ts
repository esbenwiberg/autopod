import type { MemoryEntry, Pod } from '@autopod/shared';
import type { Logger } from 'pino';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileLlmClientResult } from '../providers/index.js';
import type { MemoryRepository } from './memory-repository.js';
import { prefilterMemories, selectRelevantMemories } from './memory-selector.js';
import type { MemoryUsageRepository } from './memory-usage-repository.js';
export function podMemoryScopeIds(pod: Pod): string[] {
  return Array.from(new Set([pod.id, ...(pod.dependsOnPodIds ?? [])]));
}

export function approvedMemoriesForPod(pod: Pod, memoryRepo: MemoryRepository): MemoryEntry[] {
  return [
    ...podMemoryScopeIds(pod).flatMap((podId) => memoryRepo.list('pod', podId, true)),
    ...(!pod.launchConfigDigest ? memoryRepo.list('profile', pod.profileName, true) : []),
    ...memoryRepo.list('global', null, true),
  ];
}

export async function selectMemoryBriefingForPod(opts: {
  pod: Pod;
  profile: PodExecutionSettings;
  memoryRepo: MemoryRepository;
  usageRepo?: MemoryUsageRepository;
  logger: Logger;
  createReviewerClient?: (
    profile: PodExecutionSettings,
    reviewerModelId: string,
    logger: Logger,
  ) => Promise<ProfileLlmClientResult>;
}): Promise<Awaited<ReturnType<typeof selectRelevantMemories>>> {
  const { pod, profile, memoryRepo, usageRepo, logger } = opts;
  if (pod.options.agentMode !== 'auto') {
    return { selected: [], unavailableReason: null };
  }

  const candidates = prefilterMemories({
    pod,
    memories: approvedMemoriesForPod(pod, memoryRepo),
  });
  if (candidates.length === 0) {
    return { selected: [], unavailableReason: null };
  }

  const reviewerModelId =
    profile.reviewerModel || profile.defaultModel || pod.model || 'claude-haiku-4-5';
  const createReviewerClient = opts.createReviewerClient ?? createProfileAnthropicClient;
  let reviewerClient: ProfileLlmClientResult | null = null;
  let reviewerUnavailableReason: string | undefined;
  try {
    reviewerClient = await createReviewerClient(profile, reviewerModelId, logger);
    if (!reviewerClient.ok) {
      reviewerUnavailableReason = reviewerClient.reason;
    }
  } catch (err) {
    reviewerUnavailableReason = 'reviewer_model_client_unavailable';
    logger.warn({ err, podId: pod.id }, 'Memory reviewer client unavailable — using fallback');
  }

  return selectRelevantMemories({
    pod,
    profile,
    deps: {
      memoryRepo,
      usageRepo,
      anthropicClient: reviewerClient?.ok ? reviewerClient.client : undefined,
      reviewerModel: reviewerClient?.ok ? reviewerClient.model : undefined,
      reviewerUnavailableReason,
      logger,
    },
  });
}
