import type { RuntimeType } from '@autopod/shared';
import { z } from 'zod';

/** Operator-supplied acceptance record; never accepted from a launch or configuration payload. */
export const nativeGoalEvidenceSchema = z
  .object({
    runtime: z.enum(['codex', 'claude']),
    runtimeVersion: z.string().min(1),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    backend: z.enum(['local', 'sandbox']),
    providerId: z.string().min(1),
    observedAt: z.string().datetime(),
    evidenceId: z.string().min(1),
    checks: z
      .object({
        start: z.literal(true),
        continuation: z.literal(true),
        terminalEvidence: z.literal(true),
        cancellation: z.literal(true),
        resume: z.literal(true),
        daemonRecovery: z.literal(true),
        usageIncludingEvaluator: z.literal(true),
        confirmedTermination: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type NativeGoalEvidence = z.infer<typeof nativeGoalEvidenceSchema>;
export interface NativeGoalCapabilityIdentity {
  runtime: RuntimeType;
  runtimeVersion: string;
  imageDigest: string;
  backend: 'local' | 'sandbox';
  providerId: string;
}
export function nativeGoalCapability(
  identity: NativeGoalCapabilityIdentity,
  evidence: readonly unknown[],
  managed = false,
): { available: true; evidenceId: string } | { available: false; reason: string } {
  if (managed)
    return {
      available: false,
      reason: 'Managed pods do not support Goals in the current Dispatcher contract',
    };
  if (identity.runtime !== 'codex' && identity.runtime !== 'claude')
    return { available: false, reason: `Native Goals are not implemented for ${identity.runtime}` };
  if (identity.runtime === 'claude')
    return {
      available: false,
      reason: 'Claude native Goal lifecycle and evaluator usage recovery are not implemented',
    };
  if (identity.backend !== 'local')
    return {
      available: false,
      reason:
        'This backend cannot yet recover the exact native Goal process after a daemon restart',
    };
  for (const raw of evidence) {
    const parsed = nativeGoalEvidenceSchema.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    if (
      item.runtime === identity.runtime &&
      item.runtimeVersion === identity.runtimeVersion &&
      item.imageDigest === identity.imageDigest &&
      item.backend === identity.backend &&
      item.providerId === identity.providerId
    )
      return { available: true, evidenceId: item.evidenceId };
  }
  return {
    available: false,
    reason:
      'Native Goal start, continuation, recovery, termination and complete usage telemetry have not been verified for this runtime image and provider',
  };
}
