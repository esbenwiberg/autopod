import type { Logger } from 'pino';
import type { AdaptiveCard } from './card-builder.js';

export interface TeamsAdapter {
  send(card: AdaptiveCard): Promise<boolean>;
}

export function createTeamsAdapter(webhookUrl: string, logger: Logger): TeamsAdapter {
  return {
    async send(card: AdaptiveCard): Promise<boolean> {
      const envelope = {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: card,
          },
        ],
      };

      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          logger.warn(
            { status: response.status, statusText: response.statusText },
            'Teams webhook returned non-OK status',
          );
          return false;
        }

        return true;
      } catch (err) {
        logger.warn({ err }, 'Failed to send Teams notification');
        return false;
      }
    },
  };
}
