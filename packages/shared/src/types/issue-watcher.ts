export type WatchedIssueStatus = 'in_progress' | 'done' | 'failed';
export type WatchedIssuePhase = 'planning' | 'working';

export interface WatchedIssue {
  id: number;
  profileName: string;
  provider: 'github' | 'ado';
  issueId: string;
  issueUrl: string;
  issueTitle: string;
  status: WatchedIssueStatus;
  podId: string | null;
  phase: WatchedIssuePhase;
  triggerLabel: string;
  createdAt: string;
  updatedAt: string;
}
