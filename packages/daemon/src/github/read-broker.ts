import { createHash } from 'node:crypto';
import {
  type GitHubOperation,
  type GitHubOperationPolicy,
  type GitHubReadRequest,
  githubReadSchema,
} from '@autopod/shared';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import { authorizeGitHubOperation } from './access-policy.js';
import type { GitHubDiscovery, GitHubReadClient } from './discovery.js';

export interface GitHubDownloadClient extends GitHubReadClient {
  download(path: string): Promise<{ bytes: Buffer; mediaType: string }>;
}
interface ReadContext {
  policy: GitHubOperationPolicy;
  snapshotDigest: string;
  managed: boolean;
}
export function createGitHubReadBroker(deps: {
  client: GitHubDownloadClient;
  discovery: GitHubDiscovery;
  context(podId: string): Promise<ReadContext>;
  audit(input: {
    podId: string;
    repositoryId: string;
    resource: string;
    snapshotDigest: string;
    bytes: number;
  }): void;
}) {
  return {
    async read(podId: string, raw: unknown): Promise<unknown> {
      const request = githubReadSchema.parse(raw);
      const operation = readOperation(request);
      const initial = await deps.context(podId);
      if (initial.managed)
        configurationError(
          'Use the managed GitHub gateway and its existing protocol grants',
          'MANAGED_CAPABILITY_UNAVAILABLE',
          403,
        );
      const repository = await deps.discovery.repositoryById(request.repositoryId);
      authorizeGitHubOperation(initial.policy, operation, { repository });
      const base = `/repos/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}`;
      const page = 'page' in request ? `?page=${request.page}&per_page=${request.perPage}` : '';
      let path: string;
      let download = false;
      switch (request.resource) {
        case 'code.file':
          path = `${base}/contents/${request.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(request.ref)}`;
          break;
        case 'code.tree':
          path = `${base}/git/trees/${encodeURIComponent(request.ref)}`;
          break;
        case 'code.commit':
          path = `${base}/commits/${encodeURIComponent(request.ref)}`;
          break;
        case 'issues.list':
          path = `${base}/issues${page}&state=${request.state}`;
          break;
        case 'issues.get':
          path = `${base}/issues/${request.number}`;
          break;
        case 'issues.comments':
          path = `${base}/issues/${request.number}/comments${page}`;
          break;
        case 'prs.list':
          path = `${base}/pulls${page}&state=${request.state}`;
          break;
        case 'prs.get':
          path = `${base}/pulls/${request.number}`;
          break;
        case 'prs.files':
          path = `${base}/pulls/${request.number}/files${page}`;
          break;
        case 'prs.reviews':
          path = `${base}/pulls/${request.number}/reviews${page}`;
          break;
        case 'prs.comments':
          path = `${base}/issues/${request.number}/comments${page}`;
          break;
        case 'actions.workflows':
          path = `${base}/actions/workflows${page}`;
          break;
        case 'actions.runs':
          path = request.workflowId
            ? `${base}/actions/workflows/${request.workflowId}/runs${page}`
            : `${base}/actions/runs${page}`;
          break;
        case 'actions.run':
          path = `${base}/actions/runs/${request.runId}`;
          break;
        case 'actions.jobs':
          path = `${base}/actions/runs/${request.runId}/jobs${page}`;
          break;
        case 'actions.job':
          path = `${base}/actions/jobs/${request.jobId}`;
          break;
        case 'actions.jobLogs':
          path = `${base}/actions/jobs/${request.jobId}/logs`;
          download = true;
          break;
        case 'actions.runLogs':
          path = `${base}/actions/runs/${request.runId}/logs`;
          download = true;
          break;
        case 'actions.artifacts':
          path = request.runId
            ? `${base}/actions/runs/${request.runId}/artifacts${page}`
            : `${base}/actions/artifacts${page}`;
          break;
        case 'actions.artifact':
          path = `${base}/actions/artifacts/${request.artifactId}/zip`;
          download = true;
          break;
      }
      if (
        request.resource === 'issues.get' ||
        request.resource === 'issues.comments' ||
        request.resource === 'prs.comments'
      ) {
        const item = z
          .object({ number: z.number().int(), pull_request: z.unknown().optional() })
          .parse(await deps.client.get(`${base}/issues/${request.number}`));
        const isPr = item.pull_request !== null && item.pull_request !== undefined;
        if (item.number !== request.number || isPr !== (request.resource === 'prs.comments'))
          configurationError(
            'Issue and PR read permissions are separate',
            'GITHUB_ACCESS_DENIED',
            403,
          );
      }
      let data: unknown;
      if (download) {
        const result = await deps.client.download(path);
        data =
          request.resource === 'actions.jobLogs'
            ? {
                text: result.bytes.toString('utf8'),
                mediaType: 'text/plain',
                bytes: result.bytes.length,
              }
            : {
                base64: result.bytes.toString('base64'),
                mediaType: result.mediaType,
                sha256: createHash('sha256').update(result.bytes).digest('hex'),
                bytes: result.bytes.length,
              };
      } else {
        data = await deps.client.get(path);
        if (request.resource === 'issues.list') {
          // GitHub lists PRs through /issues. Do not silently grant prs.read through this endpoint.
          data = z
            .array(z.record(z.unknown()))
            .parse(data)
            .filter((item) => !item.pull_request);
        }
      }
      // Recheck identity and current revocation after asynchronous retrieval, before releasing content.
      const latestRepository = await deps.discovery.repositoryById(request.repositoryId);
      const latest = await deps.context(podId);
      if (
        latest.managed ||
        latest.snapshotDigest !== initial.snapshotDigest ||
        latestRepository.ownerId !== repository.ownerId ||
        latestRepository.ownerLogin !== repository.ownerLogin ||
        latestRepository.name !== repository.name
      )
        configurationError(
          'GitHub repository or pod authority changed during the read',
          'GITHUB_ACCESS_CHANGED',
          403,
        );
      authorizeGitHubOperation(latest.policy, operation, { repository: latestRepository });
      const bytes = Buffer.byteLength(JSON.stringify(data));
      deps.audit({
        podId,
        repositoryId: repository.id,
        resource: request.resource,
        snapshotDigest: initial.snapshotDigest,
        bytes,
      });
      return {
        resource: request.resource,
        repositoryId: repository.id,
        ...('page' in request ? { page: request.page, perPage: request.perPage } : {}),
        data,
      };
    },
  };
}
function readOperation(request: GitHubReadRequest): GitHubOperation {
  if (request.resource.startsWith('code.')) return 'code.read';
  if (request.resource.startsWith('issues.')) return 'issues.read';
  if (request.resource.startsWith('prs.')) return 'prs.read';
  return 'actions.read';
}
