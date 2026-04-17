export type WatchedIssueStatus = 'in_progress' | 'done' | 'failed';

export interface WatchedIssue {
  id: number;
  profileName: string;
  provider: 'github' | 'ado';
  issueId: string;
  issueUrl: string;
  issueTitle: string;
  status: WatchedIssueStatus;
  podId: string | null;
  triggerLabel: string;
  createdAt: string;
  updatedAt: string;
}
