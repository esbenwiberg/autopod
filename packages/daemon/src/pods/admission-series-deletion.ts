import { AutopodError } from '@autopod/shared';
import type { AdmissionSeriesCalls, AdmissionSeriesCaptured } from './admission-contracts.js';
import { canKill } from './state-machine.js';
export function createAdmissionSeriesDeletion(captured: AdmissionSeriesCaptured) {
  const { podRepo, logger } = captured;
  async function deleteSeriesWithCascade(
    this: AdmissionSeriesCalls,
    seriesId: string,
  ): Promise<void> {
    const seriesPods = podRepo.getPodsBySeries(seriesId);
    if (seriesPods.length === 0) {
      throw new AutopodError(`Series ${seriesId} not found`, 'NOT_FOUND', 404);
    }
    for (const pod of seriesPods) {
      if (canKill(pod.status)) {
        await this.killSession(pod.id).catch((err) =>
          logger.warn({ err, podId: pod.id, seriesId }, 'Series delete: kill failed, continuing'),
        );
      }
      await this.deleteSession(pod.id).catch((err) =>
        logger.warn({ err, podId: pod.id, seriesId }, 'Series delete: delete failed, continuing'),
      );
    }
    logger.info({ seriesId, count: seriesPods.length }, 'Series deleted');
  }
  return { deleteSeriesWithCascade };
}
