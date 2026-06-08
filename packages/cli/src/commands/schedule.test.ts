import type {
  CreateScheduledJobRequest,
  CreateScheduledJobTemplateRequest,
  ScheduledJob,
  ScheduledJobTemplate,
} from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerScheduleCommands } from './schedule.js';

function createProgram(client: Partial<AutopodClient>): Command {
  const program = new Command();
  program.exitOverride();
  registerScheduleCommands(program, () => client as AutopodClient);
  return program;
}

describe('schedule command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes template field definitions when creating a template', async () => {
    const createScheduledJobTemplate = vi.fn(
      async (req: CreateScheduledJobTemplateRequest): Promise<ScheduledJobTemplate> => ({
        id: 'tmpl-123',
        name: req.name,
        prompt: req.prompt,
        fields: req.fields ?? [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const program = createProgram({ createScheduledJobTemplate });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node',
      'ap',
      'schedule',
      'template',
      'create',
      'Branch review',
      'Review {{branch}}',
      '--fields',
      '[{"key":"branch","label":"Branch","required":true}]',
    ]);

    expect(createScheduledJobTemplate).toHaveBeenCalledWith({
      name: 'Branch review',
      prompt: 'Review {{branch}}',
      fields: [{ key: 'branch', label: 'Branch', required: true }],
    });
  });

  it('passes override values when creating a template-based job', async () => {
    const listScheduledJobTemplates = vi.fn(
      async (): Promise<ScheduledJobTemplate[]> => [
        { id: 'tmpl-123', name: 'Branch review', prompt: 'Review {{branch}}', fields: [] },
      ],
    );
    const createScheduledJob = vi.fn(
      async (req: CreateScheduledJobRequest): Promise<ScheduledJob> => ({
        id: 'job-123',
        name: 'Branch review',
        templateId: req.templateId ?? 'tmpl-123',
        templateName: 'Branch review',
        profileName: req.profileName,
        task: 'Review main',
        fieldValues: req.fieldValues ?? {},
        cronExpression: req.cronExpression,
        enabled: req.enabled ?? true,
        nextRunAt: '2026-01-01T00:00:00.000Z',
        lastRunAt: null,
        lastPodId: null,
        catchupPending: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const program = createProgram({ listScheduledJobTemplates, createScheduledJob });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node',
      'ap',
      'schedule',
      'create',
      'test-profile',
      '0 9 * * 1',
      '--template',
      'Branch review',
      '--set',
      'branch=main',
    ]);

    expect(createScheduledJob).toHaveBeenCalledWith({
      profileName: 'test-profile',
      templateId: 'tmpl-123',
      fieldValues: { branch: 'main' },
      cronExpression: '0 9 * * 1',
      enabled: true,
    });
  });
});
