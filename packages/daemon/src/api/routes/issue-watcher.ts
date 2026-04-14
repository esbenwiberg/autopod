import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { IssueWatcherRepository } from '../../issue-watcher/issue-watcher-repository.js';

export interface IssueWatcherRouteDeps {
  issueWatcherRepo: IssueWatcherRepository;
}

export function issueWatcherRoutes(app: FastifyInstance, deps: IssueWatcherRouteDeps): void {
  const { issueWatcherRepo } = deps;

  app.get('/issue-watcher', async (request) => {
    const query = request.query as {
      profile?: string;
      status?: string;
    };
    return issueWatcherRepo.list({
      profileName: query.profile,
      status: query.status as 'in_progress' | 'done' | 'failed' | undefined,
    });
  });

  app.get('/issue-watcher/:id', async (request) => {
    const { id } = request.params as { id: string };
    const issues = issueWatcherRepo.list();
    const issue = issues.find((i) => i.id === Number(id));
    if (!issue) {
      throw new AutopodError('Watched issue not found', 'NOT_FOUND', 404);
    }
    return issue;
  });
}
