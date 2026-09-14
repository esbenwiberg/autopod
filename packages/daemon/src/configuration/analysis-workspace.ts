import type { EffectiveLaunchConfig } from '@autopod/shared';
import { configurationError } from './configuration-store.js';

export function assertAnalysisWorkspace(config: EffectiveLaunchConfig): void {
  const analysis = config.work.analysis;
  if (!analysis) return;
  if (config.workflow.agentMode !== 'interactive' || config.intent !== 'task')
    configurationError(
      'Analysis workspaces require an interactive Task workflow',
      'ANALYSIS_WORKFLOW_REQUIRED',
    );
  if (
    (!config.repository && analysis.kind === 'memory') ||
    (!config.repository && analysis.kind === 'history' && analysis.scope === 'repository')
  )
    configurationError('Select a repository for project analysis', 'ANALYSIS_REPOSITORY_REQUIRED');
}
