import { createServer } from 'node:http';
import type {
  CreateScheduledJobRequest,
  CreateScheduledJobTemplateRequest,
  ScheduledJob,
  ScheduledJobTemplate,
} from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutopodClient } from '../api/client.js';
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

  it('reads report history pages over HTTP and forwards the explicit continuation cursor', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [], nextCursor: null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const client = new AutopodClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      getToken: async () => 'fixture',
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await createProgram(client).parseAsync([
        'node',
        'ap',
        'schedule',
        'report-page',
        'job',
        '--before',
        'cursor',
      ]);
      expect(requests).toEqual(['/scheduled-jobs/job/report-page?before=cursor']);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
        items: [],
        nextCursor: null,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

it('runs scan create, report review, human triage and explicit repair through the real HTTP CLI client', async () => {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const report = {
    kind: 'scan_report',
    id: 'report-fixture',
    status: 'incomplete',
    collection: { scanners: [{ scanner: 'dependencies', status: 'failed', findingCount: null }] },
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const parsed = body ? JSON.parse(body) : {};
    requests.push({ method: req.method ?? '', path: req.url ?? '', body: parsed });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/scheduled-jobs')
      res.end(JSON.stringify({ id: 'job-fixture', enabled: false }));
    else if (req.url?.endsWith('/trigger')) res.end(JSON.stringify(report));
    else if (req.url?.endsWith('/triage'))
      res.end(JSON.stringify({ id: 'selection-fixture', ...parsed }));
    else if (req.url?.endsWith('/repairs'))
      res.end(
        JSON.stringify({
          kind: 'repair_dispatch',
          selectionId: parsed.selectionId,
          podId: 'repair-fixture',
        }),
      );
    else
      res.end(JSON.stringify({ report, unresolved: [{ id: 'finding-fixture' }], decisions: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const client = new AutopodClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getToken: async () => 'synthetic',
  });
  const logs: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => {
    logs.push(String(value));
  });
  const run = (args: string[]) =>
    createProgram(client).parseAsync(['node', 'ap', 'schedule', ...args]);
  try {
    await run([
      'scan-create',
      'profile',
      'Report fixture',
      '0 8 * * *',
      '--base',
      'main',
      '--head',
      'work',
      '--disabled',
    ]);
    expect(requests[0]?.body).toMatchObject({
      enabled: false,
      scan: {
        version: 1,
        baseRef: 'main',
        headRef: 'work',
        judgment: 'none',
        scanners: ['secrets', 'dependencies'],
      },
    });
    await run(['run', 'job-fixture']);
    expect(logs.join('\n')).toContain(
      'Report report-fixture: incomplete. No repair worker was launched.',
    );
    await run(['report', 'report-fixture']);
    expect(logs.join('\n')).toContain('"findingCount": null');
    const triage = [
      'triage',
      'report-fixture',
      '--finding',
      'finding-fixture',
      '--action',
      'select_repair',
      '--reason',
      'Repair selected finding',
      '--request-key',
      'retained-cli-intent',
    ];
    await run(triage);
    await run(triage);
    const writes = requests.filter((request) => request.path.endsWith('/triage'));
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toEqual(writes[1]?.body);
    expect(requests.some((request) => request.path.endsWith('/repairs'))).toBe(false);
    await run(['repair', 'report-fixture', 'selection-fixture']);
    expect(requests.at(-1)?.body).toEqual({ selectionId: 'selection-fixture' });
    expect(logs.join('\n')).toContain('not patch delivery');
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('passes an explicit time window and rejects a wider two-branch window before HTTP dispatch', async () => {
  const updateScheduledJob = vi.fn(async () => ({ id: 'job' }) as ScheduledJob);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await createProgram({ updateScheduledJob }).parseAsync([
      'node',
      'ap',
      'schedule',
      'scan-configure',
      'job',
      '--base',
      'main',
      '--head',
      'main',
      '--window-hours',
      '24',
    ]);
    expect(updateScheduledJob).toHaveBeenCalledWith('job', {
      scan: expect.objectContaining({ windowHours: 24, baseRef: 'main', headRef: 'main' }),
    });
    await expect(
      createProgram({ updateScheduledJob }).parseAsync([
        'node',
        'ap',
        'schedule',
        'scan-configure',
        'job',
        '--base',
        'main',
        '--head',
        'different',
        '--window-hours',
        '24',
      ]),
    ).rejects.toThrow('must match');
    expect(updateScheduledJob).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});
