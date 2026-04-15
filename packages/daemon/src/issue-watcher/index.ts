export {
  createIssueWatcherRepository,
  type IssueWatcherRepository,
} from './issue-watcher-repository.js';
export {
  createIssueWatcherService,
  type IssueWatcherService,
  type IssueWatcherServiceDependencies,
} from './issue-watcher-service.js';
export {
  type IssueClient,
  type WatchedIssueCandidate,
  createIssueClient,
  parseAcceptanceCriteria,
  stripHtml,
} from './issue-client.js';
