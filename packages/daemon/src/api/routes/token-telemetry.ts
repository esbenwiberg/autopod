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
