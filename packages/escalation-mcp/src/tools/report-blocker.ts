import type { EscalationRequest, PrerequisiteBlockerV1 } from '@autopod/shared';
import { generateId, prerequisiteBlockerV1Schema } from '@autopod/shared';
import { z } from 'zod';
import type { PendingRequests } from '../pending-requests.js';
import type { PodBridge } from '../pod-bridge.js';

export interface ReportBlockerInput {
  description: string;
  attempted: string[];
  needs: string;
  owner?: 'autopod' | 'parent' | 'validation';
  phase?: string;
  prerequisiteBlocker?: PrerequisiteBlockerV1;
  deferral?: { check: string; expectedExecutor: string; requiredFactId?: string };
}

const reportBlockerInputSchema = z
  .object({
    description: z.string().trim().min(1).max(10000),
    attempted: z.array(z.string().max(4000)).max(50),
    needs: z.string().trim().min(1).max(10000),
    owner: z.enum(['autopod', 'parent', 'validation']).optional(),
    phase: z.string().trim().min(1).max(256).optional(),
    prerequisiteBlocker: prerequisiteBlockerV1Schema.optional(),
    deferral: z
      .object({
        check: z.string().trim().min(1).max(4000),
        expectedExecutor: z.string().trim().min(1).max(256),
        requiredFactId: z.string().trim().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.prerequisiteBlocker || Boolean(value.phase),
    'Typed prerequisite reports require an explicit failing phase',
  )
  .refine(
    (value) => !value.deferral || !value.prerequisiteBlocker,
    'External deferrals cannot claim missing execution prerequisites',
  );

export async function reportBlocker(
  podId: string,
  input: ReportBlockerInput,
  bridge: PodBridge,
  _pendingRequests: PendingRequests,
): Promise<string> {
  input = reportBlockerInputSchema.parse(input);
  const escalationId = generateId();
  const escalation: EscalationRequest = {
    id: escalationId,
    podId,
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    payload: {
      kind: input.deferral ? 'expected-external-deferral' : 'infrastructure',
      owner: input.owner ?? 'autopod',
      phase: input.phase,
      requiresResponse: false,
      description: input.description,
      attempted: input.attempted,
      needs: input.needs,
      ...(input.deferral ? { deferral: input.deferral } : {}),
      ...(input.prerequisiteBlocker ? { prerequisiteBlocker: input.prerequisiteBlocker } : {}),
    },
    response: null,
  };

  bridge.createEscalation(escalation);
  bridge.incrementEscalationCount(podId);

  if (input.deferral)
    return `Expected external check recorded as NOT RUN: ${input.deferral.check}. This claim is not proof or a gate waiver; also record it in report_task_summary.deferredChecks.`;
  return `Infrastructure blocker recorded: ${input.description}. No human answer is requested. Stop blocked attempts; preserve work and report incomplete checks in report_task_summary, then finish. Autopod will hold completion after execution settles. This report is not a validation receipt, permission, or gate waiver.`;
}
