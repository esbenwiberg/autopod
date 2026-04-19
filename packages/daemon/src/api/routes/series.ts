import { type AcDefinition, AutopodError, generateId } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { PodManager } from '../../pods/index.js';

interface ParsedBrief {
  title: string;
  task: string;
  dependsOn: string[];
  acceptanceCriteria?: AcDefinition[];
}

interface CreateSeriesRequest {
  seriesName: string;
  briefs: ParsedBrief[];
  profile: string;
  baseBranch?: string;
  prMode?: 'single' | 'stacked' | 'none';
}

export function seriesRoutes(app: FastifyInstance, podManager: PodManager): void {
  // POST /pods/series — create a series of pods from parsed briefs
  app.post('/pods/series', async (request, reply) => {
    const body = request.body as CreateSeriesRequest;

    if (!body.seriesName || !body.briefs || body.briefs.length === 0 || !body.profile) {
      reply.status(400);
      return { error: 'seriesName, briefs, and profile are required' };
    }

    const seriesId = generateId(12);
    const prMode = body.prMode ?? 'single';
    const userId = request.user.oid;

    // Resolve brief title → pod ID in creation order (topological).
    // Briefs must be ordered such that each brief's dependsOn references only
    // earlier briefs (numeric-prefix ordering from ap series create guarantees this).
    const titleToId = new Map<string, string>();
    const created: Array<{ title: string; pod: ReturnType<(typeof podManager)['createSession']> }> =
      [];

    for (let i = 0; i < body.briefs.length; i++) {
      const brief = body.briefs[i];
      if (!brief) continue;
      const isLast = i === body.briefs.length - 1;

      // Use the last listed dependency as the immediate predecessor (linear chain model)
      const dependsOnTitle = brief.dependsOn[brief.dependsOn.length - 1];
      const dependsOnPodId = dependsOnTitle ? (titleToId.get(dependsOnTitle) ?? null) : null;

      const output: 'branch' | 'pr' =
        prMode === 'stacked' ? 'pr' : prMode === 'single' && isLast ? 'pr' : 'branch';

      try {
        const pod = podManager.createSession(
          {
            profileName: body.profile,
            task: brief.task,
            baseBranch: dependsOnPodId ? undefined : (body.baseBranch ?? undefined),
            dependsOnPodId: dependsOnPodId ?? undefined,
            seriesId,
            seriesName: body.seriesName,
            acceptanceCriteria: brief.acceptanceCriteria,
            options: { output },
          },
          userId,
        );
        titleToId.set(brief.title, pod.id);
        created.push({ title: brief.title, pod });
      } catch (err) {
        if (err instanceof AutopodError) {
          reply.status(err.statusCode ?? 400);
          return { error: err.message };
        }
        throw err;
      }
    }

    reply.status(201);
    return {
      seriesId,
      seriesName: body.seriesName,
      pods: created.map(({ title, pod }) => ({ title, ...pod })),
    };
  });

  // GET /pods/series/:seriesId — all pods in a series with cost roll-up
  app.get('/pods/series/:seriesId', async (request, reply) => {
    const { seriesId } = request.params as { seriesId: string };
    const pods = podManager.getSeriesPods(seriesId);

    if (pods.length === 0) {
      reply.status(404);
      return { error: 'Series not found' };
    }

    const tokenUsageSummary = {
      inputTokens: pods.reduce((sum, p) => sum + p.inputTokens, 0),
      outputTokens: pods.reduce((sum, p) => sum + p.outputTokens, 0),
      costUsd: Number(pods.reduce((sum, p) => sum + p.costUsd, 0).toFixed(4)),
    };

    const statusCounts = pods.reduce(
      (acc, p) => {
        acc[p.status] = (acc[p.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      seriesId,
      seriesName: pods[0]?.seriesName ?? seriesId,
      pods,
      tokenUsageSummary,
      statusCounts,
    };
  });
}
