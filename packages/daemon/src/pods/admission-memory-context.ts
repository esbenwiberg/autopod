import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type {
  AdmissionLaunchMemoryContext,
  AdmissionMemoryCaptured,
  AdmissionMemoryLiveDependencies,
} from './admission-contracts.js';
import { projectMemoryScope } from './project-memory-scope.js';
export function createAdmissionMemoryContext(
  deps: AdmissionMemoryLiveDependencies,
  captured: AdmissionMemoryCaptured,
) {
  const { getReviewerExecutor, getEffectiveReviewerConfig } = captured;
  function getProjectMemoryScope(pod: Pod) {
    return projectMemoryScope(pod, deps.launchConfiguration?.read(pod.id));
  }

  function getLaunchMemoryContext(pod: Pod): AdmissionLaunchMemoryContext {
    const executor = getReviewerExecutor(pod, 'memory');
    if (!executor)
      throw new AutopodError(
        'Launch memory requires composable configuration',
        'CONFIG_SNAPSHOT_UNAVAILABLE',
        503,
      );
    const profile = getEffectiveReviewerConfig(pod).profile;
    return {
      profile,
      projectScope: projectMemoryScope(pod, deps.launchConfiguration?.read(pod.id)),
      reviewer: {
        model: profile.reviewerModel ?? profile.defaultModel ?? pod.model,
        async generateText({ systemPrompt, userMessage }) {
          return (await executor({ prompt: `${systemPrompt}\n\n${userMessage}`, timeout: 20_000 }))
            .stdout;
        },
      },
    };
  }
  return { getProjectMemoryScope, getLaunchMemoryContext };
}
