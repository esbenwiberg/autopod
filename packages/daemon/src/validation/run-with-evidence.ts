import type { ValidationInputIdentity } from '@autopod/shared';
import {
  type ReusableValidationStage,
  type ReusedPhaseResult,
  type ValidationEvidenceCache,
  validationIdentityHash,
} from './validation-evidence-cache.js';

/** Capture on both sides: a mutating check must never seed evidence for its input tree. */
export async function runWithValidationEvidence<T extends { status: string; duration: number }>(
  podId: string,
  stage: ReusableValidationStage,
  run: () => Promise<T>,
  cache?: ValidationEvidenceCache,
  capture?: () => Promise<ValidationInputIdentity | undefined>,
): Promise<T | ReusedPhaseResult> {
  if (!cache || !capture) return run();
  const read = () => capture().catch(() => undefined);
  const before = await read();
  const hash = validationIdentityHash(before);
  if (!hash) return run();
  let previous: ReusedPhaseResult | null = null;
  try {
    previous = cache.get(stage, before);
  } catch {
    /* Cache availability cannot suppress validation. */
  }
  if (previous && validationIdentityHash(await read()) === hash) return previous;
  const result = await run();
  if (validationIdentityHash(await read()) === hash) {
    try {
      cache.record(podId, stage, before, result);
    } catch {
      /* The executed result remains authoritative. */
    }
  }
  return result;
}
