import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TokenTelemetryRepair } from '../../pods/token-telemetry-repair.js';

const repairRequestSchema = z.object({
  apply: z.boolean().optional().default(false),
  confirmation: z.string().optional(),
});

export function tokenTelemetryRoutes(app: FastifyInstance, repair: TokenTelemetryRepair): void {
  let running = false;
  const nativeRequest = z
    .object({
      expectedBinding: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string().trim().min(10).max(4000),
    })
    .strict();
  const operator = (roles: string[]) => {
    if (!roles.includes('admin') && !roles.includes('operator'))
      throw new AutopodError('Admin or operator role required', 'FORBIDDEN', 403);
  };
  app.get<{ Params: { podId: string } }>('/pods/:podId/claude-telemetry', async (request) => {
    operator(request.user.roles);
    if (!repair.claudeSession)
      throw new AutopodError('Native repair unavailable', 'NOT_SUPPORTED', 409);
    return repair.claudeSession.inspect(request.params.podId);
  });
  app.post<{ Params: { podId: string } }>('/pods/:podId/claude-telemetry', async (request) => {
    operator(request.user.roles);
    const parsed = nativeRequest.safeParse(request.body);
    if (!parsed.success)
      throw new AutopodError(
        'Exact preview binding and reason required',
        'INVALID_REPAIR_REQUEST',
        400,
      );
    if (!request.user.oid?.trim())
      throw new AutopodError('Authenticated operator required', 'FORBIDDEN', 403);
    if (!repair.claudeSession)
      throw new AutopodError('Native repair unavailable', 'NOT_SUPPORTED', 409);
    if (running)
      throw new AutopodError('A token telemetry repair is already running', 'REPAIR_RUNNING', 409);
    running = true;
    try {
      return await repair.claudeSession.apply(request.params.podId, parsed.data, request.user.oid);
    } finally {
      running = false;
    }
  });

  app.post('/admin/token-telemetry/repair', async (request) => {
    if (!request.user.roles.includes('admin') && !request.user.roles.includes('operator')) {
      throw new AutopodError('Admin or operator role required', 'FORBIDDEN', 403);
    }
    const parsed = repairRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AutopodError(parsed.error.message, 'INVALID_REPAIR_REQUEST', 400);
    }
    if (parsed.data.apply && parsed.data.confirmation !== 'APPLY_TOKEN_TELEMETRY_REPAIR') {
      throw new AutopodError(
        'Apply mode requires confirmation APPLY_TOKEN_TELEMETRY_REPAIR',
        'REPAIR_CONFIRMATION_REQUIRED',
        400,
      );
    }
    if (running) {
      throw new AutopodError('A token telemetry repair is already running', 'REPAIR_RUNNING', 409);
    }
    running = true;
    try {
      return await repair.run({ apply: parsed.data.apply });
    } finally {
      running = false;
    }
  });
}
