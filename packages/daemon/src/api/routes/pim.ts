import type { PimSelection } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configurationError } from '../../configuration/configuration-store.js';
import type { createPimActivationService } from '../../pim/activation-service.js';
import type { PimEligibilityService } from '../../pim/eligibility-service.js';

export interface PimRouteDependencies {
  eligibility: PimEligibilityService;
  activation: ReturnType<typeof createPimActivationService>;
  /** Returns the frozen selection and a current policy/ownership recheck; cannot widen a managed grant. */
  scope(
    podId: string,
    userId: string,
  ): { selections: PimSelection[]; assertAuthorized(selection: PimSelection): void };
}
export function pimRoutes(app: FastifyInstance, deps: PimRouteDependencies): void {
  app.get('/pim/eligibility', async (request) => {
    // Discovery is cached server-side; `fresh=1` is the explicit user-driven refresh.
    const { fresh } = z
      .object({ fresh: z.enum(['0', '1', 'true', 'false']).optional() })
      .parse(request.query);
    return deps.eligibility.discover(fresh === '1' || fresh === 'true');
  });
  app.post('/pods/:id/pim/activate', async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = z
      .object({
        type: z.enum(['group', 'azure-role', 'directory-role']),
        eligibilityId: z.string().min(1),
        requestId: z.string().min(1).max(128),
      })
      .strict()
      .parse(request.body);
    const scope = deps.scope(id, request.user.oid);
    const matches = scope.selections.filter(
      (selection) =>
        selection.type === input.type && selection.eligibilityId === input.eligibilityId,
    );
    const selected = matches[0];
    if (!selected || matches.length !== 1)
      configurationError(
        'This exact PIM assignment was not selected for the pod',
        'PIM_NOT_SELECTED',
        403,
      );
    return deps.activation.request(id, input.requestId, selected, () =>
      scope.assertAuthorized(selected),
    );
  });
}
