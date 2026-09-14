import {
  type GitHubMutation,
  type GitHubOperationPolicy,
  type GitHubOperationResource,
  githubMutationSchema,
} from '@autopod/shared';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import { authorizeGitHubOperation } from './access-policy.js';
import type { GitHubDiscovery, GitHubReadClient } from './discovery.js';
import type {
  GitHubOperationReceipt,
  GitHubOperationRecord,
  createGitHubOperationLedger,
} from './operation-ledger.js';

export interface GitHubMutationClient extends GitHubReadClient {
  mutate(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<{ status: number; data: unknown }>;
}
interface BrokerContext {
  snapshotDigest: string;
  policy: GitHubOperationPolicy;
  managed: boolean;
}
interface Dependencies {
  client: GitHubMutationClient;
  discovery: GitHubDiscovery;
  ledger: ReturnType<typeof createGitHubOperationLedger>;
  /** Resolves the pod token's identity and current ceilings. No authority comes from request params. */
  context(podId: string): Promise<BrokerContext>;
}
const numeric = z
  .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)])
  .transform(String);
const workflowSchema = z.object({
  id: numeric,
  path: z.string().regex(/^\.github\/workflows\/[^/]+\.ya?ml$/),
});

/** Precise agent effects only. Push, branch publication, PR mutation and merge have no handler. */
export function createGitHubMutationBroker(deps: Dependencies) {
  async function resource(request: GitHubMutation): Promise<GitHubOperationResource> {
    const repository = await deps.discovery.repositoryById(request.repositoryId);
    const base = `/repos/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}`;
    const resolved: GitHubOperationResource = { repository };
    if ('issueNumber' in request) {
      const issue = z
        .object({ number: z.number().int(), pull_request: z.unknown().optional() })
        .parse(await deps.client.get(`${base}/issues/${request.issueNumber}`));
      if (issue.number !== request.issueNumber)
        configurationError('GitHub issue identity mismatch');
      resolved.issue = {
        number: issue.number,
        isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
      };
    }
    if (request.operation === 'workflows.dispatch') {
      const workflow = workflowSchema.parse(
        await deps.client.get(`${base}/actions/workflows/${request.workflowId}`),
      );
      if (workflow.id !== request.workflowId)
        configurationError('GitHub workflow identity mismatch');
      const branch = z
        .object({
          ref: z.string(),
          object: z.object({ type: z.literal('commit'), sha: z.string().regex(/^[a-f0-9]{40}$/) }),
        })
        .parse(
          await deps.client.get(`${base}/git/ref/heads/${encodeURIComponent(request.branch)}`),
        );
      if (branch.ref !== `refs/heads/${request.branch}`)
        configurationError('GitHub branch identity mismatch');
      resolved.workflow = {
        repositoryId: repository.id,
        id: workflow.id,
        path: workflow.path,
        branch: request.branch,
      };
    }
    if ('runId' in request) {
      const run = z
        .object({
          id: z.number().int(),
          workflow_id: numeric,
          head_branch: z.string().nullable(),
          repository: z.object({ id: numeric }),
          head_repository: z.object({ id: numeric }).nullable(),
        })
        .parse(await deps.client.get(`${base}/actions/runs/${request.runId}`));
      if (
        run.id !== request.runId ||
        run.repository.id !== repository.id ||
        run.head_repository?.id !== repository.id
      )
        configurationError(
          'GitHub run does not have a trusted branch in the selected repository',
          'GITHUB_RUN_IDENTITY_MISMATCH',
        );
      const workflow = workflowSchema.parse(
        await deps.client.get(`${base}/actions/workflows/${run.workflow_id}`),
      );
      if (workflow.id !== run.workflow_id) configurationError('GitHub workflow identity mismatch');
      resolved.workflow = {
        repositoryId: repository.id,
        id: workflow.id,
        path: workflow.path,
        branch: run.head_branch,
      };
    }
    return resolved;
  }
  function effect(
    request: GitHubMutation,
    resolved: GitHubOperationResource,
  ): { method: 'POST' | 'PATCH' | 'PUT'; path: string; body: unknown } {
    const base = `/repos/${encodeURIComponent(resolved.repository.ownerLogin)}/${encodeURIComponent(resolved.repository.name)}`;
    switch (request.operation) {
      case 'issues.create':
        return {
          method: 'POST',
          path: `${base}/issues`,
          body: { title: request.title, body: request.body },
        };
      case 'issues.edit':
        return {
          method: 'PATCH',
          path: `${base}/issues/${request.issueNumber}`,
          body: { title: request.title, body: request.body },
        };
      case 'issues.close':
        return {
          method: 'PATCH',
          path: `${base}/issues/${request.issueNumber}`,
          body: { state: 'closed' },
        };
      case 'issues.labels':
        return {
          method: 'PUT',
          path: `${base}/issues/${request.issueNumber}/labels`,
          body: { labels: request.labels },
        };
      case 'issues.comment':
      case 'prs.comment':
        return {
          method: 'POST',
          path: `${base}/issues/${request.issueNumber}/comments`,
          body: { body: request.body },
        };
      case 'workflows.dispatch':
        return {
          method: 'POST',
          path: `${base}/actions/workflows/${request.workflowId}/dispatches`,
          body: { ref: request.branch, inputs: request.inputs, return_run_details: true },
        };
      case 'runs.rerun':
        return { method: 'POST', path: `${base}/actions/runs/${request.runId}/rerun`, body: {} };
      case 'runs.cancel':
        return { method: 'POST', path: `${base}/actions/runs/${request.runId}/cancel`, body: {} };
    }
  }
  async function checkedContext(podId: string): Promise<BrokerContext> {
    const context = await deps.context(podId);
    if (context.managed)
      configurationError(
        'Managed grants do not enable these agent mutations',
        'MANAGED_CAPABILITY_UNAVAILABLE',
        403,
      );
    return context;
  }
  return {
    async execute(podId: string, raw: unknown): Promise<GitHubOperationRecord> {
      const request = githubMutationSchema.parse(raw);
      const initial = await checkedContext(podId);
      const firstResource = await resource(request);
      const initialDecision = authorizeGitHubOperation(
        initial.policy,
        request.operation,
        firstResource,
      );
      const reserved = deps.ledger.reserve({
        podId,
        operationKey: request.operationKey,
        operation: request.operation,
        repositoryId: request.repositoryId,
        snapshotDigest: initial.snapshotDigest,
        decision: initialDecision,
        parameters: request,
      });
      if (reserved.state !== 'ready') return reserved;
      // Approval/retry delays never preserve an obsolete grant or caller-supplied run metadata.
      const currentResource = await resource(request);
      const current = await checkedContext(podId);
      if (current.snapshotDigest !== initial.snapshotDigest)
        configurationError('Pod launch identity changed', 'CONFIG_CHANGED', 409);
      const decision = authorizeGitHubOperation(current.policy, request.operation, currentResource);
      const write = effect(request, currentResource);
      if (deps.ledger.claim(podId, request.operationKey, decision)) {
        let outcome:
          | { state: 'succeeded'; receipt: GitHubOperationReceipt }
          | { state: 'uncertain'; code: string };
        try {
          const response = await deps.client.mutate(write.method, write.path, write.body);
          if (response.status < 200 || response.status >= 300) {
            // Conservatively require attention when the remote may have applied the write.
            outcome = {
              state: 'uncertain',
              code: 'PROVIDER_WRITE_NOT_CONFIRMED',
            };
          } else {
            const fields = z
              .object({
                id: numeric.optional(),
                workflow_run_id: numeric.optional(),
                html_url: z.string().optional(),
              })
              .passthrough()
              .safeParse(response.data ?? {});
            const receipt: GitHubOperationReceipt = { accepted: true };
            if (fields.success) {
              receipt.providerId = fields.data.workflow_run_id ?? fields.data.id;
              if (fields.data.html_url) {
                const url = new URL(fields.data.html_url);
                if (
                  url.origin === 'https://github.com' &&
                  !url.username &&
                  !url.password &&
                  !url.search &&
                  !url.hash
                )
                  receipt.url = url.href;
              }
            }
            outcome = { state: 'succeeded', receipt };
          }
        } catch {
          // A dropped connection is not evidence that a workflow/comment was not created.
          outcome = {
            state: 'uncertain',
            code: 'PROVIDER_RESPONSE_LOST',
          };
        }
        // Storage failure is not a second provider outcome; startup recovery handles an unsettled send.
        deps.ledger.settle(podId, request.operationKey, outcome);
      }
      const record = deps.ledger.get(podId, request.operationKey);
      if (!record)
        configurationError('GitHub operation record is missing', 'GITHUB_LEDGER_ERROR', 500);
      return record;
    },
  };
}
