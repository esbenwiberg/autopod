import type {
  GitHubOperation,
  GitHubOperationPolicy,
  GitHubOperationResource,
  GitHubPolicyDecision,
  ResolvedGitHubRule,
} from '@autopod/shared';
import { configurationError } from '../configuration/configuration-store.js';

const workflowEffects = new Set<GitHubOperation>([
  'workflows.dispatch',
  'runs.rerun',
  'runs.cancel',
]);
const issueEffects = new Set<GitHubOperation>([
  'issues.edit',
  'issues.close',
  'issues.labels',
  'issues.comment',
]);

function matches(
  bound: ResolvedGitHubRule,
  operation: GitHubOperation,
  resource: GitHubOperationResource,
): boolean {
  const { rule, repositoryIds } = bound;
  if (!repositoryIds.includes(resource.repository.id) || !rule.operations.includes(operation))
    return false;
  if (
    rule.repositories.mode === 'owner' &&
    rule.repositories.ownerId !== resource.repository.ownerId
  )
    return false;
  if (issueEffects.has(operation) && (!resource.issue || resource.issue.isPullRequest))
    return false;
  if (operation === 'prs.comment' && !resource.issue?.isPullRequest) return false;
  if (workflowEffects.has(operation)) {
    const workflow = resource.workflow;
    if (!workflow || !workflow.branch || workflow.repositoryId !== resource.repository.id)
      return false;
    if (rule.branches.mode === 'selected' && !rule.branches.names.includes(workflow.branch))
      return false;
    if (
      rule.workflows.mode === 'selected' &&
      !rule.workflows.files.some(
        (f) =>
          f.repositoryId === resource.repository.id &&
          f.path === workflow.path &&
          (!f.workflowId || f.workflowId === workflow.id) &&
          bound.workflowBindings.some(
            (b) =>
              b.repositoryId === f.repositoryId &&
              b.path === f.path &&
              b.workflowId === workflow.id,
          ),
      )
    )
      return false;
  }
  return true;
}

/** Match complete rules separately. Revocation can narrow a snapshot, never enlarge it. */
export function authorizeGitHubOperation(
  policy: GitHubOperationPolicy,
  operation: GitHubOperation,
  resource: GitHubOperationResource,
): GitHubPolicyDecision {
  const saved = policy.snapshot.find((rule) => matches(rule, operation, resource));
  const current = policy.currentCeiling.find((rule) => matches(rule, operation, resource));
  if (!saved || !current)
    configurationError(
      'GitHub operation is outside this pod’s allowed access',
      'GITHUB_ACCESS_DENIED',
      403,
    );
  return { snapshotRuleId: saved.rule.id, ceilingRuleId: current.rule.id };
}
