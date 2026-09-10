import type { ScheduledScanPolicy } from './scheduled-scan.js';
export interface ScheduledJobTemplateField {
  key: string;
  label: string;
  required: boolean;
  defaultValue?: string;
}

export interface ScheduledJobTemplate {
  id: string;
  name: string;
  prompt: string;
  fields: ScheduledJobTemplateField[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledJobTemplateRequest {
  name: string;
  prompt: string;
  fields?: ScheduledJobTemplateField[];
}

export interface UpdateScheduledJobTemplateRequest {
  name?: string;
  prompt?: string;
  fields?: ScheduledJobTemplateField[];
}

export interface ScheduledJob {
  scan?: ScheduledScanPolicy | null;
  lastReportId?: string | null;
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  profileName: string;
  task: string;
  fieldValues: Record<string, string>;
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
  scan?: ScheduledScanPolicy | null;
  templateId?: string;
  name?: string; // legacy: creates a template when templateId is omitted
  profileName: string;
  task?: string; // legacy: creates a template when templateId is omitted
  fieldValues?: Record<string, string>;
  cronExpression: string; // 5-field standard cron: "0 9 * * 1"
  enabled?: boolean; // default true
}

export interface UpdateScheduledJobRequest {
  scan?: ScheduledScanPolicy | null;
  templateId?: string;
  name?: string;
  task?: string;
  fieldValues?: Record<string, string>;
  profileName?: string;
  cronExpression?: string;
  enabled?: boolean;
}
