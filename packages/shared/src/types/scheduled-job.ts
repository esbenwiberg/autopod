export interface ScheduledJob {
  id: string;
  name: string;
  profileName: string;
  task: string;
  cronExpression: string;
  enabled: boolean;
  nextRunAt: string; // ISO 8601
  lastRunAt: string | null;
  lastPodId: string | null;
  catchupPending: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledJobRequest {
  name: string;
  profileName: string;
  task: string;
  cronExpression: string; // 5-field standard cron: "0 9 * * 1"
  enabled?: boolean; // default true
}

export interface UpdateScheduledJobRequest {
  name?: string;
  task?: string;
  cronExpression?: string;
  enabled?: boolean;
}
