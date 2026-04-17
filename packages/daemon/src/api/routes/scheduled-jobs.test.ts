import { AutopodError } from '@autopod/shared';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledJobManager } from '../../scheduled-jobs/scheduled-job-manager.js';
import { errorHandler } from '../error-handler.js';
import { scheduledJobRoutes } from './scheduled-jobs.js';

const mockJob = {
  id: 'job-123',
  name: 'Test Job',
  profileName: 'my-profile',
  task: 'Run the task',
  cronExpression: '0 9 * * 1',
  enabled: true,
  nextRunAt: '2025-04-21T09:00:00.000Z',
  lastRunAt: null,
  lastPodId: null,
  catchupPending: false,
  createdAt: '2025-04-14T00:00:00.000Z',
  updatedAt: '2025-04-14T00:00:00.000Z',
};

const mockSession = {
  id: 'sess-xyz',
  profileName: 'my-profile',
  task: 'Run the task',
  status: 'queued',
  model: 'opus',
  runtime: 'claude',
  executionTarget: 'local',
  branch: 'autopod/sess-xyz',
  scheduledJobId: 'job-123',
};

function createMockScheduledJobManager(
  overrides: Partial<ScheduledJobManager> = {},
): ScheduledJobManager {
  return {
    create: vi.fn(() => mockJob),
    list: vi.fn(() => [mockJob]),
    get: vi.fn(() => mockJob),
    update: vi.fn(() => mockJob),
    delete: vi.fn(() => {}),
    runCatchup: vi.fn(async () => mockSession as never),
    skipCatchup: vi.fn(() => {}),
    trigger: vi.fn(async () => mockSession as never),
    reconcileMissedJobs: vi.fn(),
    tick: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('scheduled-jobs routes', () => {
  let app: FastifyInstance;
  let manager: ScheduledJobManager;

  beforeEach(async () => {
    manager = createMockScheduledJobManager();
    app = Fastify();
    app.setErrorHandler(errorHandler);
    scheduledJobRoutes(app, manager);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /scheduled-jobs', () => {
    it('returns 201 with created job', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/scheduled-jobs',
        payload: {
          name: 'Test Job',
          profileName: 'my-profile',
          task: 'Run the task',
          cronExpression: '0 9 * * 1',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: 'job-123' });
    });

    it('returns 400 for missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/scheduled-jobs',
        payload: { name: 'Missing fields' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid cron from manager', async () => {
      vi.mocked(manager.create).mockImplementationOnce(() => {
        throw new AutopodError('Invalid cron', 'INVALID_INPUT', 400);
      });

      const res = await app.inject({
        method: 'POST',
        url: '/scheduled-jobs',
        payload: {
          name: 'Bad Job',
          profileName: 'my-profile',
          task: 'task',
          cronExpression: 'bad-cron',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /scheduled-jobs', () => {
    it('returns array of jobs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/scheduled-jobs',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([mockJob]);
    });
  });

  describe('GET /scheduled-jobs/:id', () => {
    it('returns 200 with job', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/scheduled-jobs/job-123',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 'job-123' });
    });

    it('returns 404 for unknown job', async () => {
      vi.mocked(manager.get).mockImplementationOnce(() => {
        throw new AutopodError('Not found', 'NOT_FOUND', 404);
      });

      const res = await app.inject({
        method: 'GET',
        url: '/scheduled-jobs/no-such-job',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /scheduled-jobs/:id', () => {
    it('returns 200 with updated job', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/scheduled-jobs/job-123',
        payload: { name: 'Updated' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 'job-123' });
    });

    it('returns 400 for invalid cron from manager', async () => {
      vi.mocked(manager.update).mockImplementationOnce(() => {
        throw new AutopodError('Invalid cron', 'INVALID_INPUT', 400);
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/scheduled-jobs/job-123',
        payload: { cronExpression: 'bad-cron' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /scheduled-jobs/:id', () => {
    it('returns 204', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/scheduled-jobs/job-123',
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /scheduled-jobs/:id/catchup', () => {
    it('returns 201 with pod', async () => {
      vi.mocked(manager.runCatchup).mockResolvedValueOnce(mockSession as never);

      const res = await app.inject({
        method: 'POST',
        url: '/scheduled-jobs/job-123/catchup',
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: 'sess-xyz' });
    });

    it('returns 409 when catchupPending is false', async () => {
      vi.mocked(manager.runCatchup).mockRejectedValueOnce(
        new AutopodError('No catchup pending', 'CONFLICT', 409),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/scheduled-jobs/job-123/catchup',
      });

      expect(res.statusCode).toBe(409);
    });

    it('returns 400 when active pod exists', async () => {
      vi.mocked(manager.runCatchup).mockRejectedValueOnce(
        new AutopodError('Active pod', 'ACTIVE_SESSION', 400),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/scheduled-jobs/job-123/catchup',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /scheduled-jobs/:id/catchup', () => {
    it('returns 204', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/scheduled-jobs/job-123/catchup',
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /scheduled-jobs/:id/trigger', () => {
    it('returns 201 with pod', async () => {
      vi.mocked(manager.trigger).mockResolvedValueOnce(mockSession as never);

      const res = await app.inject({
        method: 'POST',
        url: '/scheduled-jobs/job-123/trigger',
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: 'sess-xyz' });
    });
  });
});
