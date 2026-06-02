export interface ScheduledJobTemplate {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledJobTemplateRequest {
  name: string;
  prompt: string;
}

export interface UpdateScheduledJobTemplateRequest {
  name?: string;
  prompt?: string;
}

export interface ScheduledJob {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
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
  templateId?: string;
  name?: string; // legacy: creates a template when templateId is omitted
  profileName: string;
  task?: string; // legacy: creates a template when templateId is omitted
  cronExpression: string; // 5-field standard cron: "0 9 * * 1"
  enabled?: boolean; // default true
}

export interface UpdateScheduledJobRequest {
  templateId?: string;
  name?: string;
  task?: string;
  profileName?: string;
  cronExpression?: string;
  enabled?: boolean;
}
