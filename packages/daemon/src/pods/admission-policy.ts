import type { Pod, ValidationOverride } from '@autopod/shared';
import type { Logger } from 'pino';
export function warnIfSinglePrSeriesMissingSeriesMeta(pod: Pod, logger: Logger): void {
  if (pod.prMode !== 'single' || !pod.seriesId) return;
  if (pod.seriesDescription && pod.seriesName) return;
  logger.warn(
    {
      podId: pod.id,
      seriesId: pod.seriesId,
      hasSeriesDescription: Boolean(pod.seriesDescription),
      hasSeriesName: Boolean(pod.seriesName),
    },
    'Single-PR series pod is missing seriesName or seriesDescription — PR title and "Why" will fall back to the brief task. Verify the client forwarded purpose.md when creating the series.',
  );
}

export function mergeOverrides(
  existing: ValidationOverride[],
  incoming: ValidationOverride[],
): ValidationOverride[] {
  const map = new Map<string, ValidationOverride>();
  for (const o of existing) map.set(o.findingId, o);
  for (const o of incoming) map.set(o.findingId, o);
  return [...map.values()];
}
