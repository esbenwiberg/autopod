import type { Logger } from 'pino';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { CreatePrResult } from '../interfaces/pr-manager.js';

const MAX_ACTIVITY_DETAIL_LENGTH = 240;

/**
 * Pod activity line for a PR whose title and/or body used the template
 * fallback. Includes the stable reason and the generator's bounded,
 * secret-redacted detail (provider, route, status…) so the failure is
 * diagnosable from the pod status without the daemon log.
 */
export function formatPrFallbackActivity(result: CreatePrResult): string | null {
  if (!result.usedFallback) return null;
  const which = result.narrativeUsedFallback
    ? result.titleUsedFallback
      ? 'title + body'
      : 'body'
    : 'title';
  const reason = result.fallbackReason ?? 'unknown';
  const detail = (result.fallbackDetail ?? '').replace(/\s+/g, ' ').trim();
  const bounded =
    detail.length > MAX_ACTIVITY_DETAIL_LENGTH
      ? `${detail.slice(0, MAX_ACTIVITY_DETAIL_LENGTH - 1)}…`
      : detail;
  return `PR ${which} used template fallback: ${reason}${bounded ? ` (${bounded})` : ''}`;
}

/** Log and emit a PR description template fallback, if one occurred. */
export function reportPrDescriptionFallback(input: {
  result: CreatePrResult;
  podId: string;
  /** Delivery path, e.g. `validation`, `revalidation`, `approval_retry`. */
  context: string;
  profile: Pick<PodExecutionSettings, 'name' | 'modelProvider'>;
  logger: Logger;
  emitActivityStatus: (podId: string, message: string) => void;
}): void {
  const { result, podId, context, profile, logger, emitActivityStatus } = input;
  const message = formatPrFallbackActivity(result);
  if (!message) return;
  logger.error(
    {
      podId,
      context,
      profile: profile.name,
      modelProvider: profile.modelProvider,
      fallbackReason: result.fallbackReason ?? 'unknown',
      fallbackDetail: result.fallbackDetail,
      titleUsedFallback: result.titleUsedFallback,
      narrativeUsedFallback: result.narrativeUsedFallback,
    },
    'PR description used template fallback — daemon-side LLM helper failed',
  );
  emitActivityStatus(podId, message);
}
