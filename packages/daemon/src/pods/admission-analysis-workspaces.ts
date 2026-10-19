import type { HistoryQuery, Pod } from '@autopod/shared';
import type {
  AdmissionAnalysisLiveDependencies,
  AdmissionCreateCalls,
} from './admission-contracts.js';
import type { PodCreator } from './workspace-contracts.js';
export function createAdmissionAnalysisWorkspaces(deps: AdmissionAnalysisLiveDependencies) {
  function createHistoryWorkspace(
    this: AdmissionCreateCalls,
    profileName: string,
    userId: string,
    historyQuery: HistoryQuery,
    creator?: PodCreator,
  ): Pod {
    // Encode query params into the task field with a [history] prefix
    const queryJson = JSON.stringify(historyQuery);
    const task = `[history] History analysis workspace | ${queryJson}`;
    return this.createSession(
      {
        profileName,
        task,
        outputMode: 'workspace',
        skipValidation: true,
      },
      userId,
      creator,
    );
  }

  function createMemoryWorkspace(
    this: AdmissionCreateCalls,
    profileName: string,
    userId: string,
    creator?: PodCreator,
  ): Pod {
    const globalMems = deps.memoryRepo?.listByScope('global', true) ?? [];
    const profileMems = deps.memoryRepo?.list('profile', profileName, true) ?? [];
    const all = [...globalMems, ...profileMems];

    const formatted = all
      .map((m) => `### ${m.path}\n${m.rationale ? `Why: ${m.rationale}\n\n` : ''}${m.content}`)
      .join('\n\n---\n\n');

    const task = [
      `[memory-analysis] Review ${all.length} memories and draft a fix plan`,
      '',
      'You have been given a snapshot of memories from this project.',
      'Your job:',
      '1. Identify gotchas, bugs, and missing config that can be fixed in the repo',
      '2. For each fixable item, draft the specific change or PR needed',
      '3. Prioritize and optionally implement the most critical fixes',
      '',
      '## Memories',
      '',
      formatted,
    ].join('\n');

    return this.createSession(
      {
        profileName,
        task,
        outputMode: 'workspace',
        skipValidation: true,
      },
      userId,
      creator,
    );
  }
  return { createHistoryWorkspace, createMemoryWorkspace };
}
